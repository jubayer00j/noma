import { Capacitor, registerPlugin } from "@capacitor/core";
import { googleDriveClientId } from "../firebase";
import { buildBackupZip, readBackupZip, recordBackup, type BackupPayload } from "./backup";
import type { BackupManifest } from "./types";

/** Narrowest scope that still lets Noma manage only the files it creates. */
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_NAME = "Noma Backups";
export const CANONICAL_BACKUP_NAME = "Noma Backup.zip";
const STATE_KEY = "noma.drive.connection";

export const isDriveConfigured = Boolean(googleDriveClientId);

export interface DriveConnection {
  email: string | null;
  connectedAt: number;
  lastBackupAt: number | null;
  /** Cached so Noma never has to scan the user's Drive. */
  folderId: string | null;
  /** Cached canonical backup file ID in Google Drive. */
  backupFileId: string | null;
  /** Fingerprint of the local library at the last successful backup. */
  lastSignature: string | null;
}

export interface DriveBackupFile {
  id: string;
  name: string;
  modifiedTime: number;
  size: number | null;
}

interface TokenClient {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            prompt?: string;
            callback: (response: {
              access_token?: string;
              error?: string;
              error_description?: string;
            }) => void;
            error_callback?: (error: { type?: string; message?: string }) => void;
          }) => TokenClient;
          revoke: (token: string, done?: () => void) => void;
        };
      };
    };
  }
}

export class DriveError extends Error {
  /** True when the user must re-authorize before Drive works again. */
  needsReconnect: boolean;
  constructor(message: string, needsReconnect = false) {
    super(message);
    this.needsReconnect = needsReconnect;
  }
}

/** Short-lived token, memory only — never persisted, never logged. */
let accessToken: string | null = null;
let activeTokenOwner: string | null | undefined = undefined;
let tokenExpiresAt = 0;

export function backupObjectName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Noma-Backup-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(
    date.getHours(),
  )}-${pad(date.getMinutes())}.zip`;
}

export function getConnection(ownerId: string | null): DriveConnection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ownerId ? `noma-drive-v1-${ownerId}` : "noma-drive-v1");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DriveConnection>;
    return {
      email: parsed.email ?? null,
      connectedAt: parsed.connectedAt ?? Date.now(),
      lastBackupAt: parsed.lastBackupAt ?? null,
      folderId: parsed.folderId ?? null,
      backupFileId: parsed.backupFileId ?? null,
      lastSignature: parsed.lastSignature ?? null,
    };
  } catch {
    return null;
  }
}

function setConnection(
  ownerId: string | null,
  connection: DriveConnection | null,
): DriveConnection | null {
  if (typeof window === "undefined") return connection;
  if (connection)
    window.localStorage.setItem(
      ownerId ? `noma-drive-v1-${ownerId}` : "noma-drive-v1",
      JSON.stringify(connection),
    );
  else window.localStorage.removeItem(ownerId ? `noma-drive-v1-${ownerId}` : "noma-drive-v1");
  return connection;
}

function patchConnection(ownerId: string | null, patch: Partial<DriveConnection>): DriveConnection {
  const base = getConnection(ownerId) ?? {
    email: null,
    connectedAt: Date.now(),
    lastBackupAt: null,
    folderId: null,
    backupFileId: null,
    lastSignature: null,
  };
  return setConnection(ownerId, { ...base, ...patch })!;
}

const DEV = import.meta.env.DEV;
/** Dev-only diagnostics around the OAuth callback + first Drive request. */
function log(...args: unknown[]) {
  if (DEV) console.info("[noma-drive]", ...args);
}

function waitForGis(timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (window.google?.accounts?.oauth2) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(
          new DriveError("Google authorization couldn't start. Reload Noma and try again."),
        );
      }
      window.setTimeout(tick, 100);
    };
    tick();
  });
}

async function loadGis(): Promise<void> {
  if (typeof window === "undefined")
    throw new DriveError("Google Drive is only available in the browser.");
  if (window.google?.accounts?.oauth2) return;
  const existing = document.querySelector<HTMLScriptElement>(
    'script[src="https://accounts.google.com/gsi/client"]',
  );
  if (!existing) {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onerror = () => log("GIS script failed to load");
    document.head.appendChild(script);
  }
  // Polling instead of relying on onload: an already-loaded script never fires
  // onload again, which previously left the connect promise pending forever.
  await waitForGis(15_000);
  log("GIS ready");
}

function authorizeErrorMessage(code?: string, description?: string): string {
  switch (code) {
    case "popup_closed":
    case "user_cancel":
    case "access_denied":
      return "Authorization was cancelled or denied. Google Drive is still not connected.";
    case "popup_failed_to_open":
      return "Your browser blocked the Google window. Allow pop-ups for Noma, then try again.";
    case "idpiframe_initialization_failed":
      return "Google couldn't start authorization in this browser. Try again in a normal browser tab.";
    case "invalid_client":
      return "The Google Drive client ID looks invalid. Check googleDriveClientId in src/config/firebaseConfig.ts.";
    case "invalid_scope":
      return "Google rejected the Drive scope (drive.file). Enable the Google Drive API for this project in Google Cloud.";
    case "unauthorized_client":
    case "origin_mismatch":
    case "redirect_uri_mismatch":
      return `This origin (${typeof window !== "undefined" ? window.location.origin : "this domain"}) isn't authorized for the Google Drive OAuth client. Add it as an authorized JavaScript origin in Google Cloud → Credentials.`;
    default:
      return description
        ? `Google Drive authorization failed: ${description}`
        : "Google Drive authorization wasn't completed. Please try again.";
  }
}

/** Failsafe so the token callback can never leave the UI spinning forever. */
const AUTHORIZE_TIMEOUT_MS = 120_000;

interface NativeGoogleDriveAuthPlugin {
  authorize(): Promise<{ accessToken: string }>;
}

const NativeGoogleDriveAuth = registerPlugin<NativeGoogleDriveAuthPlugin>("GoogleDriveAuth");

async function authorizeNative(ownerId: string | null, prompt?: string): Promise<string> {
  if (!prompt && accessToken && Date.now() < tokenExpiresAt && activeTokenOwner === ownerId) {
    return accessToken;
  }

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new DriveError(
      "You're offline. Noma keeps working locally — reconnect Drive when you're back online.",
    );
  }

  try {
    const result = await NativeGoogleDriveAuth.authorize();
    if (!result.accessToken) {
      throw new DriveError("No access token returned after Google Drive authorization", true);
    }

    accessToken = result.accessToken;
    tokenExpiresAt = Date.now() + 50 * 60 * 1000;
    activeTokenOwner = ownerId;
    return result.accessToken;
  } catch (error) {
    if (error instanceof DriveError) throw error;

    const message = (error as { message?: string; code?: string })?.message || String(error);
    const code = (error as { code?: string })?.code || "";

    if (code === "USER_CANCELLED" || /cancelled|canceled|cancel/i.test(message)) {
      throw new DriveError(
        "Authorization was cancelled or denied. Google Drive is still not connected.",
        true,
      );
    }

    throw new DriveError(`Google Drive authorization failed: ${message}`, true);
  }
}

async function authorizeWeb(ownerId: string | null, prompt?: string): Promise<string> {
  if (!googleDriveClientId) {
    throw new DriveError(
      "Google Drive backup isn't configured yet. Add googleDriveClientId in src/config/firebaseConfig.ts.",
    );
  }
  if (!prompt && accessToken && Date.now() < tokenExpiresAt && activeTokenOwner === ownerId)
    return accessToken;
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new DriveError(
      "You're offline. Noma keeps working locally — reconnect Drive when you're back online.",
    );
  }
  await loadGis();
  const clientId: string = googleDriveClientId;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer = 0;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      fn();
    };
    timer = window.setTimeout(() => {
      log("token callback never fired within timeout");
      finish(() =>
        reject(
          new DriveError(
            "Google never returned an authorization result. If the Google window closed already, try again.",
            true,
          ),
        ),
      );
    }, AUTHORIZE_TIMEOUT_MS);

    let client: TokenClient;
    try {
      client = window.google!.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPE,
        ...(prompt ? { prompt } : {}),
        callback: (response) => {
          log("token callback", {
            hasToken: Boolean(response.access_token),
            error: response.error,
            error_description: response.error_description,
            scope: (response as { scope?: string }).scope,
          });
          if (!response.access_token) {
            finish(() =>
              reject(
                new DriveError(
                  authorizeErrorMessage(response.error, response.error_description),
                  true,
                ),
              ),
            );
            return;
          }
          const granted = (response as { scope?: string }).scope;
          if (granted && !granted.includes("drive.file")) {
            finish(() =>
              reject(
                new DriveError(
                  "Google Drive access wasn't granted. Please allow the Drive permission and try again.",
                  true,
                ),
              ),
            );
            return;
          }
          accessToken = response.access_token;
          tokenExpiresAt = Date.now() + 50 * 60 * 1000;
          activeTokenOwner = ownerId;
          finish(() => resolve(response.access_token!));
        },
        error_callback: (error) => {
          log("token error_callback", error);
          finish(() =>
            reject(new DriveError(authorizeErrorMessage(error.type, error.message), true)),
          );
        },
      });
    } catch (error) {
      log("initTokenClient threw", error);
      finish(() =>
        reject(
          new DriveError("Google authorization couldn't start. Reload Noma and try again.", true),
        ),
      );
      return;
    }

    try {
      client.requestAccessToken(prompt ? { prompt } : undefined);
    } catch (error) {
      log("requestAccessToken threw", error);
      finish(() => reject(new DriveError(authorizeErrorMessage("popup_failed_to_open"), true)));
    }
  });
}

async function authorize(ownerId: string | null, prompt?: string): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    return authorizeNative(ownerId, prompt);
  }
  return authorizeWeb(ownerId, prompt);
}

function googleErrorText(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } | string };
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.error?.message ?? null;
  } catch {
    return body.slice(0, 200) || null;
  }
}

async function driveFetch(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`https://www.googleapis.com/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  } catch (error) {
    log("network error", path, error);
    throw new DriveError("Couldn't reach Google Drive. Check your connection and try again.");
  }
  if (!response.ok) log("drive request failed", path, response.status);
  if (response.status === 401 || response.status === 403) {
    const body = await response.text();
    const detail = googleErrorText(body);
    accessToken = null;
    tokenExpiresAt = 0;
    if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body)) {
      throw new DriveError("Google Drive is rate-limiting Noma right now. Try again in a minute.");
    }
    if (/accessNotConfigured|has not been used|is disabled/i.test(body)) {
      throw new DriveError(
        `The Google Drive API isn't enabled for this Google Cloud project. Enable it, then try again.${detail ? ` (${detail})` : ""}`,
      );
    }
    if (
      response.status === 403 &&
      /insufficient(Permissions|Scope)|ACCESS_TOKEN_SCOPE/i.test(body)
    ) {
      throw new DriveError(
        `Google Drive denied the request for the drive.file scope${detail ? `: ${detail}` : "."}`,
        true,
      );
    }
    throw new DriveError(
      `Google Drive rejected the request (${response.status})${detail ? `: ${detail}` : ""}. Please connect again.`,
      true,
    );
  }
  if (response.status === 429 || response.status >= 500) {
    throw new DriveError(
      "Google Drive is temporarily unavailable. Your notes are safe on this device — try again.",
    );
  }
  if (!response.ok) {
    const detail = googleErrorText(await response.text());
    throw new DriveError(
      `Google Drive couldn't complete that request (${response.status})${detail ? `: ${detail}` : ""}.`,
    );
  }
  return response;
}

/** Finds (or creates once) the dedicated Noma Backups folder and caches its id. */
async function ensureFolder(token: string, ownerId: string | null): Promise<string> {
  const cached = getConnection(ownerId)?.folderId;
  if (cached) {
    try {
      await driveFetch(`drive/v3/files/${cached}?fields=id,trashed`, token);
      return cached;
    } catch (error) {
      if (error instanceof DriveError && error.needsReconnect) throw error;
    }
  }
  const query = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false`,
  );
  const found = (await (
    await driveFetch(`drive/v3/files?q=${query}&fields=files(id)&spaces=drive&pageSize=1`, token)
  ).json()) as { files?: Array<{ id: string }> };
  let folderId = found.files?.[0]?.id ?? null;
  if (!folderId) {
    const created = (await (
      await driveFetch("drive/v3/files?fields=id", token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
      })
    ).json()) as { id: string };
    folderId = created.id;
  }
  patchConnection(ownerId, { folderId });
  return folderId;
}

export async function resolveCanonicalFileId(
  token: string,
  folderId: string,
  ownerId: string | null,
): Promise<string | null> {
  const cachedId = getConnection(ownerId)?.backupFileId;
  if (cachedId) {
    try {
      const res = await driveFetch(
        `drive/v3/files/${cachedId}?fields=id,name,trashed,parents`,
        token,
      );
      const file = (await res.json()) as {
        id?: string;
        name?: string;
        trashed?: boolean;
        parents?: string[];
      };
      const isParentValid = !file.parents || file.parents.includes(folderId);
      if (file.id && !file.trashed && file.name === CANONICAL_BACKUP_NAME && isParentValid) {
        return file.id;
      }
    } catch (error) {
      if (error instanceof DriveError && error.needsReconnect) throw error;
      // Stale cached file ID — clear and proceed to search folder
    }
    patchConnection(ownerId, { backupFileId: null });
  }

  const query = encodeURIComponent(
    `'${folderId}' in parents and name='${CANONICAL_BACKUP_NAME}' and trashed=false`,
  );
  const data = (await (
    await driveFetch(`drive/v3/files?q=${query}&fields=files(id)&spaces=drive&pageSize=1`, token)
  ).json()) as { files?: Array<{ id: string }> };

  const foundId = data.files?.[0]?.id ?? null;
  if (foundId) {
    patchConnection(ownerId, { backupFileId: foundId });
  }
  return foundId;
}

export async function connectDrive(ownerId: string | null): Promise<DriveConnection> {
  const token = await authorize(ownerId, "consent");
  log("access token acquired, verifying with Drive API…");
  // Verification request — the connection is only "connected" once a real
  // authenticated Drive call succeeds, not merely because consent completed.
  const info = await driveFetch("drive/v3/about?fields=user(emailAddress)", token);
  const email =
    ((await info.json()) as { user?: { emailAddress?: string } }).user?.emailAddress ?? null;
  log("Drive API verification ok", { hasEmail: Boolean(email) });
  const folderId = await ensureFolder(token, ownerId);
  log("Noma Backups folder ready", folderId);
  const backupFileId = await resolveCanonicalFileId(token, folderId, ownerId);
  return patchConnection(ownerId, { email, connectedAt: Date.now(), folderId, backupFileId });
}

export async function disconnectDrive(ownerId: string | null): Promise<void> {
  activeTokenOwner = undefined;
  if (
    accessToken &&
    !Capacitor.isNativePlatform() &&
    typeof window !== "undefined" &&
    window.google?.accounts?.oauth2
  ) {
    try {
      window.google.accounts.oauth2.revoke(accessToken);
    } catch {
      /* ignore */
    }
  }
  accessToken = null;
  tokenExpiresAt = 0;
  setConnection(ownerId, null);
}

export async function listDriveBackups(ownerId: string | null): Promise<DriveBackupFile[]> {
  const token = await authorize(ownerId);
  const folderId = await ensureFolder(token, ownerId);
  const query = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const data = (await (
    await driveFetch(
      `drive/v3/files?q=${query}&fields=files(id,name,size,modifiedTime)&orderBy=modifiedTime desc&pageSize=30`,
      token,
    )
  ).json()) as { files?: Array<{ id: string; name: string; size?: string; modifiedTime: string }> };
  const all = (data.files ?? [])
    .filter(
      (file) =>
        file.name === CANONICAL_BACKUP_NAME ||
        (file.name.startsWith("Noma-Backup") && file.name.endsWith(".zip")),
    )
    .map((file) => ({
      id: file.id,
      name: file.name,
      modifiedTime: new Date(file.modifiedTime).getTime(),
      size: file.size ? Number(file.size) : null,
    }));

  const canonical = all.find((f) => f.name === CANONICAL_BACKUP_NAME);
  const legacy = all.filter((f) => f.name !== CANONICAL_BACKUP_NAME);

  return canonical ? [canonical, ...legacy] : legacy;
}

/** In-flight concurrency guard to prevent overlapping backup runs per account. */
const activeBackups = new Map<
  string,
  Promise<{ connection: DriveConnection; manifest: BackupManifest }>
>();

export async function backupNow(
  db: import("./db").NomaDatabase,
  ownerId: string | null,
): Promise<{ connection: DriveConnection; manifest: BackupManifest }> {
  const lockKey = ownerId ?? "guest";
  const existingPromise = activeBackups.get(lockKey);
  if (existingPromise) {
    return existingPromise;
  }

  const backupPromise = (async () => {
    try {
      const token = await authorize(ownerId);
      const folderId = await ensureFolder(token, ownerId);
      const existingFileId = await resolveCanonicalFileId(token, folderId, ownerId);
      const { blob, payload } = await buildBackupZip(db, ownerId);

      let finalFileId = existingFileId;

      if (existingFileId) {
        try {
          const response = await driveFetch(
            `upload/drive/v3/files/${existingFileId}?uploadType=media&fields=id`,
            token,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/zip" },
              body: blob,
            },
          );
          const updated = (await response.json()) as { id?: string };
          finalFileId = updated.id ?? existingFileId;
        } catch (error) {
          await recordBackup(
            db,
            "google-drive",
            "failed",
            payload.notes.length,
            (error as Error).message,
          );
          throw error;
        }
      } else {
        const metadata = {
          name: CANONICAL_BACKUP_NAME,
          mimeType: "application/zip",
          parents: [folderId],
        };
        const form = new FormData();
        form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
        form.append("file", blob);

        try {
          const response = await driveFetch(
            "upload/drive/v3/files?uploadType=multipart&fields=id",
            token,
            {
              method: "POST",
              body: form,
            },
          );
          const created = (await response.json()) as { id?: string };
          finalFileId = created.id ?? null;
        } catch (error) {
          await recordBackup(
            db,
            "google-drive",
            "failed",
            payload.notes.length,
            (error as Error).message,
          );
          throw error;
        }
      }

      // Reconcile duplicate canonical files created by race conditions or multi-device syncs.
      // Deterministically select the survivor across all concurrent clients (oldest createdTime, tie-break by ID).
      if (finalFileId) {
        try {
          const dedupeQuery = encodeURIComponent(
            `'${folderId}' in parents and name='${CANONICAL_BACKUP_NAME}' and trashed=false`,
          );
          const dupsData = (await (
            await driveFetch(
              `drive/v3/files?q=${dedupeQuery}&fields=files(id,createdTime)&pageSize=20`,
              token,
            )
          ).json()) as { files?: Array<{ id: string; createdTime?: string }> };

          const duplicates = dupsData.files ?? [];
          if (duplicates.length > 1) {
            // Sort deterministically across all concurrent clients: oldest createdTime first, tie-break by id ascending.
            duplicates.sort((a, b) => {
              const timeA = a.createdTime ? new Date(a.createdTime).getTime() : 0;
              const timeB = b.createdTime ? new Date(b.createdTime).getTime() : 0;
              if (timeA !== timeB) return timeA - timeB;
              return a.id.localeCompare(b.id);
            });

            const survivor = duplicates[0];
            if (survivor?.id) {
              // If current run created/updated a file other than the deterministic survivor,
              // patch the current backup payload into the survivor so contents are never lost.
              if (finalFileId !== survivor.id) {
                try {
                  await driveFetch(
                    `upload/drive/v3/files/${survivor.id}?uploadType=media&fields=id`,
                    token,
                    {
                      method: "PATCH",
                      headers: { "Content-Type": "application/zip" },
                      body: blob,
                    },
                  );
                  finalFileId = survivor.id;
                } catch {
                  /* if patching survivor fails, retain finalFileId as active backup */
                }
              }

              // Trash all duplicate Noma Backup.zip files except the surviving canonical ID.
              for (const dup of duplicates) {
                if (dup.id && dup.id !== finalFileId) {
                  try {
                    await driveFetch(`drive/v3/files/${dup.id}`, token, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ trashed: true }),
                    });
                  } catch {
                    /* non-fatal if trash cleanup fails */
                  }
                }
              }
            }
          }
        } catch {
          /* non-fatal if deduplication cleanup fails */
        }
      }

      // Final resolution: verify and resolve the true non-trashed canonical file ID one last time
      // to guarantee that no trashed ID is ever cached if a race condition occurred.
      const verifiedCanonicalId = await resolveCanonicalFileId(token, folderId, ownerId);
      finalFileId = verifiedCanonicalId ?? finalFileId;

      const connection = patchConnection(ownerId, {
        lastBackupAt: Date.now(),
        folderId,
        backupFileId: finalFileId,
        lastSignature: await librarySignature(db),
      });
      await recordBackup(db, "google-drive", "success", payload.notes.length);
      // Lets the Settings card and the backup scheduler refresh their
      // last-backup displays no matter who started this backup.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("noma:backup-completed"));
      }
      return { connection, manifest: payload.manifest };
    } finally {
      activeBackups.delete(lockKey);
    }
  })();

  activeBackups.set(lockKey, backupPromise);
  return backupPromise;
}

export async function fetchDriveBackup(
  fileId: string,
  ownerId: string | null,
): Promise<BackupPayload> {
  const token = await authorize(ownerId);
  const response = await driveFetch(`drive/v3/files/${fileId}?alt=media`, token);
  return readBackupZip(await response.blob(), ownerId);
}

/** Cheap fingerprint of the local library, used to skip redundant uploads. */
export async function librarySignature(db: import("./db").NomaDatabase): Promise<string> {
  const d = db;
  const [notes, folders, tags, attachments] = await Promise.all([
    d.notes.toArray(),
    d.folders.count(),
    d.tags.count(),
    d.attachments.count(),
  ]);
  const latest = notes.reduce((max, note) => Math.max(max, note.updatedAt), 0);
  return `${notes.length}:${folders}:${tags}:${attachments}:${latest}`;
}

export async function hasUnbackedChanges(
  db: import("./db").NomaDatabase,
  ownerId: string | null,
): Promise<boolean> {
  const connection = getConnection(ownerId);
  if (!connection) return false;
  if (!connection.backupFileId || !connection.lastBackupAt) return true;
  return (await librarySignature(db)) !== connection.lastSignature;
}

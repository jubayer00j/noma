import { Capacitor } from "@capacitor/core";
import { applyBackup, type BackupPayload, type MergeCounts } from "./backup";
import { getSettings, newId, type NomaDatabase } from "./db";
import {
  backupNow,
  fetchCanonicalBackup,
  getCanonicalFileMeta,
  getConnection as getDriveConnection,
  type CanonicalFileMeta,
} from "./drive";
import type {
  AttachmentMeta,
  Folder,
  Note,
  Reminder,
  SyncEntity,
  SyncState,
  SyncTombstone,
  Tag,
} from "./types";

/**
 * Multi-device sync over the canonical Drive backup snapshot.
 *
 * There is no sync server: the "Noma Backup.zip" the backup engine already
 * uploads becomes two-way. Each cycle is pull → three-way merge → push:
 *
 * - A cheap Drive metadata read (modifiedTime + md5Checksum) decides
 *   whether the remote snapshot changed; unchanged means no download.
 * - The merge compares local and remote against the content hashes
 *   recorded at the last successful sync (`SyncState.hashes`). One-sided
 *   changes apply directly; a note edited on both sides keeps the newer
 *   edit and preserves the loser as a "(conflict copy)" note, so sync
 *   never silently loses text.
 * - Hard deletions travel as tombstones inside the snapshot's `sync.json`
 *   (see backup.ts) and delete the entity on every other device.
 * - Settings are never synced and never modified by a merge.
 *
 * The cycle is single-flight per account, mirroring `backupNow`.
 */

/* ---------------- Device identity ---------------- */

const DEVICE_ID_KEY = "noma-device-id";

/**
 * Stable per-device UUID, kept in localStorage like the Drive connection
 * record — deliberately never inside the database, so copying a database
 * to another device doesn't clone the identity.
 */
export function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const id = newId();
    window.localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return "unknown-device";
  }
}

/** Coarse human label for manifests and status displays. */
export function deviceLabel(): string {
  try {
    if (Capacitor.isNativePlatform()) return "Android";
  } catch {
    /* not a native shell — fall through to Web */
  }
  return "Web";
}

/* ---------------- Content hashes & signatures ---------------- */

/** FNV-1a, returned as hex. Deterministic across devices and platforms. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

type AnyEntity = Note | Folder | Tag | AttachmentMeta | Reminder;

const SYNC_ENTITIES: SyncEntity[] = ["note", "folder", "tag", "attachment", "reminder"];

function entitiesOf(
  source: {
    notes: Note[];
    folders: Folder[];
    tags: Tag[];
    attachments: AttachmentMeta[];
    reminders: Reminder[];
  },
  entity: SyncEntity,
): AnyEntity[] {
  switch (entity) {
    case "note":
      return source.notes;
    case "folder":
      return source.folders;
    case "tag":
      return source.tags;
    case "attachment":
      return source.attachments;
    case "reminder":
      return source.reminders;
  }
}

/** The timestamp merge rules compare: `updatedAt`, falling back to
 * `createdAt` for tags/attachments written before those fields existed. */
export function entityTimestamp(entity: SyncEntity, item: AnyEntity): number {
  if (entity === "tag" || entity === "attachment") {
    const row = item as Tag | AttachmentMeta;
    return row.updatedAt ?? row.createdAt;
  }
  return (item as Note | Folder | Reminder).updatedAt;
}

/**
 * Hash of an entity's sync-relevant fields. Deliberately excludes
 * device-local or derived values — `notificationId` (per-device),
 * `wordCount` (derived from content), lock `failedAttempts`/`lockoutUntil`
 * (churn on every unlock attempt) and `updatedAt` itself (pure timestamp
 * bumps with no field change are not content changes).
 */
export function entityContentHash(entity: SyncEntity, item: AnyEntity): string {
  switch (entity) {
    case "note": {
      const n = item as Note;
      return fnv1a(
        JSON.stringify([
          n.title,
          n.content,
          n.folderId,
          [...n.tagIds].sort(),
          n.pinned ? 1 : 0,
          n.favorite ? 1 : 0,
          n.archived ? 1 : 0,
          n.deleted ? 1 : 0,
          n.deletedAt ?? "",
          n.reminderAt ?? "",
          n.lock
            ? JSON.stringify({
                v: n.lock.v,
                slots: n.lock.slots,
                biometric: n.lock.biometric,
                lockedAt: n.lock.lockedAt,
              })
            : "",
        ]),
      );
    }
    case "folder": {
      const f = item as Folder;
      return fnv1a(JSON.stringify([f.name, f.parentId ?? ""]));
    }
    case "tag": {
      const t = item as Tag;
      return fnv1a(JSON.stringify([t.name]));
    }
    case "attachment": {
      const a = item as AttachmentMeta;
      return fnv1a(
        JSON.stringify([a.noteId, a.name, a.mimeType, a.size, a.data, a.encrypted ? 1 : 0]),
      );
    }
    case "reminder": {
      const r = item as Reminder;
      return fnv1a(
        JSON.stringify([
          r.noteId,
          r.scheduledAt,
          r.status,
          r.alertType ?? "notification",
          r.alarmToneMode ?? "",
          r.alarmToneUri ?? "",
          r.alarmToneName ?? "",
          r.alarmVibrate ?? "",
        ]),
      );
    }
  }
}

export interface LibrarySnapshot {
  notes: Note[];
  folders: Folder[];
  tags: Tag[];
  attachments: AttachmentMeta[];
  reminders: Reminder[];
  tombstones: SyncTombstone[];
}

/**
 * Content hashes for a whole library, keyed `"<entity>:<id>"`, with
 * tombstones folded in as `tombstone:<entity>:<id>` → deletedAt entries —
 * so one record is the complete merge base, tombstones included.
 */
export function computeSyncHashes(source: LibrarySnapshot): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const entity of SYNC_ENTITIES) {
    for (const item of entitiesOf(source, entity)) {
      hashes[`${entity}:${item.id}`] = entityContentHash(entity, item);
    }
  }
  for (const tombstone of source.tombstones) {
    hashes[`tombstone:${tombstone.entity}:${tombstone.id}`] = String(tombstone.deletedAt);
  }
  return hashes;
}

/** One fingerprint for a whole library state, from its hash record. */
export function syncSignatureFromHashes(hashes: Record<string, string>): string {
  const entries = Object.keys(hashes)
    .sort()
    .map((key) => `${key}=${hashes[key]}`);
  return fnv1a(entries.join("\n"));
}

export function librarySyncSignature(source: LibrarySnapshot): string {
  return syncSignatureFromHashes(computeSyncHashes(source));
}

export async function collectLibrarySnapshot(db: NomaDatabase): Promise<LibrarySnapshot> {
  const [notes, folders, tags, attachments, reminders, tombstones] = await Promise.all([
    db.notes.toArray(),
    db.folders.toArray(),
    db.tags.toArray(),
    db.attachments.toArray(),
    db.reminders.toArray(),
    db.tombstones ? db.tombstones.toArray() : Promise.resolve([] as SyncTombstone[]),
  ]);
  return { notes, folders, tags, attachments, reminders, tombstones };
}

/* ---------------- Sync state & tombstones ---------------- */

const DEFAULT_SYNC_STATE: SyncState = {
  id: "state",
  lastSyncAt: null,
  lastRemoteModifiedTime: null,
  lastRemoteChecksum: null,
  lastRemoteSignature: null,
  hashes: {},
};

export async function getSyncState(db: NomaDatabase): Promise<SyncState> {
  if (!db.syncMeta) return { ...DEFAULT_SYNC_STATE };
  return (await db.syncMeta.get("state")) ?? { ...DEFAULT_SYNC_STATE };
}

async function saveSyncState(db: NomaDatabase, state: SyncState): Promise<void> {
  if (db.syncMeta) await db.syncMeta.put(state);
}

/** Records a hard deletion so the next snapshot carries it to other devices. */
export async function recordTombstone(
  db: NomaDatabase,
  entity: SyncEntity,
  id: string,
): Promise<void> {
  if (!db.tombstones) return;
  await db.tombstones.put({ entity, id, deletedAt: Date.now(), deviceId: getDeviceId() });
}

/** Tombstones are kept for 90 days — long enough for a device that is
 * offline for a season to still learn about deletions when it returns. */
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

async function purgeExpiredTombstones(db: NomaDatabase): Promise<void> {
  if (!db.tombstones) return;
  const cutoff = Date.now() - TOMBSTONE_RETENTION_MS;
  const expired = await db.tombstones.filter((t) => t.deletedAt < cutoff).toArray();
  if (expired.length) await db.tombstones.bulkDelete(expired.map((t) => t.id));
}

/* ---------------- Three-way merge planner (pure) ---------------- */

export interface MergePlan {
  /** Resolved remote payload, ready for `applyBackup(db, payload, "merge")`. */
  payload: BackupPayload;
  /** Effective tombstone union to persist locally. */
  tombstones: SyncTombstone[];
  /** Conflict copies appended to the payload. */
  conflicts: number;
}

function conflictCopyId(kind: string, sourceId: string, loserHash: string): string {
  // Deterministic: two devices resolving the same conflict derive the
  // same copy id, so the copies converge instead of duplicating.
  return `conflict-${fnv1a(`${kind}:${sourceId}:${loserHash}`)}`;
}

function makeConflictCopy(
  note: Note,
  attachments: AttachmentMeta[],
): { note: Note; attachments: AttachmentMeta[] } {
  const loserHash = entityContentHash("note", note);
  const copyId = conflictCopyId("note", note.id, loserHash);
  const stamp = note.updatedAt;
  const title = `${note.title.trim() || "Untitled note"} (conflict copy)`;
  const copy: Note = {
    ...note,
    id: copyId,
    title,
    createdAt: stamp,
    updatedAt: stamp,
    reminderAt: null,
  };

  if (note.lock) {
    // The body is sealed ciphertext, so attachment references inside it
    // can't be rewritten — and don't need to be: a locked note's
    // attachments are loaded by noteId. Clone them all, still encrypted.
    return {
      note: copy,
      attachments: attachments.map((a) => ({
        ...a,
        id: conflictCopyId("att", a.id, loserHash),
        noteId: copyId,
      })),
    };
  }

  // Unlocked: mirror duplicateNote — clone referenced attachments under
  // fresh ids and rewrite the references in the copied content.
  let content = note.content;
  const referenced = new Set<string>();
  const regex = /noma-attachment:\/\/([a-zA-Z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(note.content)) !== null) {
    if (match[1]) referenced.add(match[1]);
  }
  const clones: AttachmentMeta[] = [];
  for (const attachment of attachments) {
    if (!referenced.has(attachment.id)) continue;
    const newId = conflictCopyId("att", attachment.id, loserHash);
    clones.push({ ...attachment, id: newId, noteId: copyId });
    content = content
      .split(`noma-attachment://${attachment.id}`)
      .join(`noma-attachment://${newId}`);
  }
  return { note: { ...copy, content }, attachments: clones };
}

/**
 * Resolves a downloaded snapshot against the local library and the merge
 * base. Pure — no database or network access — so the semantics are fully
 * testable. The returned payload is what `applyBackup` should merge; its
 * tombstones are the effective union (revived entries dropped).
 */
export function planMerge(
  local: LibrarySnapshot,
  remote: BackupPayload,
  baseHashes: Record<string, string>,
): MergePlan {
  const indexByKey = (source: LibrarySnapshot | BackupPayload) => {
    const map = new Map<string, AnyEntity>();
    for (const entity of SYNC_ENTITIES) {
      for (const item of entitiesOf(source, entity)) map.set(`${entity}:${item.id}`, item);
    }
    return map;
  };
  const localByKey = indexByKey(local);
  const remoteByKey = indexByKey(remote);

  // 1. Tombstone union — newest deletedAt per entity.
  const union = new Map<string, SyncTombstone>();
  for (const tombstone of [...local.tombstones, ...(remote.tombstones ?? [])]) {
    const key = `${tombstone.entity}:${tombstone.id}`;
    const existing = union.get(key);
    if (!existing || tombstone.deletedAt > existing.deletedAt) union.set(key, tombstone);
  }

  // 2. Revival filter: a copy edited after the deletion beats the tombstone.
  const tombstones: SyncTombstone[] = [];
  const tombstoneKeys = new Set<string>();
  for (const [key, tombstone] of union) {
    let latest = -Infinity;
    const localCopy = localByKey.get(key);
    if (localCopy) latest = Math.max(latest, entityTimestamp(tombstone.entity, localCopy));
    const remoteCopy = remoteByKey.get(key);
    if (remoteCopy) latest = Math.max(latest, entityTimestamp(tombstone.entity, remoteCopy));
    if (latest > tombstone.deletedAt) continue;
    tombstones.push(tombstone);
    tombstoneKeys.add(key);
  }

  // 3. Resolved payload: remote content minus tombstoned entities.
  const resolved: Record<SyncEntity, AnyEntity[]> = {
    note: remote.notes.filter((n) => !tombstoneKeys.has(`note:${n.id}`)),
    folder: remote.folders.filter((f) => !tombstoneKeys.has(`folder:${f.id}`)),
    tag: remote.tags.filter((t) => !tombstoneKeys.has(`tag:${t.id}`)),
    attachment: remote.attachments.filter((a) => !tombstoneKeys.has(`attachment:${a.id}`)),
    reminder: remote.reminders.filter((r) => !tombstoneKeys.has(`reminder:${r.id}`)),
  };

  // 4. Conflicts: both sides diverged from the base with different content.
  const stripKeys = new Set<string>();
  const extraNotes: Note[] = [];
  const extraAttachments: AttachmentMeta[] = [];
  let conflicts = 0;

  for (const entity of SYNC_ENTITIES) {
    const items = resolved[entity];
    for (let i = 0; i < items.length; i++) {
      const remoteItem = items[i]!;
      const key = `${entity}:${remoteItem.id}`;
      const localItem = localByKey.get(key);
      if (!localItem) continue;
      const localHash = entityContentHash(entity, localItem);
      const remoteHash = entityContentHash(entity, remoteItem);
      if (localHash === remoteHash) continue;
      const baseHash = baseHashes[key];
      if (localHash === baseHash || remoteHash === baseHash) continue; // one-sided change

      const localTs = entityTimestamp(entity, localItem);
      const remoteTs = entityTimestamp(entity, remoteItem);
      const remoteWins = remoteTs > localTs || (remoteTs === localTs && remoteHash > localHash);

      if (entity === "note") {
        conflicts++;
        const loser = (remoteWins ? localItem : remoteItem) as Note;
        const loserAttachments = (remoteWins ? local.attachments : remote.attachments).filter(
          (a) => a.noteId === loser.id,
        );
        const copy = makeConflictCopy(loser, loserAttachments);
        extraNotes.push(copy.note);
        extraAttachments.push(...copy.attachments);
      }

      if (!remoteWins) {
        // The local version stays; the remote one must not be applied.
        stripKeys.add(key);
      } else if (remoteTs <= localTs) {
        // Remote wins on the hash tie-break but applyBackup resolves by
        // updatedAt — nudge the winner past the local copy so it lands.
        // (updatedAt is not part of the content hash, so this cannot
        // make the two devices' views of the content diverge.)
        items[i] = { ...remoteItem, updatedAt: localTs + 1 } as AnyEntity;
      }
    }
  }

  const keep = (entity: SyncEntity) =>
    resolved[entity].filter((item) => !stripKeys.has(`${entity}:${item.id}`));

  // 5. Phone-alarm reminders arriving from another device become
  // notifications (D5): the Clock-app alarm they refer to doesn't exist
  // here. A reminder identical to the local copy is left untouched.
  const reminders = (keep("reminder") as Reminder[]).map((reminder) => {
    if (reminder.alertType !== "phone-alarm") return reminder;
    const localCopy = localByKey.get(`reminder:${reminder.id}`);
    if (
      localCopy &&
      entityContentHash("reminder", localCopy) === entityContentHash("reminder", reminder)
    ) {
      return reminder;
    }
    return {
      ...reminder,
      alertType: "notification" as const,
      alarmToneMode: undefined,
      alarmToneUri: undefined,
      alarmToneName: undefined,
      alarmVibrate: undefined,
      notificationId: undefined,
    };
  });

  return {
    payload: {
      manifest: remote.manifest,
      notes: [...(keep("note") as Note[]), ...extraNotes],
      folders: keep("folder") as Folder[],
      tags: keep("tag") as Tag[],
      attachments: [...(keep("attachment") as AttachmentMeta[]), ...extraAttachments],
      reminders,
      settings: null,
      tombstones,
      deviceId: remote.deviceId ?? remote.manifest.deviceId ?? null,
    },
    tombstones,
    conflicts,
  };
}

/* ---------------- The sync cycle ---------------- */

export type SyncReason =
  "start" | "foreground" | "reconnect" | "tick" | "edit" | "manual" | "scheduled" | "stage";

export interface SyncResult {
  status: "synced" | "skipped" | "failed";
  reason?: string;
  pulled?: boolean;
  pushed?: boolean;
  counts?: MergeCounts;
}

/** Drive surface the cycle needs — injectable so tests can run offline. */
export interface SyncDriveDeps {
  getConnection: typeof getDriveConnection;
  getCanonicalFileMeta: typeof getCanonicalFileMeta;
  fetchCanonicalBackup: typeof fetchCanonicalBackup;
  backupNow: typeof backupNow;
}

const defaultDriveDeps: SyncDriveDeps = {
  getConnection: getDriveConnection,
  getCanonicalFileMeta,
  fetchCanonicalBackup,
  backupNow,
};

export interface SyncOptions {
  /** Pull and merge, but never push (used before staging a snapshot). */
  pullOnly?: boolean;
  deps?: SyncDriveDeps;
}

const activeSyncs = new Map<string, Promise<SyncResult>>();

export function syncNow(
  db: NomaDatabase,
  ownerId: string | null,
  reason: SyncReason = "manual",
  options: SyncOptions = {},
): Promise<SyncResult> {
  void reason; // carried for logging/diagnostics by callers; the cycle is uniform
  const key = ownerId ?? "guest";
  const existing = activeSyncs.get(key);
  if (existing) return existing;
  const promise = runSyncCycle(db, ownerId, options).finally(() => {
    activeSyncs.delete(key);
  });
  activeSyncs.set(key, promise);
  return promise;
}

function emitSyncCompleted(result: SyncResult): void {
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function" &&
    typeof CustomEvent !== "undefined"
  ) {
    window.dispatchEvent(new CustomEvent("noma:sync-completed", { detail: result }));
  }
}

async function runSyncCycle(
  db: NomaDatabase,
  ownerId: string | null,
  options: SyncOptions,
): Promise<SyncResult> {
  const deps = options.deps ?? defaultDriveDeps;
  const finish = (result: SyncResult): SyncResult => {
    emitSyncCompleted(result);
    return result;
  };

  try {
    if (!deps.getConnection(ownerId)) {
      return finish({ status: "skipped", reason: "Google Drive is not connected." });
    }
    const settings = await getSettings(db);
    if (settings.backupMode === "off") {
      return finish({ status: "skipped", reason: "Sync is turned off." });
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return finish({ status: "skipped", reason: "You are offline." });
    }

    await purgeExpiredTombstones(db);
    const state = await getSyncState(db);

    const meta = await deps.getCanonicalFileMeta(ownerId);
    const remoteUnchanged =
      !!meta &&
      state.lastRemoteSignature !== null &&
      state.lastRemoteModifiedTime === meta.modifiedTime &&
      state.lastRemoteChecksum === meta.md5Checksum;

    let remotePayload: BackupPayload | null = null;
    let remoteMeta: CanonicalFileMeta | null = meta;
    if (meta && !remoteUnchanged) {
      const fetched = await deps.fetchCanonicalBackup(ownerId);
      if (fetched) {
        remotePayload = fetched.payload;
        remoteMeta = fetched.meta;
      }
    }

    return finish(
      await mergeAndMaybePush(db, ownerId, deps, state, remotePayload, remoteMeta, options, false),
    );
  } catch (error) {
    return finish({
      status: "failed",
      reason: error instanceof Error ? error.message : "Sync failed.",
    });
  }
}

async function mergeAndMaybePush(
  db: NomaDatabase,
  ownerId: string | null,
  deps: SyncDriveDeps,
  state: SyncState,
  remotePayload: BackupPayload | null,
  remoteMeta: CanonicalFileMeta | null,
  options: SyncOptions,
  retried: boolean,
): Promise<SyncResult> {
  let counts: MergeCounts | undefined;
  let pulled = false;
  let effectiveRemoteSignature = state.lastRemoteSignature;
  let base = state;

  if (remotePayload) {
    pulled = true;
    effectiveRemoteSignature = librarySyncSignature({
      notes: remotePayload.notes,
      folders: remotePayload.folders,
      tags: remotePayload.tags,
      attachments: remotePayload.attachments,
      reminders: remotePayload.reminders,
      tombstones: remotePayload.tombstones ?? [],
    });
    const local = await collectLibrarySnapshot(db);
    const plan = planMerge(local, remotePayload, state.hashes);
    const applied = await applyBackup(db, plan.payload, "merge");
    counts = { ...applied, conflicts: plan.conflicts };
    // The tombstone union is the local truth now (applyBackup already
    // unioned the payload's in; replace wholesale to drop revived ones).
    if (db.tombstones) {
      await db.tombstones.clear();
      if (plan.tombstones.length) await db.tombstones.bulkPut(plan.tombstones);
    }
    base = { ...state, hashes: computeSyncHashes(await collectLibrarySnapshot(db)) };
  }

  const mergedLibrary = await collectLibrarySnapshot(db);
  const mergedHashes = computeSyncHashes(mergedLibrary);
  const mergedSignature = syncSignatureFromHashes(mergedHashes);

  // Brand-new empty library and no remote snapshot: nothing exists
  // anywhere, so don't create a Drive file out of thin air.
  const libraryEmpty =
    mergedLibrary.notes.length === 0 &&
    mergedLibrary.folders.length === 0 &&
    mergedLibrary.tags.length === 0 &&
    mergedLibrary.attachments.length === 0 &&
    mergedLibrary.reminders.length === 0 &&
    mergedLibrary.tombstones.length === 0;
  if (!remotePayload && !remoteMeta && libraryEmpty && state.lastRemoteSignature === null) {
    await saveSyncState(db, { ...base, hashes: mergedHashes, lastSyncAt: Date.now() });
    return { status: "synced", pulled: false, pushed: false };
  }

  if (options.pullOnly || mergedSignature === effectiveRemoteSignature) {
    await saveSyncState(db, {
      ...base,
      hashes: mergedHashes,
      lastSyncAt: Date.now(),
      lastRemoteModifiedTime: remotePayload
        ? (remoteMeta?.modifiedTime ?? state.lastRemoteModifiedTime)
        : state.lastRemoteModifiedTime,
      lastRemoteChecksum: remotePayload
        ? (remoteMeta?.md5Checksum ?? state.lastRemoteChecksum)
        : state.lastRemoteChecksum,
      lastRemoteSignature: effectiveRemoteSignature,
    });
    return { status: "synced", pulled, pushed: false, ...(counts ? { counts } : {}) };
  }

  // Push path. If we pulled, re-check the remote meta once: another
  // device may have pushed while we merged. One bounded redo with the
  // fresher snapshot beats overwriting it.
  if (remotePayload && !retried) {
    const freshMeta = await deps.getCanonicalFileMeta(ownerId);
    if (
      freshMeta &&
      (freshMeta.modifiedTime !== remoteMeta?.modifiedTime ||
        freshMeta.md5Checksum !== remoteMeta?.md5Checksum)
    ) {
      const fetched = await deps.fetchCanonicalBackup(ownerId);
      if (fetched) {
        const inner = await mergeAndMaybePush(
          db,
          ownerId,
          deps,
          base,
          fetched.payload,
          fetched.meta,
          options,
          true,
        );
        if (counts && inner.counts) {
          inner.counts = {
            added: counts.added + inner.counts.added,
            updated: counts.updated + inner.counts.updated,
            deleted: counts.deleted + inner.counts.deleted,
            conflicts: counts.conflicts + inner.counts.conflicts,
          };
        } else if (counts) {
          inner.counts = counts;
        }
        return inner;
      }
    }
  }

  await deps.backupNow(db, ownerId);

  // Adopt our own echo: record the post-upload meta so the next cycle
  // doesn't re-download the snapshot we just wrote.
  let afterMeta: CanonicalFileMeta | null = null;
  try {
    afterMeta = await deps.getCanonicalFileMeta(ownerId);
  } catch {
    afterMeta = null;
  }
  await saveSyncState(db, {
    id: "state",
    hashes: mergedHashes,
    lastSyncAt: Date.now(),
    lastRemoteModifiedTime: afterMeta?.modifiedTime ?? null,
    lastRemoteChecksum: afterMeta?.md5Checksum ?? null,
    lastRemoteSignature: mergedSignature,
  });
  return { status: "synced", pulled, pushed: true, ...(counts ? { counts } : {}) };
}

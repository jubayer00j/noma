import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import {
  enqueueCapture,
  newCaptureId,
  normalizeSharePayload,
  type CaptureRequest,
  type RawSharePayload,
} from "./capture";

/**
 * Bridges the two share-target doors into the capture queue (capture.ts):
 *
 * - Android: the NomaShare plugin holds whatever the system shared into
 *   Noma (text + images). The web layer pulls it once at startup and again
 *   whenever the plugin reports a warm share. The native side consumes on
 *   read, so a payload can never be delivered twice.
 * - Web (installed PWA): the /share-target route lands the Web Share
 *   Target GET params in sessionStorage; the boot check below folds them
 *   into the queue and clears the key immediately.
 *
 * Everything here is a no-op where the platform doesn't apply.
 */

interface NativeSharedImage {
  name: string;
  mimeType: string;
  dataBase64: string;
}

interface NativeSharedContent {
  title?: string;
  text?: string;
  url?: string;
  images?: NativeSharedImage[];
}

interface NomaSharePlugin {
  getSharedContent(): Promise<NativeSharedContent | null>;
  addListener(
    eventName: "shareReceived",
    listenerFunc: () => void,
  ): Promise<PluginListenerHandle>;
}

const NativeShare = registerPlugin<NomaSharePlugin>("NomaShare");

export const WEB_SHARE_STORAGE_KEY = "noma.pendingWebShare";

function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

function sessionStorageOrNull(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/* ---------------- Android share target ---------------- */

async function pullNativeShare(): Promise<void> {
  if (!isAndroidNative()) return;
  try {
    const payload = await NativeShare.getSharedContent();
    if (!payload) return;
    const raw: RawSharePayload = {
      subject: payload.title ?? null,
      text: payload.text ?? null,
      url: payload.url ?? null,
      images: (payload.images ?? []).map((image) => ({
        name: image.name,
        mimeType: image.mimeType,
        dataUrl: `data:${image.mimeType};base64,${image.dataBase64}`,
      })),
    };
    enqueueCapture(normalizeSharePayload(raw, "android-share", newCaptureId()));
  } catch {
    /* a failed pull loses nothing — the note simply isn't pre-created */
  }
}

/* ---------------- Web share target ---------------- */

/**
 * Called by the /share-target route: normalises the Web Share Target
 * params and parks the resulting request in sessionStorage for the boot
 * check. Stored rather than enqueued directly because the route runs
 * before the workspace (and its database + lock gate) exists.
 */
export function storePendingWebShare(raw: RawSharePayload): void {
  const storage = sessionStorageOrNull();
  if (!storage) return;
  try {
    const request = normalizeSharePayload(raw, "web-share", newCaptureId());
    storage.setItem(WEB_SHARE_STORAGE_KEY, JSON.stringify(request));
  } catch {
    /* storage full/blocked — the share is dropped, nothing else breaks */
  }
}

function isCaptureRequest(value: unknown): value is CaptureRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<CaptureRequest>;
  return (
    (request.kind === "share" || request.kind === "new-note") && typeof request.id === "string"
  );
}

/**
 * Boot check: folds a parked web-share request into the capture queue.
 * The storage key is cleared before parsing, so a malformed payload can
 * never be retried forever. Returns true when something was enqueued.
 */
export function checkWebShareBoot(): boolean {
  const storage = sessionStorageOrNull();
  if (!storage) return false;
  let raw: string | null = null;
  try {
    raw = storage.getItem(WEB_SHARE_STORAGE_KEY);
    if (raw) storage.removeItem(WEB_SHARE_STORAGE_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isCaptureRequest(parsed)) return enqueueCapture(parsed);
  } catch {
    /* fall through — cleared above either way */
  }
  return false;
}

/**
 * Boot check for the PWA manifest shortcut ("New note" → /?capture=new-note).
 * Enqueues a plain new-note capture and strips the param so a reload
 * doesn't capture twice. Returns true when it fired.
 */
export function checkPwaShortcutParam(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("capture") !== "new-note") return false;
    params.delete("capture");
    const query = params.toString();
    const cleanUrl = window.location.pathname + (query ? `?${query}` : "") + window.location.hash;
    window.history.replaceState(window.history.state, "", cleanUrl);
    return enqueueCapture({ kind: "new-note", source: "pwa-shortcut", id: newCaptureId() });
  } catch {
    return false;
  }
}

/* ---------------- Wiring ---------------- */

let isInitialized = false;

/**
 * Registers the native share listener, pulls any cold share, and runs the
 * web boot checks. Idempotent; safe to call from the workspace on mount.
 */
export function initShareTarget(): void {
  if (isInitialized) return;
  isInitialized = true;

  checkWebShareBoot();
  checkPwaShortcutParam();

  if (!isAndroidNative()) return;
  void pullNativeShare();
  void NativeShare.addListener("shareReceived", () => {
    void pullNativeShare();
  }).catch(() => {
    /* listener is a latency nicety — the startup pull already ran */
  });
}

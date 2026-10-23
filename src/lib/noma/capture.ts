import { useEffect, useState } from "react";

/**
 * The one capture pipeline every "door" into Noma feeds: the Android
 * share target, the PWA share target, the home-screen widget, the Quick
 * Settings tile and the PWA manifest shortcut. Modelled on shortcut.ts:
 * requests are normalised, held in an in-memory queue, and consumed by
 * the workspace only when the database is ready and the app is unlocked —
 * so a capture can never bypass the App Lock or land before there's a
 * database to write it to.
 *
 * Every request carries an id and a consumed id is never processed twice:
 * Android may re-deliver an intent on rotation/recreate and React may
 * remount, but a capture must still produce exactly one note.
 */

export interface CaptureImage {
  name: string;
  mimeType: string;
  dataUrl: string;
}

export type CaptureSource =
  | "shortcut"
  | "widget"
  | "tile"
  | "pwa-shortcut"
  | "android-share"
  | "web-share";

export type NewNoteCaptureSource = Exclude<CaptureSource, "android-share" | "web-share">;

export type CaptureRequest =
  | { kind: "new-note"; source: CaptureSource; id: string }
  | {
      kind: "share";
      source: "android-share" | "web-share";
      id: string;
      title: string;
      /** Note body as HTML, already escaped + paragraphed (see normalizeSharePayload). */
      content: string;
      images: CaptureImage[];
    };

/** Loose share payload as delivered by the native plugin or the web share form. */
export interface RawSharePayload {
  /** Android EXTRA_SUBJECT — wins over `title` when both are present. */
  subject?: string | null;
  /** Web Share Target `title` param (usually the page title). */
  title?: string | null;
  text?: string | null;
  url?: string | null;
  images?: CaptureImage[] | null;
}

export const MAX_SHARE_TITLE_CHARS = 200;
export const MAX_SHARE_TEXT_CHARS = 100_000;
export const MAX_SHARE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_SHARE_IMAGES = 10;

let idCounter = 0;

export function newCaptureId(): string {
  idCounter += 1;
  return `capture-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/* ---------------- Queue ---------------- */

const pendingCaptures: CaptureRequest[] = [];
const seenCaptureIds = new Set<string>();
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((listener) => listener());
}

/** Adds a request to the queue. Returns false when the id was already seen. */
export function enqueueCapture(request: CaptureRequest): boolean {
  if (seenCaptureIds.has(request.id)) return false;
  seenCaptureIds.add(request.id);
  pendingCaptures.push(request);
  notifyListeners();
  return true;
}

/** The oldest unconsumed request, or null when the queue is empty. */
export function getPendingCapture(): CaptureRequest | null {
  return pendingCaptures[0] ?? null;
}

/** Removes a request from the queue; its id stays seen forever. */
export function consumeCapture(id: string): void {
  const index = pendingCaptures.findIndex((request) => request.id === id);
  if (index === -1) return;
  pendingCaptures.splice(index, 1);
  notifyListeners();
}

/** Hook form of the queue: re-renders whenever the head request changes. */
export function usePendingCapture() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const onChange = () => setTick((t) => t + 1);
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  return { request: getPendingCapture(), consumeCapture };
}

/** Test-only: clears the queue and the seen-id set between test cases. */
export function resetCaptureStateForTests(): void {
  pendingCaptures.length = 0;
  seenCaptureIds.clear();
  notifyListeners();
}

/* ---------------- Normalisation ---------------- */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Plain text → note HTML: escaped, one <p> per paragraph, <br> for single newlines. */
export function plainTextToNoteHtml(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function isBareUrl(text: string): boolean {
  if (!/^\S+$/.test(text)) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Approximate decoded size of a base64 data URL, without decoding it. */
export function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma === -1 || !dataUrl.slice(0, comma).includes("base64")) {
    return dataUrl.length;
  }
  const base64 = dataUrl.slice(comma + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function normalizeImages(images: CaptureImage[] | null | undefined): CaptureImage[] {
  if (!images?.length) return [];
  const kept: CaptureImage[] = [];
  for (const image of images) {
    if (kept.length >= MAX_SHARE_IMAGES) break;
    if (!image || typeof image.dataUrl !== "string") continue;
    if (!image.dataUrl.startsWith("data:")) continue;
    if (typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) continue;
    if (dataUrlByteSize(image.dataUrl) > MAX_SHARE_IMAGE_BYTES) continue;
    kept.push({
      name: typeof image.name === "string" && image.name.trim() ? image.name : "image",
      mimeType: image.mimeType,
      dataUrl: image.dataUrl,
    });
  }
  return kept;
}

/**
 * Maps a loose share payload onto a capture request. Pure and total: a
 * payload with no title, no text and no usable images degrades to a plain
 * new-note capture rather than failing.
 */
export function normalizeSharePayload(
  raw: RawSharePayload,
  source: "android-share" | "web-share",
  id: string,
): CaptureRequest {
  const titleCandidate = [raw.subject, raw.title]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find((value) => value.length > 0);
  const title = (titleCandidate ?? "").slice(0, MAX_SHARE_TITLE_CHARS).trim();

  let text = typeof raw.text === "string" ? raw.text : "";
  let url = typeof raw.url === "string" ? raw.url.trim() : "";

  // A share whose whole text is one bare URL is a link share, not prose.
  const trimmedText = text.trim();
  if (trimmedText && isBareUrl(trimmedText)) {
    if (!url) url = trimmedText;
    text = "";
  }

  text = text.slice(0, MAX_SHARE_TEXT_CHARS);

  // Merge the URL into the body exactly once.
  let body = text.trim();
  if (url) {
    if (!body) body = url;
    else if (!body.includes(url)) body = `${body}\n\n${url}`;
  }

  const images = normalizeImages(raw.images);
  const content = body ? plainTextToNoteHtml(body) : "";

  if (!title && !content && images.length === 0) {
    return { kind: "new-note", source, id };
  }
  return { kind: "share", source, id, title, content, images };
}

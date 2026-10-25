import JSZip from "jszip";
import type { NomaDatabase } from "./db";
import { createFolder, createNote, createTag } from "./notes";
import { saveImageAttachment } from "./media";
import { countWords, sanitizeHtml } from "./sanitize";

/**
 * Importers (roadmap #7): bring notes in from Google Keep (Takeout ZIP)
 * and from Markdown / plain-text files, folders, or ZIPs.
 *
 * Importing is a different verb from backup restore: it only ever ADDS
 * notes. Nothing here deletes, replaces, or overwrites an existing note —
 * a note whose (title, createdAt) already exists in the library (in any
 * state, including trashed) is skipped as a duplicate, which makes
 * re-importing the same export a no-op.
 *
 * The parsers are pure (no DB access) and produce `ImportedNote`s whose
 * `contentHtml` is already in the editor's own serialised shapes — most
 * importantly the task-list markup the editor itself emits
 * (`<ul data-type="taskList"><li data-checked="…" data-type="taskItem">
 * <label><input type="checkbox" …><span></span></label><div><p>…</p>
 * </div></li></ul>`, verified against a real editor instance) — and every
 * construct the Markdown converter emits survives `sanitizeHtml`
 * unchanged in structure (proven by the round-trip tests in
 * importers.test.ts). Images ride the existing attachment pipeline:
 * content carries a placeholder token per resolved image, and
 * `importNotes` swaps each token for the editor's embed markup
 * (`<img src="noma-attachment://<id>" alt="…">`) once the attachment row
 * exists.
 */

/* ---------------- Shared types ---------------- */

export interface ImportedImage {
  name: string;
  mimeType: string;
  blob: Blob;
  alt: string;
  /**
   * Placeholder token inside `contentHtml` to swap for the saved
   * attachment's embed markup. Null means "append at the end of the
   * content, in order" (the Keep attachment-list flow).
   */
  token: string | null;
}

export interface ImportedNote {
  title: string;
  /** Editor-shaped HTML; may contain image placeholder tokens. */
  contentHtml: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  deletedAt: number | null;
  tagNames: string[];
  folderName: string | null;
  images: ImportedImage[];
  /** Display name of the source file, for failure reporting. */
  sourceName: string;
}

export interface SkippedImportFile {
  name: string;
  reason: string;
}

export interface ImportParseResult {
  notes: ImportedNote[];
  skippedFiles: SkippedImportFile[];
  /** Source attachments that were not images (Keep audio memos etc.). */
  attachmentsSkipped: number;
  /** Image references that couldn't be resolved to a picked file. */
  imagesUnresolved: number;
  /** Keep notes that carried a colour (Noma has no colour mapping). */
  coloredNotes: number;
}

export interface ImportReport {
  imported: number;
  duplicates: number;
  failed: number;
  failedNames: string[];
}

/* ---------------- Caps ---------------- */

/** Max notes one import run will create; excess files are reported. */
export const MAX_IMPORT_NOTES = 5000;
/** Max size of one source file / ZIP member (100 MB). */
export const MAX_IMPORT_FILE_BYTES = 100 * 1024 * 1024;

function emptyParseResult(): ImportParseResult {
  return { notes: [], skippedFiles: [], attachmentsSkipped: 0, imagesUnresolved: 0, coloredNotes: 0 };
}

/* ---------------- Escaping ---------------- */

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/** Reverses the entities escapeHtml/escapeAttr introduce (for URL refs). */
function unescapeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/* ---------------- Shared HTML builders ---------------- */

/**
 * One task list in the exact shape the editor serialises (see header).
 * Item HTML is pre-rendered by the caller (Keep passes escaped plain
 * text; Markdown passes inline-rendered HTML).
 */
function taskListHtml(items: { html: string; checked: boolean }[]): string {
  const lis = items
    .map(
      (item) =>
        `<li data-checked="${item.checked ? "true" : "false"}" data-type="taskItem">` +
        `<label><input type="checkbox"${item.checked ? ' checked="checked"' : ""}><span></span></label>` +
        `<div><p>${item.html}</p></div></li>`,
    )
    .join("");
  return `<ul data-type="taskList">${lis}</ul>`;
}

/** Plain text → paragraphs: blank lines split, single newlines become <br>. */
export function plainTextToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return "";
  return paragraphs
    .map((p) => `<p>${p.split("\n").map((line) => escapeHtml(line)).join("<br>")}</p>`)
    .join("");
}

/* ---------------- Google Keep (Takeout ZIP) ---------------- */

interface KeepNoteJson {
  title?: unknown;
  textContent?: unknown;
  listContent?: unknown;
  labels?: unknown;
  isPinned?: unknown;
  isArchived?: unknown;
  isTrashed?: unknown;
  createdTimestampUsec?: unknown;
  userEditedTimestampUsec?: unknown;
  attachments?: unknown;
  color?: unknown;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

function mimeFromName(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXT[ext] ?? null;
}

function baseName(path: string): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

function usecToMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value / 1000);
}

/**
 * Parses a Google Keep Takeout ZIP. Every `*.json` under any `Keep/`
 * folder is a note; if the ZIP has no Keep folder, every `.json` entry
 * is tried (and guarded — entries that don't look like Keep notes are
 * skipped, not imported as junk).
 */
export async function parseKeepTakeout(
  data: Blob | Uint8Array | ArrayBuffer,
): Promise<ImportParseResult> {
  const result = emptyParseResult();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data as Blob);
  } catch {
    result.skippedFiles.push({
      name: "Takeout ZIP",
      reason: "That file couldn't be read as a ZIP archive.",
    });
    return result;
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const jsonEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith(".json"));
  const inKeep = jsonEntries.filter((entry) =>
    entry.name.split("/").some((segment) => segment.toLowerCase() === "keep"),
  );
  const candidates = inKeep.length > 0 ? inKeep : jsonEntries;

  /** ZIP entry lookup by full path, then by "ends with", then by basename. */
  const findEntry = (ref: string) => {
    const wanted = ref.replace(/\\/g, "/");
    const direct = zip.file(wanted);
    if (direct) return direct;
    const suffix = `/${wanted}`;
    const bySuffix = entries.find((entry) => entry.name.endsWith(suffix));
    if (bySuffix) return bySuffix;
    const base = baseName(wanted).toLowerCase();
    return entries.find((entry) => baseName(entry.name).toLowerCase() === base) ?? null;
  };

  for (const entry of candidates) {
    const name = baseName(entry.name);
    if (result.notes.length >= MAX_IMPORT_NOTES) {
      result.skippedFiles.push({ name, reason: "Import limit reached (5,000 notes per run)." });
      continue;
    }
    let raw: string;
    try {
      raw = await entry.async("string");
    } catch {
      result.skippedFiles.push({ name, reason: "Couldn't be read from the ZIP." });
      continue;
    }
    if (raw.length > MAX_IMPORT_FILE_BYTES) {
      result.skippedFiles.push({ name, reason: "File is larger than 100 MB." });
      continue;
    }
    let parsed: KeepNoteJson;
    try {
      parsed = JSON.parse(raw) as KeepNoteJson;
    } catch {
      result.skippedFiles.push({ name, reason: "Not valid JSON — skipped." });
      continue;
    }
    const note = await keepJsonToImportedNote(parsed, name, findEntry, result);
    if (note) result.notes.push(note);
  }
  return result;
}

async function keepJsonToImportedNote(
  json: KeepNoteJson,
  sourceName: string,
  findEntry: (ref: string) => JSZip.JSZipObject | null,
  result: ImportParseResult,
): Promise<ImportedNote | null> {
  const title = typeof json.title === "string" ? json.title : "";
  const textContent = typeof json.textContent === "string" ? json.textContent : "";
  const listContent = Array.isArray(json.listContent) ? json.listContent : [];
  const attachments = Array.isArray(json.attachments) ? json.attachments : [];

  // Guard for the fallback "any .json in the ZIP" path: an entry with no
  // Keep fields at all isn't a note.
  if (!title && !textContent && listContent.length === 0 && attachments.length === 0) {
    result.skippedFiles.push({ name: sourceName, reason: "Doesn't look like a Keep note." });
    return null;
  }

  const createdAt =
    usecToMs(json.createdTimestampUsec) ?? usecToMs(json.userEditedTimestampUsec) ?? Date.now();
  const updatedAt = usecToMs(json.userEditedTimestampUsec) ?? createdAt;
  const trashed = json.isTrashed === true;

  let contentHtml = "";
  if (listContent.length > 0) {
    const items = listContent.map((rawItem) => {
      const item = (rawItem ?? {}) as { text?: unknown; isChecked?: unknown };
      const text = typeof item.text === "string" ? item.text.replace(/\s*\n\s*/g, " ") : "";
      return { html: escapeHtml(text), checked: item.isChecked === true };
    });
    contentHtml = taskListHtml(items);
  } else if (textContent) {
    contentHtml = plainTextToHtml(textContent);
  }

  const tagNames: string[] = [];
  if (Array.isArray(json.labels)) {
    for (const rawLabel of json.labels) {
      const label = (rawLabel ?? {}) as { name?: unknown };
      if (typeof label.name === "string" && label.name.trim()) tagNames.push(label.name.trim());
    }
  }

  const images: ImportedImage[] = [];
  for (const rawAttachment of attachments) {
    const attachment = (rawAttachment ?? {}) as { filePath?: unknown; mimetype?: unknown };
    const filePath = typeof attachment.filePath === "string" ? attachment.filePath : "";
    const declaredMime = typeof attachment.mimetype === "string" ? attachment.mimetype : "";
    const mimeType = declaredMime || (filePath ? mimeFromName(filePath) : null) || "";
    if (!filePath || !mimeType.startsWith("image/")) {
      // Audio memos and other non-images: the editor has no player for
      // them — counted and reported, never silently dropped.
      result.attachmentsSkipped += 1;
      continue;
    }
    const entry = findEntry(filePath);
    if (!entry) {
      result.attachmentsSkipped += 1;
      continue;
    }
    try {
      const blob = await entry.async("blob");
      if (blob.size > MAX_IMPORT_FILE_BYTES) {
        result.attachmentsSkipped += 1;
        continue;
      }
      images.push({
        name: baseName(filePath),
        mimeType,
        blob,
        alt: baseName(filePath),
        token: null, // appended at the end of the content, in order
      });
    } catch {
      result.attachmentsSkipped += 1;
    }
  }

  if (typeof json.color === "string" && json.color && json.color !== "DEFAULT") {
    result.coloredNotes += 1;
  }

  return {
    title,
    contentHtml,
    createdAt,
    updatedAt,
    pinned: json.isPinned === true,
    archived: json.isArchived === true,
    deleted: trashed,
    deletedAt: trashed ? updatedAt : null,
    tagNames,
    folderName: null, // Keep imports get no folder — labels carry the organisation.
    images,
    sourceName,
  };
}

/* ---------------- Markdown / text ---------------- */

export interface MarkdownFileInput {
  /** Base name, e.g. "note.md". */
  name: string;
  /** Full relative path within the picked set, e.g. "folder/sub/note.md". */
  path: string;
  text: string;
  lastModified: number;
}

export interface ResolvedImportImage {
  name: string;
  mimeType: string;
  blob: Blob;
}

/**
 * Resolves a relative image reference from the importing file's path to
 * image bytes within the picked set / ZIP. Returns null when the
 * reference can't be resolved (the alt text is kept and counted).
 */
export type ImportImageResolver = (
  fromPath: string,
  ref: string,
) => Promise<ResolvedImportImage | null>;

/** Normalises a relative path: resolves "." / "..", strips leading "/". */
export function normaliseImportPath(path: string): string {
  const out: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

function resolveRef(fromPath: string, ref: string): string {
  let decoded = ref;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    /* keep the raw ref */
  }
  if (decoded.startsWith("/")) return normaliseImportPath(decoded);
  const dir = fromPath.split("/").slice(0, -1).join("/");
  return normaliseImportPath(dir ? `${dir}/${decoded}` : decoded);
}

/**
 * Builds a resolver over an in-memory path → bytes map (picked files or
 * ZIP entries). Exact normalised-path match first, then a unique
 * basename match (flat exports often lose the folder structure).
 */
export function createImportImageResolver(
  files: Map<string, { name: string; blob: Blob }>,
): ImportImageResolver {
  const byPath = new Map<string, { name: string; blob: Blob }>();
  for (const [path, file] of files) byPath.set(normaliseImportPath(path), file);
  const pick = (file: { name: string; blob: Blob }): ResolvedImportImage => ({
    name: file.name,
    mimeType: mimeFromName(file.name) ?? file.blob.type ?? "",
    blob: file.blob,
  });
  return async (fromPath, ref) => {
    const target = resolveRef(fromPath, ref);
    const direct = byPath.get(target);
    if (direct) return pick(direct);
    const base = baseName(target).toLowerCase();
    const matches = [...byPath.values()].filter(
      (file) => file.name.toLowerCase() === base,
    );
    return matches.length === 1 ? pick(matches[0]!) : null;
  };
}

/* -------- Front matter -------- */

interface FrontMatter {
  title?: string;
  createdAt?: number;
  tags: string[];
  body: string;
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFrontMatter(text: string): FrontMatter {
  const out: FrontMatter = { tags: [], body: text };
  if (!text.startsWith("---")) return out;
  const firstBreak = text.indexOf("\n");
  if (firstBreak === -1 || text.slice(0, firstBreak).trim() !== "---") return out;
  const rest = text.slice(firstBreak + 1);
  const closeMatch = rest.match(/^---[ \t]*$/m);
  if (!closeMatch || closeMatch.index === undefined) return out;
  const block = rest.slice(0, closeMatch.index);
  out.body = rest.slice(closeMatch.index + closeMatch[0].length).replace(/^\r?\n/, "");

  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    if (key === "title" && value) {
      out.title = stripQuotes(value);
    } else if ((key === "date" || key === "created") && value) {
      const parsedDate = Date.parse(stripQuotes(value));
      if (Number.isFinite(parsedDate)) out.createdAt = parsedDate;
    } else if (key === "tags") {
      if (value.startsWith("[") && value.endsWith("]")) {
        out.tags = value
          .slice(1, -1)
          .split(",")
          .map((t) => stripQuotes(t.trim()))
          .filter(Boolean);
      } else if (value) {
        out.tags = value
          .split(",")
          .map((t) => stripQuotes(t.trim()))
          .filter(Boolean);
      } else {
        // Block list:
        //   tags:
        //     - one
        //     - two
        for (let j = i + 1; j < lines.length; j++) {
          const item = lines[j]!.match(/^\s*-\s+(.*)$/);
          if (!item) break;
          const tag = stripQuotes(item[1]!.trim());
          if (tag) out.tags.push(tag);
          i = j;
        }
      }
    }
  }
  return out;
}

/* -------- Inline rendering (escape-first) -------- */

interface InlineImageSink {
  addImage(alt: string, ref: string): Promise<string>;
}

async function replaceAsync(
  text: string,
  pattern: RegExp,
  replacer: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  let out = "";
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    out += text.slice(lastIndex, match.index);
    out += await replacer(match[0], ...(match.slice(1) as string[]));
    lastIndex = match.index + match[0].length;
  }
  out += text.slice(lastIndex);
  return out;
}

/**
 * Renders inline Markdown to editor HTML. Raw source HTML is escaped,
 * never passed through. Code spans are carved out first so their
 * contents are never formatted or mistaken for images/links.
 */
async function renderInline(raw: string, images: InlineImageSink): Promise<string> {
  const segments = raw.split(/(`[^`]+`)/g);
  let out = "";
  for (const segment of segments) {
    if (segment.length >= 2 && segment.startsWith("`") && segment.endsWith("`")) {
      out += `<code>${escapeHtml(segment.slice(1, -1))}</code>`;
    } else {
      out += await renderInlineText(segment, images);
    }
  }
  return out;
}

async function renderInlineText(raw: string, images: InlineImageSink): Promise<string> {
  let text = escapeHtml(raw);

  // Images first (their syntax contains the link syntax).
  text = await replaceAsync(
    text,
    /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\s*\)/g,
    async (_match, alt, src) => images.addImage(unescapeEntities(alt), unescapeEntities(src)),
  );

  // Links: only http/https/mailto survive as links; anything else
  // degrades to its text (a file:// or javascript: ref is never emitted).
  text = text.replace(
    /\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\s*\)/g,
    (_match, label: string, href: string) => {
      const rawHref = unescapeEntities(href);
      if (/^(https?:|mailto:)/i.test(rawHref)) {
        return `<a href="${escapeAttr(rawHref)}">${label}</a>`;
      }
      return label;
    },
  );

  // Emphasis. Markers survive escaping untouched, so they can be applied
  // to the escaped text.
  text = text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_([^_]+)_(?![\w])/g, "$1<em>$2</em>");
  return text;
}

/* -------- Block rendering -------- */

/** The marker system of an ordered list, as carried by the OL `type` attribute. */
type OrderedListType = "1" | "a" | "A" | "i" | "I";

interface ListItem {
  indent: number;
  ordered: boolean;
  /** Marker system for ordered items; null for bullets. */
  listType: OrderedListType | null;
  /** Numeric value of the item's own marker (alpha/roman converted); null for bullets. */
  value: number | null;
  task: boolean;
  checked: boolean;
  text: string;
}

const LIST_LINE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const LETTERED_LINE = /^(\s*)([A-Za-z]+)[.)]\s+(.*)$/;
const TASK_MARKER = /^\[( |x|X)\]\s+(.*)$/;

const listIndent = (whitespace: string): number =>
  Math.floor(whitespace.replace(/\t/g, "  ").length / 2);

const lineIndent = (line: string): number => listIndent(line.match(/^(\s*)/)![1]!);

const ROMAN_DIGITS: Record<string, number> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

/** Strict roman-numeral value of a marker (single case only), or null when it isn't one. */
function parseRomanNumeral(marker: string): number | null {
  if (!/^[ivxlcdm]+$/i.test(marker)) return null;
  const lower = marker.toLowerCase();
  if (marker !== lower && marker !== marker.toUpperCase()) return null; // mixed case
  if (!/^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/.test(lower)) return null;
  let total = 0;
  for (let k = 0; k < lower.length; k++) {
    const current = ROMAN_DIGITS[lower[k]!]!;
    const next = k + 1 < lower.length ? ROMAN_DIGITS[lower[k + 1]!]! : 0;
    total += current < next ? -current : current;
  }
  return total;
}

interface LetteredCandidate {
  indent: number;
  text: string;
  upper: boolean;
  /**
   * Spreadsheet-style alpha value of the marker (a=1 … z=26, aa=27, ab=28)
   * when it is written in one consistent case; null for mixed-case markers.
   */
  alpha: number | null;
  /** Value when the marker is a valid roman numeral. */
  roman: number | null;
}

/**
 * Spreadsheet-style (bijective base-26) value of a letter marker, matching
 * the exporter's `toAlpha`: a=1 … z=26, aa=27, az=52, ba=53. Mixed-case
 * markers belong to neither system and return null.
 */
function parseAlphaMarker(marker: string): number | null {
  if (marker !== marker.toLowerCase() && marker !== marker.toUpperCase()) return null;
  const lower = marker.toLowerCase();
  let value = 0;
  for (const ch of lower) value = value * 26 + (ch.charCodeAt(0) - "a".charCodeAt(0) + 1);
  return value;
}

/**
 * A line that LOOKS like a lettered/roman list item ("a. ", "iv) ").
 * Such lines become list items only when sequence-confirmed (see
 * confirmLetteredStart) — prose is full of "a. " and "i. " sentence
 * fragments that must not turn into lists.
 */
function parseLetteredCandidate(line: string): LetteredCandidate | null {
  const match = line.match(LETTERED_LINE);
  if (!match) return null;
  const marker = match[2]!;
  const roman = parseRomanNumeral(marker);
  const alpha = parseAlphaMarker(marker);
  if (roman === null && alpha === null) return null; // mixed-case: neither system
  return {
    indent: listIndent(match[1]!),
    text: match[3]!,
    upper: marker === marker.toUpperCase(),
    alpha,
    roman,
  };
}

/** The candidate's marker value read as the given list type, or null when it isn't one. */
function letteredValue(candidate: LetteredCandidate, type: OrderedListType): number | null {
  switch (type) {
    case "a":
      return candidate.upper ? null : candidate.alpha;
    case "A":
      return candidate.upper ? candidate.alpha : null;
    case "i":
      return candidate.upper ? null : candidate.roman;
    case "I":
      return candidate.upper ? candidate.roman : null;
    default:
      return null;
  }
}

/**
 * Sequence confirmation for a would-be lettered/roman list: the candidate
 * at lines[idx] starts a list only when the next list-candidate line at
 * the same indent continues the sequence (+1 in the same system and
 * case). Roman is tried before alpha, so "i. ii. iii." reads as roman
 * while "c. d." (100 → 500 is not +1) falls through to alpha. A lone
 * lettered line is never confirmed — that false-positive guard is
 * deliberate, so ordinary prose keeps its paragraphs.
 */
function confirmLetteredStart(
  lines: string[],
  idx: number,
  candidate: LetteredCandidate,
): OrderedListType | null {
  const types: OrderedListType[] = [];
  if (candidate.roman !== null) types.push(candidate.upper ? "I" : "i");
  if (candidate.alpha !== null) types.push(candidate.upper ? "A" : "a");
  for (let j = idx + 1; j < lines.length; j++) {
    const raw = lines[j]!;
    if (raw.trim() === "") return null;
    if (LIST_LINE.test(raw)) {
      // A bullet/numeric line: only a deeper-indented (nested) one can
      // sit between a candidate and its successor.
      if (lineIndent(raw) <= candidate.indent) return null;
      continue;
    }
    const next = parseLetteredCandidate(raw);
    if (next) {
      if (next.indent < candidate.indent) return null;
      if (next.indent > candidate.indent) continue; // nested content, keep scanning
      for (const type of types) {
        const first = letteredValue(candidate, type);
        const second = letteredValue(next, type);
        if (first !== null && second !== null && second === first + 1) return type;
      }
      return null;
    }
    // Ordinary line: wrapped item text is indented deeper than the
    // candidate; anything at or above its indent ends the search.
    if (lineIndent(raw) <= candidate.indent) return null;
  }
  return null;
}

/**
 * Decides a lettered candidate line during list collection:
 * - a ListItem when it continues the live lettered run at its indent,
 *   or starts a new sequence-confirmed run;
 * - "break" when it breaks the live run's sequence — the caller ends
 *   the collection there and the line is re-evaluated as ordinary
 *   content (prose, or the start of a fresh run);
 * - null when it isn't a list item at all (the caller falls through to
 *   the indented-continuation rules).
 */
function letteredItem(
  lines: string[],
  idx: number,
  candidate: LetteredCandidate,
  items: ListItem[],
): ListItem | "break" | null {
  let prev: ListItem | undefined;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.indent <= candidate.indent) {
      if (items[k]!.indent === candidate.indent) prev = items[k];
      break;
    }
  }
  if (prev && prev.ordered && prev.listType !== null && prev.listType !== "1") {
    const value = letteredValue(candidate, prev.listType);
    if (value !== null && prev.value !== null && value === prev.value + 1) {
      return {
        indent: candidate.indent,
        ordered: true,
        listType: prev.listType,
        value,
        task: false,
        checked: false,
        text: candidate.text,
      };
    }
    return "break";
  }
  const type = confirmLetteredStart(lines, idx, candidate);
  if (!type) return null;
  return {
    indent: candidate.indent,
    ordered: true,
    listType: type,
    value: letteredValue(candidate, type),
    task: false,
    checked: false,
    text: candidate.text,
  };
}

async function renderMarkdownBlocks(markdown: string, images: InlineImageSink): Promise<string> {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let i = 0;

  const isBlank = (line: string) => line.trim() === "";
  // A lettered/roman line opens a list block only when sequence-confirmed.
  const letteredStartAt = (idx: number): OrderedListType | null => {
    const candidate = parseLetteredCandidate(lines[idx]!);
    return candidate ? confirmLetteredStart(lines, idx, candidate) : null;
  };
  const startsBlock = (line: string, idx: number) =>
    /^```/.test(line) ||
    /^#{1,6}\s/.test(line) ||
    /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line) ||
    /^>/.test(line) ||
    LIST_LINE.test(line) ||
    letteredStartAt(idx) !== null;

  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    // Fenced code block — contents are literal, never formatted.
    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        code.push(lines[i]!);
        i++;
      }
      i++; // closing fence (or EOF)
      blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    // Heading. The editor schema caps headings at level 3 (StarterKit
    // config in tiptap-extensions.tsx), so deeper levels clamp to H3
    // instead of being stripped by the editor on first open.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1]!.length, 3);
      blocks.push(`<h${level}>${await renderInline(heading[2]!.trim(), images)}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push("<hr>");
      i++;
      continue;
    }

    // Blockquote: consecutive > lines, blank quote lines split paragraphs.
    if (/^>/.test(line)) {
      const paragraphs: string[][] = [[]];
      while (i < lines.length && /^>/.test(lines[i]!)) {
        const content = lines[i]!.replace(/^>\s?/, "");
        if (content.trim() === "") paragraphs.push([]);
        else paragraphs[paragraphs.length - 1]!.push(content);
        i++;
      }
      const inner = (
        await Promise.all(
          paragraphs
            .filter((p) => p.length > 0)
            .map(async (p) => `<p>${await renderInline(p.join(" "), images)}</p>`),
        )
      ).join("");
      if (inner) blocks.push(`<blockquote>${inner}</blockquote>`);
      continue;
    }

    // Lists (incl. task lists), one indent level of nesting.
    if (LIST_LINE.test(line) || letteredStartAt(i) !== null) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const match = current.match(LIST_LINE);
        if (match) {
          const marker = match[2]!;
          const ordered = /\d/.test(marker[0]!);
          let text = match[3]!;
          let task = false;
          let checked = false;
          if (!ordered) {
            const taskMatch = text.match(TASK_MARKER);
            if (taskMatch) {
              task = true;
              checked = taskMatch[1] !== " ";
              text = taskMatch[2]!;
            }
          }
          items.push({
            indent: listIndent(match[1]!),
            ordered,
            listType: ordered ? "1" : null,
            value: ordered ? Number.parseInt(marker, 10) : null,
            task,
            checked,
            text,
          });
          i++;
          continue;
        }
        // Lettered/roman lines join only as confirmed sequences.
        const candidate = parseLetteredCandidate(current);
        if (candidate) {
          const decision = letteredItem(lines, i, candidate, items);
          if (decision === "break") break;
          if (decision) {
            items.push(decision);
            i++;
            continue;
          }
        }
        // Indented continuation of the previous item.
        if (
          !isBlank(current) &&
          /^\s{2,}\S/.test(current) &&
          items.length > 0 &&
          !startsBlock(current, i)
        ) {
          items[items.length - 1]!.text += ` ${current.trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push(await renderList(items, images));
      continue;
    }

    // Paragraph: consecutive lines until a blank line or another block.
    const paragraph: string[] = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines[i]!, i)) {
      paragraph.push(lines[i]!);
      i++;
    }
    blocks.push(`<p>${await renderInline(paragraph.join(" "), images)}</p>`);
  }
  return blocks.join("");
}

/** Splits a run of items into same-kind runs and renders each. */
async function renderList(items: ListItem[], images: InlineImageSink): Promise<string> {
  let html = "";
  let run: ListItem[] = [];
  const flush = async () => {
    if (run.length === 0) return;
    html += await renderListRun(run, images);
    run = [];
  };
  // The run kind is the marker system, not just ordered-vs-bullet: a
  // numeric run and a lettered run are separate lists, and so are the
  // a / A / i / I systems among themselves.
  const runKey = (item: ListItem) => (item.ordered ? `ol:${item.listType}` : "ul");
  for (const item of items) {
    if (run.length > 0 && runKey(run[0]!) !== runKey(item)) await flush();
    run.push(item);
  }
  await flush();
  return html;
}

/**
 * The `<ol>` attributes carrying a list's marker semantics: the marker
 * type (omitted for the default numeric system) and the start (omitted
 * when 1, and outside the 1–9999 range sanitizeHtml would keep anyway).
 * The start comes from the run's first item only — later markers in the
 * source do not renumber the list.
 */
function orderedListAttrs(item: ListItem): string {
  let attrs = "";
  if (item.listType && item.listType !== "1") attrs += ` type="${item.listType}"`;
  if (item.value !== null && item.value > 1 && item.value <= 9999) {
    attrs += ` start="${item.value}"`;
  }
  return attrs;
}

/**
 * Renders one same-kind list run with one level of nesting (deeper
 * indents clamp to the first nested level, per spec D2). A run of
 * unordered items containing any task item becomes a task list — plain
 * items ride along as unchecked tasks, since Tiptap task lists can't
 * mix item types.
 */
async function renderListRun(items: ListItem[], images: InlineImageSink): Promise<string> {
  const baseIndent = Math.min(...items.map((item) => item.indent));
  const asTasks = !items[0]!.ordered && items.some((item) => item.task);
  const normalised = items.map((item) => ({
    ...item,
    indent: Math.min(item.indent, baseIndent + 1),
  }));

  const renderItems = async (list: ListItem[]): Promise<string> => {
    let out = "";
    let idx = 0;
    while (idx < list.length) {
      const item = list[idx]!;
      const children: ListItem[] = [];
      let next = idx + 1;
      while (next < list.length && list[next]!.indent > item.indent) {
        children.push(list[next]!);
        next++;
      }
      const textHtml = await renderInline(item.text, images);
      const childHtml = children.length > 0 ? await renderItems(children) : "";
      if (asTasks) {
        out +=
          `<li data-checked="${item.checked ? "true" : "false"}" data-type="taskItem">` +
          `<label><input type="checkbox"${item.checked ? ' checked="checked"' : ""}><span></span></label>` +
          `<div><p>${textHtml}</p>${childHtml}</div></li>`;
      } else {
        out += `<li><p>${textHtml}</p>${childHtml}</li>`;
      }
      idx = next;
    }
    if (asTasks) return `<ul data-type="taskList">${out}</ul>`;
    const first = list[0]!;
    if (!first.ordered) return `<ul>${out}</ul>`;
    return `<ol${orderedListAttrs(first)}>${out}</ol>`;
  };

  return renderItems(normalised);
}

/* -------- File-level parsing -------- */

function folderNameFromPath(path: string): string | null {
  const parts = normaliseImportPath(path).split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  return parts[parts.length - 2] ?? null;
}

function titleFromFileName(name: string): string {
  return baseName(name).replace(/\.(md|markdown|txt)$/i, "");
}

export async function parseMarkdownFiles(
  files: MarkdownFileInput[],
  resolver?: ImportImageResolver,
): Promise<ImportParseResult> {
  const result = emptyParseResult();
  for (const file of files) {
    if (result.notes.length >= MAX_IMPORT_NOTES) {
      result.skippedFiles.push({
        name: file.name,
        reason: "Import limit reached (5,000 notes per run).",
      });
      continue;
    }
    if (file.text.length > MAX_IMPORT_FILE_BYTES) {
      result.skippedFiles.push({ name: file.name, reason: "File is larger than 100 MB." });
      continue;
    }
    result.notes.push(await markdownFileToImportedNote(file, resolver, result));
  }
  return result;
}

async function markdownFileToImportedNote(
  file: MarkdownFileInput,
  resolver: ImportImageResolver | undefined,
  result: ImportParseResult,
): Promise<ImportedNote> {
  const images: ImportedImage[] = [];
  let imageSeq = 0;

  const sink: InlineImageSink = {
    addImage: async (alt, ref) => {
      // Remote images are never hot-linked into a note: Noma only
      // embeds local attachments, so an http(s)/data reference keeps
      // its alt text and is counted.
      if (/^(https?:|data:)/i.test(ref) || !resolver) {
        result.imagesUnresolved += 1;
        return escapeHtml(alt);
      }
      const resolved = await resolver(file.path, ref);
      if (
        !resolved ||
        !resolved.mimeType.startsWith("image/") ||
        resolved.blob.size > MAX_IMPORT_FILE_BYTES
      ) {
        result.imagesUnresolved += 1;
        return escapeHtml(alt);
      }
      const token = `%%NOMA_IMPORT_IMAGE_${imageSeq++}%%`;
      images.push({
        name: resolved.name,
        mimeType: resolved.mimeType,
        blob: resolved.blob,
        alt,
        token,
      });
      return token;
    },
  };

  const fallbackStamp = file.lastModified > 0 ? file.lastModified : Date.now();

  if (/\.txt$/i.test(file.name)) {
    return {
      title: titleFromFileName(file.name),
      contentHtml: plainTextToHtml(file.text),
      createdAt: fallbackStamp,
      updatedAt: fallbackStamp,
      pinned: false,
      archived: false,
      deleted: false,
      deletedAt: null,
      tagNames: [],
      folderName: folderNameFromPath(file.path),
      images,
      sourceName: file.name,
    };
  }

  const frontMatter = parseFrontMatter(file.text.replace(/^\uFEFF/, ""));
  let body = frontMatter.body;
  let title = frontMatter.title;

  // A leading H1 becomes the title when front matter didn't provide
  // one — and is consumed, not duplicated in the body.
  if (!title) {
    const h1 = body.match(/^\s*#\s+([^\n]+)/);
    if (h1) {
      title = h1[1]!.trim().replace(/\s+#+\s*$/, "");
      body = body.slice(h1[0].length);
    }
  }

  const contentHtml = await renderMarkdownBlocks(body, sink);
  const createdAt = frontMatter.createdAt ?? fallbackStamp;
  return {
    title: title || titleFromFileName(file.name),
    contentHtml,
    createdAt,
    updatedAt: createdAt,
    pinned: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    tagNames: frontMatter.tags,
    folderName: folderNameFromPath(file.path),
    images,
    sourceName: file.name,
  };
}

/** Parses a ZIP of Markdown/text files (the folder-in-a-ZIP case). */
export async function parseImportZip(
  data: Blob | Uint8Array | ArrayBuffer,
): Promise<ImportParseResult> {
  const result = emptyParseResult();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data as Blob);
  } catch {
    result.skippedFiles.push({
      name: "ZIP archive",
      reason: "That file couldn't be read as a ZIP archive.",
    });
    return result;
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const files: MarkdownFileInput[] = [];
  const imageFiles = new Map<string, { name: string; blob: Blob }>();

  for (const entry of entries) {
    if (/\.(md|markdown|txt)$/i.test(entry.name)) {
      try {
        const text = await entry.async("string");
        files.push({
          name: baseName(entry.name),
          path: entry.name,
          text,
          lastModified: entry.date ? entry.date.getTime() : 0,
        });
      } catch {
        result.skippedFiles.push({
          name: baseName(entry.name),
          reason: "Couldn't be read from the ZIP.",
        });
      }
    }
  }
  for (const entry of entries) {
    if (/\.(md|markdown|txt)$/i.test(entry.name)) continue;
    if (!mimeFromName(entry.name)) continue;
    try {
      const blob = await entry.async("blob");
      imageFiles.set(entry.name, { name: baseName(entry.name), blob });
    } catch {
      /* an unreadable image just leaves its references unresolved */
    }
  }

  const parsed = await parseMarkdownFiles(files, createImportImageResolver(imageFiles));
  return {
    notes: parsed.notes,
    skippedFiles: [...result.skippedFiles, ...parsed.skippedFiles],
    attachmentsSkipped: parsed.attachmentsSkipped,
    imagesUnresolved: parsed.imagesUnresolved,
    coloredNotes: parsed.coloredNotes,
  };
}

/* ---------------- Import engine ---------------- */

/** Dedupe key: the separator can't appear in the numeric timestamp, so
 * (title, createdAt) pairs are uniquely recoverable from the key. */
function dedupeKey(title: string, createdAt: number): string {
  return `${title} ${createdAt}`;
}

/**
 * Writes parsed notes into the library. Additive only: an incoming note
 * whose (title, createdAt) matches an existing note — in any state,
 * including trashed, and including notes created earlier in this same
 * run — is skipped as a duplicate.
 *
 * Content is written with a direct `db.notes.update` (sanitised +
 * word-counted here) rather than through `updateNote`: `updateNote`
 * would read the freshly created note's preserved old `updatedAt` as a
 * settled state and snapshot the empty initial content into version
 * history. Imported notes start with no history, exactly like a note
 * created in the editor.
 */
export async function importNotes(
  db: NomaDatabase,
  ownerId: string | null,
  imported: ImportedNote[],
  onProgress?: (done: number, total: number) => void,
): Promise<ImportReport> {
  void ownerId; // The DB handle is already per-account; kept for signature parity with the other engines.
  const report: ImportReport = { imported: 0, duplicates: 0, failed: 0, failedNames: [] };

  const existing = await db.notes.toArray();
  const seen = new Set(existing.map((note) => dedupeKey(note.title, note.createdAt)));

  const folderByName = new Map<string, string>();
  for (const folder of await db.folders.toArray()) {
    folderByName.set(folder.name.trim().toLowerCase(), folder.id);
  }
  const resolveFolderId = async (folderName: string | null): Promise<string | null> => {
    if (!folderName || !folderName.trim()) return null;
    const key = folderName.trim().toLowerCase();
    const existingId = folderByName.get(key);
    if (existingId) return existingId;
    const folder = await createFolder(db, folderName.trim());
    folderByName.set(key, folder.id);
    return folder.id;
  };

  const total = imported.length;
  let done = 0;
  for (const item of imported) {
    try {
      const key = dedupeKey(item.title, item.createdAt);
      if (seen.has(key)) {
        report.duplicates += 1;
      } else {
        const tagIds: string[] = [];
        for (const tagName of item.tagNames) {
          const tag = await createTag(db, tagName);
          if (!tagIds.includes(tag.id)) tagIds.push(tag.id);
        }
        const folderId = await resolveFolderId(item.folderName);

        const note = await createNote(db, {
          title: item.title,
          content: "",
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          pinned: item.pinned,
          archived: item.archived,
          deleted: item.deleted,
          deletedAt: item.deletedAt,
          folderId,
          tagIds,
        });

        let content = item.contentHtml;
        for (const image of item.images) {
          const file = new File([image.blob], image.name, { type: image.mimeType });
          try {
            const meta = await saveImageAttachment(db, note.id, file);
            const embed = `<img src="noma-attachment://${meta.id}" alt="${escapeAttr(image.alt || meta.name)}">`;
            if (image.token) {
              content = content.split(image.token).join(embed);
            } else {
              content += `<p>${embed}</p>`;
            }
          } catch {
            // The image itself failed to save (unreadable bytes etc.):
            // keep the alt text in its place rather than losing the note.
            if (image.token) content = content.split(image.token).join(escapeHtml(image.alt));
          }
        }

        const sanitised = sanitizeHtml(content);
        await db.notes.update(note.id, {
          content: sanitised,
          wordCount: countWords(sanitised),
        });
        seen.add(key);
        report.imported += 1;
      }
    } catch {
      report.failed += 1;
      report.failedNames.push(item.sourceName);
    }
    done += 1;
    onProgress?.(done, total);
  }
  return report;
}

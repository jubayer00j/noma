import { htmlToPlainText } from "./sanitize";
import type { Note } from "./types";

/**
 * Opt-in AI (roadmap #8) — bring-your-own-key Gemini features.
 *
 * Zero-cost by construction: Noma ships no shared key and runs no AI
 * server. The user pastes their own free-tier Gemini API key (AI
 * Studio), and every call goes straight from this device to Google
 * under that key. Calls happen ONLY inside user-initiated flows — the
 * two note actions (Summarize / Suggest tags) and the Settings
 * "Test connection" button. Nothing ambient, nothing automatic.
 *
 * The key lives in a per-account localStorage record (mirroring the
 * Drive connection and backup-encryption records). It NEVER enters
 * AppSettings: `collectBackup` writes the settings record into the
 * backup ZIP, so a key stored there would ride into Drive backups.
 * localStorage keeps it out of backups, out of sync, off other
 * devices — and `disconnectDrive` clears it on sign-out, alongside the
 * backup-encryption record.
 */

export const GEMINI_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_MODEL_LABEL = "Gemini 3.5 Flash-Lite (free tier)";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Prompt input budget: very long notes are middle-truncated (head+tail kept). */
export const AI_MAX_INPUT_CHARS = 24_000;

const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 40;

/* ---------------- Errors ---------------- */

export type AiErrorKind =
  | "no-key"
  | "invalid-key"
  | "rate-limited"
  | "offline"
  | "bad-response"
  | "empty";

/** One calm sentence per failure kind — shown verbatim in the UI. */
export const AI_ERROR_MESSAGES: Record<AiErrorKind, string> = {
  "no-key": "Add your Gemini API key in Settings to use AI.",
  "invalid-key": "That key didn't work — check it and try again.",
  "rate-limited": "Free-tier limit reached — try again in a little while.",
  offline: "You're offline — AI needs a connection.",
  "bad-response": "Gemini sent back something Noma couldn't read. Try again.",
  empty: "Gemini didn't return anything for this note. Try again.",
};

export class AiError extends Error {
  kind: AiErrorKind;
  constructor(kind: AiErrorKind, message: string = AI_ERROR_MESSAGES[kind]) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
  }
}

/* ---------------- Local record (per account, this device only) ---------------- */

/**
 * The whole AI configuration unit: the enable flag AND the key. Both
 * live here — never in AppSettings — so nothing AI-related can leak
 * into a backup or a sync payload.
 */
export interface AiSettings {
  enabled: boolean;
  apiKey: string;
  model?: string;
}

function localStore(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    /* storage unavailable (private mode, tests) */
  }
  return null;
}

/** Mirrors the Drive connection record's keying (`noma-drive-v1[-<uid>]`). */
function recordKey(ownerId: string | null): string {
  return ownerId ? `noma-ai-v1-${ownerId}` : "noma-ai-v1";
}

export function getAiSettings(ownerId: string | null): AiSettings | null {
  const store = localStore();
  if (!store) return null;
  try {
    const raw = store.getItem(recordKey(ownerId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    if (typeof parsed.apiKey !== "string") return null;
    return {
      enabled: parsed.enabled === true,
      apiKey: parsed.apiKey,
      ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
    };
  } catch {
    return null;
  }
}

export function saveAiSettings(ownerId: string | null, settings: AiSettings | null): void {
  const store = localStore();
  if (!store) return;
  try {
    if (settings) store.setItem(recordKey(ownerId), JSON.stringify(settings));
    else store.removeItem(recordKey(ownerId));
  } catch {
    /* storage unavailable — AI settings simply don't persist */
  }
}

export function clearAiSettings(ownerId: string | null): void {
  saveAiSettings(ownerId, null);
}

/* ---------------- Gating ---------------- */

/** Notes AI may never touch: locked (ciphertext), templates, trashed. */
export function noteEligibleForAi(
  note: Pick<Note, "lock" | "isTemplate" | "deleted">,
): boolean {
  return !note.lock && !note.isTemplate && !note.deleted;
}

/** The single predicate the note menu gates on: AI on + key saved + eligible note. */
export function aiActionsAvailable(
  note: Pick<Note, "lock" | "isTemplate" | "deleted">,
  settings: AiSettings | null,
): boolean {
  if (!settings?.enabled || !settings.apiKey.trim()) return false;
  return noteEligibleForAi(note);
}

/* ---------------- Text preparation ---------------- */

/**
 * Middle-truncation: keeps the head (60%) and tail (40%) of an
 * over-long text so both the opening and the conclusion survive, with
 * an elision marker the model can see.
 */
export function truncateMiddle(
  text: string,
  maxChars: number = AI_MAX_INPUT_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const headLength = Math.floor(maxChars * 0.6);
  const tailLength = maxChars - headLength;
  return {
    text: `${text.slice(0, headLength)}\n\n[… middle of the note omitted for length …]\n\n${text.slice(text.length - tailLength)}`,
    truncated: true,
  };
}

/** Note HTML → prompt-ready plain text (sanitize.ts extractor), capped per D2. */
export function prepareNoteText(html: string): { text: string; truncated: boolean } {
  return truncateMiddle(htmlToPlainText(html));
}

/* ---------------- Summary rendering (model output is untrusted) ---------------- */

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type SummaryBlock =
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[] };

/**
 * Parses the model's fixed plain-text format (summary paragraph(s),
 * then `- ` key-point lines) into blocks. Everything here stays plain
 * text — escaping happens at render/insert time, never before.
 */
export function parseSummaryBlocks(summary: string): SummaryBlock[] {
  const blocks: SummaryBlock[] = [];
  const paragraphs = summary
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  for (const paragraph of paragraphs) {
    const lines = paragraph
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    let textLines: string[] = [];
    let items: string[] = [];
    const flushText = () => {
      if (textLines.length) {
        blocks.push({ type: "paragraph", text: textLines.join(" ") });
        textLines = [];
      }
    };
    const flushItems = () => {
      if (items.length) {
        blocks.push({ type: "bullets", items });
        items = [];
      }
    };
    for (const line of lines) {
      const bullet = line.match(/^[-•*]\s+(.+)$/);
      if (bullet?.[1]) {
        flushText();
        items.push(bullet[1]);
      } else {
        flushItems();
        textLines.push(line);
      }
    }
    flushText();
    flushItems();
  }
  return blocks;
}

/**
 * Summary text → note HTML, escaped throughout (the style of
 * importers' plainTextToHtml). The result is only ever inserted via
 * `updateNote`, which sanitises again on the way in.
 */
export function summaryTextToHtml(summary: string): string {
  return parseSummaryBlocks(summary)
    .map((block) =>
      block.type === "paragraph"
        ? `<p>${escapeHtml(block.text)}</p>`
        : `<ul>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`,
    )
    .join("");
}

/* ---------------- Tag suggestion parsing ---------------- */

/**
 * Defensive parse of the model's tag reply: tolerates code fences and
 * surrounding prose, then validates — strings only, trimmed, no `#`
 * prefix, ≤ 40 chars, case-insensitive dedupe, tags already on the
 * note excluded, capped at 5. Anything unparseable yields [].
 */
export function parseTagSuggestions(raw: string, currentTagNames: string[] = []): string[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const current = new Set(
    currentTagNames.map((name) => name.trim().replace(/^#+/, "").toLowerCase()),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const clean = item.trim().replace(/^#+/, "").trim();
    if (!clean || clean.length > MAX_TAG_LENGTH) continue;
    const key = clean.toLowerCase();
    if (seen.has(key) || current.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/* ---------------- Gemini client (raw fetch, no SDK) ---------------- */

interface GenerateResult {
  text: string;
}

/**
 * One generateContent call. Endpoint + auth per Google's official API
 * reference: POST /v1beta/models/<model>:generateContent with the key
 * in the `x-goog-api-key` header; the reply text lives at
 * candidates[0].content.parts[].text.
 */
async function generateContent(apiKey: string, prompt: string, model: string): Promise<GenerateResult> {
  const key = apiKey.trim();
  if (!key) throw new AiError("no-key");
  let response: Response;
  try {
    response = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
  } catch {
    throw new AiError("offline");
  }
  if (response.status === 429) throw new AiError("rate-limited");
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new AiError("invalid-key");
  }
  if (!response.ok) throw new AiError("bad-response");
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new AiError("bad-response");
  }
  const candidates = (data as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) throw new AiError("bad-response");
  const parts = (candidates[0] as { content?: { parts?: unknown } } | undefined)?.content?.parts;
  if (!Array.isArray(parts)) {
    // A well-formed reply with no candidate content (e.g. the prompt
    // was blocked) is an empty result, not a malformed one.
    if (candidates.length === 0 || candidates[0] == null) throw new AiError("empty");
    throw new AiError("bad-response");
  }
  const text = parts
    .map((part) => {
      const value = (part as { text?: unknown } | null)?.text;
      return typeof value === "string" ? value : "";
    })
    .join("")
    .trim();
  if (!text) throw new AiError("empty");
  return { text };
}

function modelFor(settings: AiSettings | null): string {
  return settings?.model?.trim() || GEMINI_MODEL;
}

/** Settings "Test connection": one tiny call; resolves true, throws AiError otherwise. */
export async function testAiConnection(
  apiKey: string,
  settings: AiSettings | null = null,
): Promise<boolean> {
  await generateContent(apiKey, "Reply with the single word: ready", modelFor(settings));
  return true;
}

export interface SummarizeInput {
  title: string;
  text: string;
}

export interface SummarizeResult {
  summary: string;
  truncated: boolean;
}

export async function summarizeNote(
  apiKey: string,
  input: SummarizeInput,
  settings: AiSettings | null = null,
): Promise<SummarizeResult> {
  const prepared = truncateMiddle(input.text);
  if (!prepared.text.trim()) {
    throw new AiError("empty", "This note has no text for AI to work with.");
  }
  const prompt = [
    "You are summarizing a personal note for its author.",
    "",
    "Write the summary in exactly this plain-text format:",
    "- First, a summary of the note in 2 to 4 sentences.",
    '- Then, only if the note has clear key points, a blank line followed by up to 3 key points, each on its own line starting with "- ".',
    "",
    'Plain text only — no markdown headings, no bold, no preamble like "Here is a summary".',
    "",
    `Note title: ${input.title.trim() || "(untitled)"}`,
    "",
    "Note:",
    prepared.text,
  ].join("\n");
  const { text } = await generateContent(apiKey, prompt, modelFor(settings));
  return { summary: text, truncated: prepared.truncated };
}

export interface SuggestTagsInput {
  title: string;
  text: string;
  existingTagNames: string[];
  currentTagNames: string[];
}

export interface SuggestTagsResult {
  tags: string[];
  truncated: boolean;
}

export async function suggestTags(
  apiKey: string,
  input: SuggestTagsInput,
  settings: AiSettings | null = null,
): Promise<SuggestTagsResult> {
  const prepared = truncateMiddle(input.text);
  if (!prepared.text.trim() && !input.title.trim()) {
    throw new AiError("empty", "This note has no text for AI to work with.");
  }
  const prompt = [
    "You are suggesting tags for a personal note in a note-taking app.",
    "",
    "Rules:",
    "- Reply with a JSON array of tag name strings only — no other text, no markdown fences.",
    `- Suggest at most ${MAX_TAGS} tags.`,
    "- Prefer tags from the existing library list when they fit. Only invent a new tag when none of the existing ones fit.",
    '- Tags are short: one or two words, lowercase, no "#" prefix.',
    "- Do not repeat tags the note already has.",
    "",
    `Existing library tags: ${input.existingTagNames.length ? input.existingTagNames.join(", ") : "(none)"}`,
    `Tags already on this note: ${input.currentTagNames.length ? input.currentTagNames.join(", ") : "(none)"}`,
    "",
    `Note title: ${input.title.trim() || "(untitled)"}`,
    "",
    "Note:",
    prepared.text,
  ].join("\n");
  const { text } = await generateContent(apiKey, prompt, modelFor(settings));
  return { tags: parseTagSuggestions(text, input.currentTagNames), truncated: prepared.truncated };
}

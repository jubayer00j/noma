import { htmlToPlainText } from "./sanitize";
import type { Note } from "./types";

/**
 * Opt-in AI (roadmap #8) — bring-your-own-key features, now
 * multi-provider. The user picks a provider, pastes that provider's
 * key, and every call goes straight from this device to the chosen
 * provider under that key. Calls happen ONLY inside user-initiated
 * flows — the two note actions (Summarize / Suggest tags) and the
 * Settings "Test connection" button. Nothing ambient, nothing
 * automatic. (Semantic search, #8.5, follows the same rule: its
 * embedding calls happen only inside the user's explicit index
 * build/update, on their own note saves once they have opted in by
 * building an index, and on their own searches — see semantic.ts.)
 *
 * Two API shapes cover every major provider: Gemini's native API
 * (direct Google calls) and one OpenAI-compatible chat-completions
 * client (OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, xAI,
 * and any custom OpenAI-compatible endpoint). A native Anthropic
 * client is the named phase-2 follow-up; Anthropic is reachable
 * meanwhile through OpenRouter.
 *
 * The keys live in a per-account localStorage record (mirroring the
 * Drive connection and backup-encryption records). They NEVER enter
 * AppSettings: `collectBackup` writes the settings record into the
 * backup ZIP, so a key stored there would ride into Drive backups.
 * localStorage keeps them out of backups, out of sync, off other
 * devices — and `disconnectDrive` clears the record on sign-out,
 * alongside the backup-encryption record. The endpoint URL is not
 * secret; only keys are asserted absent from backups.
 *
 * Each provider preset keeps its OWN slot (key + model) in the one
 * record: switching providers can never send the previous provider's
 * key to the new one, and switching back restores that provider's key
 * untouched. Records written in the single-key format (PR #86) are
 * migrated losslessly on read — see normalizeAiRecord.
 */

export const GEMINI_MODEL = "gemini-3.5-flash-lite";
export const GEMINI_MODEL_LABEL = "Gemini 3.5 Flash-Lite (free tier)";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/* ---------------- Providers ---------------- */

export type AiProvider = "gemini" | "openai-compatible";

export interface AiPreset {
  id: string;
  label: string;
  /** OpenAI-compatible base URL; "" for Gemini (native API) and Custom. */
  baseUrl: string;
  /** Default model filled into the model field on preset select; "" for Custom. */
  defaultModel: string;
  /** Where to get a key; null when the preset has no single key page. */
  keyUrl: string | null;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenAI-compatible presets. Base URLs are the providers' documented
 * OpenAI-compatible endpoints; default models are long-lived ids the
 * user can overwrite — never a list, since new models appear weekly.
 * "custom" lets any other OpenAI-compatible endpoint in.
 */
export const OPENAI_PRESETS: AiPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: OPENROUTER_BASE_URL,
    defaultModel: "openai/gpt-4o-mini",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "together",
    label: "Together",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    keyUrl: "https://api.together.xyz/settings/api-keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  { id: "custom", label: "Custom endpoint", baseUrl: "", defaultModel: "", keyUrl: null },
];

/* ---------------- Embeddings capability (semantic search, #8.5) ---------------- */

/**
 * Whether a preset can serve embeddings, and the model to offer by
 * default. Verified against provider docs (2026-10-25): Gemini's
 * native `gemini-embedding-001`; OpenAI's and OpenRouter's standard
 * `/embeddings` endpoints. Groq and DeepSeek expose no embeddings
 * service at all ("none" — semantic search is honestly unavailable
 * there). Together, Mistral and Custom speak the compatible shape but
 * pin NO default: the user types the model id, unverified, the same
 * honesty rule as chat via Custom.
 */
export type EmbeddingMode = "native" | "compatible" | "none";

export interface EmbeddingCapability {
  mode: EmbeddingMode;
  defaultModel?: string;
}

export const EMBEDDING_CAPABILITIES: Record<string, EmbeddingCapability> = {
  gemini: { mode: "native", defaultModel: "gemini-embedding-001" },
  openai: { mode: "compatible", defaultModel: "text-embedding-3-small" },
  openrouter: { mode: "compatible", defaultModel: "openai/text-embedding-3-small" },
  groq: { mode: "none" },
  together: { mode: "compatible" },
  deepseek: { mode: "none" },
  mistral: { mode: "compatible" },
  custom: { mode: "compatible" },
};

export function embeddingCapabilityForPreset(presetId: string): EmbeddingCapability {
  return EMBEDDING_CAPABILITIES[presetId] ?? { mode: "none" };
}

/** Gemini embedding output size Noma pins (Matryoshka 768 of 3072/1536/768). */
export const GEMINI_EMBEDDING_DIMS = 768;

/** Normalizes a stored base URL: trimmed, no trailing slashes. */
export function normalizeBaseUrl(baseUrl: string | undefined): string {
  return (baseUrl ?? "").trim().replace(/\/+$/, "");
}

/** Which preset a stored record corresponds to ("custom" when the URL matches none). */
export function resolveAiPreset(
  provider: AiProvider | undefined,
  baseUrl: string | undefined,
): string {
  if (provider !== "openai-compatible") return "gemini";
  const normalized = normalizeBaseUrl(baseUrl);
  return (
    OPENAI_PRESETS.find(
      (preset) => preset.id !== "custom" && normalizeBaseUrl(preset.baseUrl) === normalized,
    )?.id ?? "custom"
  );
}

/**
 * True when a draft provider configuration differs from the saved
 * record — the "dirty" check behind the saved-key branch's "Save
 * provider settings" button. Comparison is on effective settings
 * only: a missing provider means Gemini, base URLs compare
 * normalized (trailing slashes ignored), models compare trimmed.
 * For Gemini there is no editable endpoint or model in the UI, so
 * provider equality decides; the key and the enable flag are not
 * provider settings and never make this true.
 */
export function aiProviderSettingsChanged(
  saved: AiSettings | null,
  candidate: AiSettings,
): boolean {
  const savedProvider = saved?.provider ?? "gemini";
  const candidateProvider = candidate.provider ?? "gemini";
  if (savedProvider !== candidateProvider) return true;
  if (candidateProvider !== "openai-compatible") return false;
  return (
    normalizeBaseUrl(saved?.baseUrl) !== normalizeBaseUrl(candidate.baseUrl) ||
    (saved?.model ?? "").trim() !== (candidate.model ?? "").trim()
  );
}

/**
 * True when a provider slot's draft differs from its saved slot —
 * the per-slot form of the dirty check, used by Settings for the
 * selected provider. Keys compare trimmed (calls trim anyway),
 * models compare trimmed with the preset default standing in for an
 * unset model (a slot that never stored a model IS on the default),
 * endpoints compare normalized. A missing slot and an empty slot are
 * the same thing.
 */
export function aiSlotChanged(
  saved: AiProviderSlot | undefined,
  candidate: AiProviderSlot | undefined,
  defaultModel = "",
  defaultEmbeddingModel = "",
): boolean {
  const savedKey = (saved?.apiKey ?? "").trim();
  const candidateKey = (candidate?.apiKey ?? "").trim();
  if (savedKey !== candidateKey) return true;
  const savedModel = (saved?.model ?? "").trim() || defaultModel;
  const candidateModel = (candidate?.model ?? "").trim() || defaultModel;
  if (savedModel !== candidateModel) return true;
  const savedEmbedding = (saved?.embeddingModel ?? "").trim() || defaultEmbeddingModel;
  const candidateEmbedding = (candidate?.embeddingModel ?? "").trim() || defaultEmbeddingModel;
  if (savedEmbedding !== candidateEmbedding) return true;
  return normalizeBaseUrl(saved?.baseUrl) !== normalizeBaseUrl(candidate?.baseUrl);
}

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
  | "empty"
  | "model-unavailable"
  | "transient"
  | "api-error";

/** One calm sentence per failure kind — shown verbatim in the UI. */
export const AI_ERROR_MESSAGES: Record<AiErrorKind, string> = {
  "no-key": "Add your Gemini API key in Settings to use AI.",
  "invalid-key": "That key didn't work — check it and try again.",
  "rate-limited": "Free-tier limit reached — try again in a little while.",
  offline: "You're offline — AI needs a connection.",
  "bad-response": "Gemini sent back something Noma couldn't read. Try again.",
  empty: "Gemini didn't return anything for this note. Try again.",
  "model-unavailable":
    "That Gemini model isn't available through the API right now. Try again later.",
  transient: "Gemini is busy right now — try again in a little while.",
  "api-error": "Gemini couldn't complete that request. Try again.",
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
 * The flat, effective shape every AI call consumes: the enable flag,
 * the ACTIVE provider's key, and — for OpenAI-compatible providers —
 * its endpoint + model. This is a projection of the stored record
 * (see projectAiSettings), never the storage format itself.
 */
export interface AiSettings {
  enabled: boolean;
  apiKey: string;
  model?: string;
  provider?: AiProvider;
  /** OpenAI-compatible endpoint; ignored for Gemini. Not secret — only keys are. */
  baseUrl?: string;
}

/**
 * One provider preset's saved state: its own key, its chosen model,
 * and — for the "custom" slot only — its endpoint URL (a named
 * preset's endpoint is a constant, not stored). Nothing here ever
 * leaves the device.
 */
export interface AiProviderSlot {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Embedding model id for semantic search (#8.5); per-slot like the chat model. */
  embeddingModel?: string;
}

/**
 * The stored record: ONE per account, holding the enable flag, which
 * preset is active, and a slot per preset id ("gemini", each
 * OPENAI_PRESETS id, "custom"). Per-slot keys are what make provider
 * switching safe: a provider only ever receives its own key.
 */
export interface AiRecord {
  enabled: boolean;
  activePreset: string;
  providers: Record<string, AiProviderSlot>;
}

/** Every preset id that can own a slot: "gemini" plus the preset table. */
const SLOT_IDS: string[] = ["gemini", ...OPENAI_PRESETS.map((preset) => preset.id)];

function cleanSlot(raw: unknown): AiProviderSlot | null {
  if (!raw || typeof raw !== "object") return null;
  const slot = raw as Partial<AiProviderSlot>;
  if (typeof slot.apiKey !== "string") return null;
  return {
    apiKey: slot.apiKey,
    ...(typeof slot.model === "string" && slot.model ? { model: slot.model } : {}),
    ...(typeof slot.baseUrl === "string" && slot.baseUrl
      ? { baseUrl: normalizeBaseUrl(slot.baseUrl) }
      : {}),
    ...(typeof slot.embeddingModel === "string" && slot.embeddingModel.trim()
      ? { embeddingModel: slot.embeddingModel.trim() }
      : {}),
  };
}

/**
 * Any stored value → the canonical record, or null when there is
 * nothing usable. Two input formats:
 *
 * - Current: { enabled, activePreset, providers: { <presetId>: slot } }.
 *   Unknown slot ids are dropped; an unknown activePreset falls back
 *   to "gemini".
 * - Legacy (PRs #69–#86): the flat { enabled, apiKey, provider?,
 *   baseUrl?, model? } single-key shape. It migrates losslessly: the
 *   key/model land in the slot for its provider ("gemini", or
 *   resolveAiPreset for OpenAI-compatible — an unmatched endpoint
 *   becomes "custom" and keeps its URL), and that slot becomes the
 *   active one. An unknown provider value means Gemini, as before.
 *
 * A legacy record with no string key is not a record at all (the old
 * reader returned null for it too). Normalizing a normalized record
 * returns it unchanged — migration is idempotent.
 */
export function normalizeAiRecord(raw: unknown): AiRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Record<string, unknown>;
  const enabled = parsed["enabled"] === true;

  const providersRaw = parsed["providers"];
  if (providersRaw && typeof providersRaw === "object" && !Array.isArray(providersRaw)) {
    const providers: Record<string, AiProviderSlot> = {};
    for (const [id, value] of Object.entries(providersRaw as Record<string, unknown>)) {
      if (!SLOT_IDS.includes(id)) continue;
      const slot = cleanSlot(value);
      if (slot) providers[id] = slot;
    }
    const activeRaw = parsed["activePreset"];
    return {
      enabled,
      activePreset:
        typeof activeRaw === "string" && SLOT_IDS.includes(activeRaw) ? activeRaw : "gemini",
      providers,
    };
  }

  if (typeof parsed["apiKey"] !== "string") return null;
  const provider: AiProvider =
    parsed["provider"] === "openai-compatible" ? "openai-compatible" : "gemini";
  const baseUrl = typeof parsed["baseUrl"] === "string" ? parsed["baseUrl"] : undefined;
  const presetId = resolveAiPreset(provider, baseUrl);
  const slot: AiProviderSlot = { apiKey: parsed["apiKey"] };
  if (typeof parsed["model"] === "string" && parsed["model"]) slot.model = parsed["model"];
  if (presetId === "custom" && baseUrl) slot.baseUrl = normalizeBaseUrl(baseUrl);
  return { enabled, activePreset: presetId, providers: { [presetId]: slot } };
}

/**
 * The stored record projected into the flat shape AI calls consume:
 * the ACTIVE slot's key, its provider family, and its endpoint +
 * model (a named preset's constant endpoint and default model fill
 * in when the slot never stored its own). Gemini records carry no
 * provider field — undefined has always meant Gemini here.
 */
export function projectAiSettings(record: AiRecord | null): AiSettings | null {
  if (!record) return null;
  const slot = record.providers[record.activePreset];
  if (record.activePreset === "gemini") {
    return {
      enabled: record.enabled,
      apiKey: slot?.apiKey ?? "",
      ...(slot?.model ? { model: slot.model } : {}),
    };
  }
  const preset = OPENAI_PRESETS.find((item) => item.id === record.activePreset);
  const baseUrl =
    record.activePreset === "custom" ? normalizeBaseUrl(slot?.baseUrl) : (preset?.baseUrl ?? "");
  const model = slot?.model?.trim() || preset?.defaultModel || "";
  return {
    enabled: record.enabled,
    apiKey: slot?.apiKey ?? "",
    provider: "openai-compatible",
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
  };
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

export function getAiRecord(ownerId: string | null): AiRecord | null {
  const store = localStore();
  if (!store) return null;
  try {
    const raw = store.getItem(recordKey(ownerId));
    if (!raw) return null;
    return normalizeAiRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveAiRecord(ownerId: string | null, record: AiRecord | null): void {
  const store = localStore();
  if (!store) return;
  try {
    if (record) store.setItem(recordKey(ownerId), JSON.stringify(record));
    else store.removeItem(recordKey(ownerId));
  } catch {
    /* storage unavailable — AI settings simply don't persist */
  }
}

/** The effective settings for the active provider (what note actions consume). */
export function getAiSettings(ownerId: string | null): AiSettings | null {
  return projectAiSettings(getAiRecord(ownerId));
}

/**
 * Flat-shape write, kept for single-provider callers and tests: the
 * settings land in their provider's slot (which becomes active) and
 * every other provider's slot is preserved untouched.
 */
export function saveAiSettings(ownerId: string | null, settings: AiSettings | null): void {
  if (!settings) {
    saveAiRecord(ownerId, null);
    return;
  }
  const presetId = resolveAiPreset(settings.provider, settings.baseUrl);
  const slot: AiProviderSlot = { apiKey: settings.apiKey };
  if (settings.model?.trim()) slot.model = settings.model;
  const embeddingModel = (settings as { embeddingModel?: unknown }).embeddingModel;
  if (typeof embeddingModel === "string" && embeddingModel.trim()) {
    slot.embeddingModel = embeddingModel.trim();
  }
  if (presetId === "custom") slot.baseUrl = normalizeBaseUrl(settings.baseUrl);
  saveAiRecord(ownerId, {
    enabled: settings.enabled,
    activePreset: presetId,
    providers: { ...(getAiRecord(ownerId)?.providers ?? {}), [presetId]: slot },
  });
}

export function clearAiSettings(ownerId: string | null): void {
  saveAiRecord(ownerId, null);
}

/* ---------------- Semantic search target (#8.5) ---------------- */

/**
 * Everything the semantic-search layer needs, resolved from the
 * stored record in one place: the projected settings for the ACTIVE
 * provider, that preset's id, its effective embedding model (the
 * slot's saved choice, else the preset's verified default), and how
 * it serves embeddings. Null when semantic search cannot run: AI off,
 * no key saved, the preset has no embeddings service, or no embedding
 * model is set for a preset that pins no default.
 */
export interface AiEmbeddingTarget {
  settings: AiSettings;
  presetId: string;
  embeddingModel: string;
  mode: "native" | "compatible";
}

export function getAiEmbeddingTarget(ownerId: string | null): AiEmbeddingTarget | null {
  const record = getAiRecord(ownerId);
  if (!record?.enabled) return null;
  const settings = projectAiSettings(record);
  if (!settings || !settings.apiKey.trim()) return null;
  const presetId = record.activePreset;
  const capability = embeddingCapabilityForPreset(presetId);
  if (capability.mode === "none") return null;
  const embeddingModel =
    record.providers[presetId]?.embeddingModel?.trim() || capability.defaultModel || "";
  if (!embeddingModel) return null;
  return { settings, presetId, embeddingModel, mode: capability.mode };
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
 * A provider's error envelope, when a failed call carries one. Only the
 * message string is ever surfaced — never the key, the URL, or the
 * rest of the body. Returns null when there is nothing usable: a
 * non-JSON body, no error message, or a message that echoes the key
 * itself (defensive — providers never do, but a surfaced message must
 * never become a key leak). Long messages are capped so the UI keeps
 * one calm line, not a pasted stack.
 */
async function readProviderErrorMessage(
  response: Response,
  key: string,
): Promise<string | null> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  const message =
    typeof error === "string" ? error : (error as { message?: unknown } | null)?.message;
  if (typeof message !== "string") return null;
  const clean = message.trim();
  if (!clean) return null;
  if (key && clean.includes(key)) return null;
  return clean.length > 240 ? `${clean.slice(0, 240)}…` : clean;
}

/**
 * One generateContent call. Endpoint + auth per Google's official API
 * reference: POST /v1beta/models/<model>:generateContent with the key
 * in the `x-goog-api-key` header; the reply text lives at
 * candidates[0].content.parts[].text.
 *
 * Error mapping, in order: network failure → offline; 429 →
 * rate-limited; 400/401/403 → invalid-key; 404 → model-unavailable
 * (named, so a retired model id is diagnosable instead of generic);
 * 500/502/503 → transient; any other non-OK status → Google's own
 * error message when one exists, else the generic bad-response line.
 * A 200 with the wrong shape stays bad-response — that genuinely is
 * unreadable.
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
  if (!response.ok) {
    if (response.status === 404) {
      throw new AiError(
        "model-unavailable",
        `The Gemini model "${model}" isn't available through the API right now. Try again later, or report the model name if it keeps failing.`,
      );
    }
    if (response.status === 500 || response.status === 502 || response.status === 503) {
      throw new AiError("transient");
    }
    const apiMessage = await readProviderErrorMessage(response, key);
    if (apiMessage) {
      throw new AiError(
        "api-error",
        `Gemini couldn't complete that request: ${apiMessage}`,
      );
    }
    throw new AiError("bad-response");
  }
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

/* ---------------- OpenAI-compatible client (raw fetch, no SDK) ---------------- */

/**
 * One OpenAI-compatible chat-completions call. Endpoint + auth per the
 * OpenAI API reference every preset follows: POST
 * <baseUrl>/chat/completions with a Bearer key, body {model,
 * messages:[{role:"user",content:prompt}]}, reply text at
 * choices[0].message.content (a string, or a parts array whose text
 * parts are joined). OpenRouter additionally gets the identification
 * headers its docs ask for. Error mapping mirrors the Gemini path's
 * kinds with provider-neutral messages: 401/403 → invalid-key, 429 →
 * rate-limited, 404 → model-unavailable (named), 5xx → transient,
 * anything else → the provider's own envelope message, else the
 * generic line. Config problems (no/insecure endpoint, no model) fail
 * before any fetch, with a message that says what to fix in Settings.
 */
async function generateChatCompletion(
  apiKey: string,
  baseUrl: string,
  model: string,
  prompt: string,
  openRouter: boolean,
): Promise<GenerateResult> {
  const key = apiKey.trim();
  if (!key) throw new AiError("no-key", "Add your API key in Settings to use AI.");
  const endpoint = normalizeBaseUrl(baseUrl);
  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    throw new AiError(
      "bad-response",
      "Set a provider endpoint URL starting with https:// in Settings.",
    );
  }
  const resolvedModel = model.trim();
  if (!resolvedModel) {
    throw new AiError("bad-response", "Choose a model for this provider in Settings.");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (openRouter) {
    headers["X-Title"] = "Noma";
    const referer = typeof window !== "undefined" ? window.location?.origin : undefined;
    if (referer) headers["HTTP-Referer"] = referer;
  }
  let response: Response;
  try {
    response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: resolvedModel,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    throw new AiError("offline");
  }
  if (response.status === 429) throw new AiError("rate-limited");
  if (response.status === 401 || response.status === 403) {
    throw new AiError("invalid-key");
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new AiError(
        "model-unavailable",
        `The model "${resolvedModel}" isn't available through this provider right now. Try again later, or report the model name if it keeps failing.`,
      );
    }
    if (response.status === 500 || response.status === 502 || response.status === 503) {
      throw new AiError(
        "transient",
        "The provider is busy right now — try again in a little while.",
      );
    }
    const apiMessage = await readProviderErrorMessage(response, key);
    if (apiMessage) {
      throw new AiError("api-error", `Couldn't complete that request: ${apiMessage}`);
    }
    throw new AiError(
      "bad-response",
      "The provider sent back something Noma couldn't read. Try again.",
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new AiError(
      "bad-response",
      "The provider sent back something Noma couldn't read. Try again.",
    );
  }
  const choices = (data as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) {
    throw new AiError(
      "bad-response",
      "The provider sent back something Noma couldn't read. Try again.",
    );
  }
  const content = (choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        const value = (part as { text?: unknown } | null)?.text;
        return typeof value === "string" ? value : "";
      })
      .join("");
  } else {
    text = "";
  }
  if (!text.trim()) {
    throw new AiError("empty", "The provider didn't return anything for this note. Try again.");
  }
  return { text: text.trim() };
}

/* ---------------- Embeddings client (semantic search, #8.5) ---------------- */

export type EmbedTask = "document" | "query";

/** AiSettings plus the embedding model to call (see getAiEmbeddingTarget). */
export interface EmbeddingSettings extends AiSettings {
  embeddingModel?: string;
}

const EMBED_BATCH_SIZE = 100;

/**
 * Model output is untrusted: a returned vector is only accepted when
 * it is a non-empty array of finite numbers with a non-zero norm.
 * Accepted vectors are L2-normalised here, once, so stored vectors
 * and query vectors alike support cosine-as-dot-product.
 */
function validateEmbeddingVector(raw: unknown, badResponseMessage: string): Float32Array {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AiError("bad-response", badResponseMessage);
  }
  const out = new Float32Array(raw.length);
  let norm = 0;
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AiError("bad-response", badResponseMessage);
    }
    out[i] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (!(norm > 0)) throw new AiError("bad-response", badResponseMessage);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}

/**
 * Gemini embeddings via :batchEmbedContents, chunked at 100 requests.
 * Each request pins the retrieval task type and the 768-dimension
 * Matryoshka output; returned vectors are validated and normalised
 * (required for reduced dimensions). Error mapping mirrors
 * generateContent's kinds.
 */
async function embedViaGemini(
  apiKey: string,
  model: string,
  texts: string[],
  task: EmbedTask,
): Promise<Float32Array[]> {
  const key = apiKey.trim();
  if (!key) throw new AiError("no-key");
  const cleanModel = model.replace(/^models\//, "");
  const taskType = task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
  const out: Float32Array[] = [];
  let dims = -1;
  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const chunk = texts.slice(start, start + EMBED_BATCH_SIZE);
    let response: Response;
    try {
      response = await fetch(`${GEMINI_API_BASE}/models/${cleanModel}:batchEmbedContents`, {
        method: "POST",
        headers: {
          "x-goog-api-key": key,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requests: chunk.map((text) => ({
            model: `models/${cleanModel}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: GEMINI_EMBEDDING_DIMS,
          })),
        }),
      });
    } catch {
      throw new AiError("offline");
    }
    if (response.status === 429) throw new AiError("rate-limited");
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new AiError("invalid-key");
    }
    if (!response.ok) {
      if (response.status === 404) {
        throw new AiError(
          "model-unavailable",
          `The Gemini embedding model "${cleanModel}" isn't available through the API right now. Try again later, or report the model name if it keeps failing.`,
        );
      }
      if (response.status === 500 || response.status === 502 || response.status === 503) {
        throw new AiError("transient");
      }
      const apiMessage = await readProviderErrorMessage(response, key);
      if (apiMessage) {
        throw new AiError("api-error", `Gemini couldn't complete that request: ${apiMessage}`);
      }
      throw new AiError("bad-response");
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AiError("bad-response");
    }
    const embeddings = (data as { embeddings?: unknown } | null)?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== chunk.length) {
      throw new AiError("bad-response");
    }
    for (const item of embeddings) {
      const vector = validateEmbeddingVector(
        (item as { values?: unknown } | null)?.values,
        AI_ERROR_MESSAGES["bad-response"],
      );
      if (dims === -1) dims = vector.length;
      else if (vector.length !== dims) throw new AiError("bad-response");
      out.push(vector);
    }
  }
  return out;
}

/**
 * OpenAI-compatible embeddings: POST <baseUrl>/embeddings with
 * {model, input: texts} — the standard shape OpenAI, OpenRouter and
 * friends serve — reply vectors at data[].embedding (ordered by
 * data[].index when present). Same auth/headers and error kinds as
 * the chat client. No silent fallbacks: an endpoint that rejects the
 * array form surfaces its error, per the #8.5 spec.
 */
async function embedViaCompatible(
  apiKey: string,
  baseUrl: string,
  model: string,
  texts: string[],
  openRouter: boolean,
): Promise<Float32Array[]> {
  const key = apiKey.trim();
  if (!key) throw new AiError("no-key", "Add your API key in Settings to use AI.");
  const endpoint = normalizeBaseUrl(baseUrl);
  if (!endpoint || !/^https:\/\//.test(endpoint)) {
    throw new AiError(
      "bad-response",
      "Set a provider endpoint URL starting with https:// in Settings.",
    );
  }
  const resolvedModel = model.trim();
  if (!resolvedModel) {
    throw new AiError("bad-response", "Choose an embedding model for this provider in Settings.");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  if (openRouter) {
    headers["X-Title"] = "Noma";
    const referer = typeof window !== "undefined" ? window.location?.origin : undefined;
    if (referer) headers["HTTP-Referer"] = referer;
  }
  let response: Response;
  try {
    response = await fetch(`${endpoint}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: resolvedModel, input: texts }),
    });
  } catch {
    throw new AiError("offline");
  }
  if (response.status === 429) throw new AiError("rate-limited");
  if (response.status === 401 || response.status === 403) {
    throw new AiError("invalid-key");
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw new AiError(
        "model-unavailable",
        `The embedding model "${resolvedModel}" isn't available through this provider right now. Try again later, or report the model name if it keeps failing.`,
      );
    }
    if (response.status === 500 || response.status === 502 || response.status === 503) {
      throw new AiError(
        "transient",
        "The provider is busy right now — try again in a little while.",
      );
    }
    const apiMessage = await readProviderErrorMessage(response, key);
    if (apiMessage) {
      throw new AiError("api-error", `Couldn't complete that request: ${apiMessage}`);
    }
    throw new AiError(
      "bad-response",
      "The provider sent back something Noma couldn't read. Try again.",
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new AiError(
      "bad-response",
      "The provider sent back something Noma couldn't read. Try again.",
    );
  }
  const items = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(items) || items.length !== texts.length) {
    throw new AiError(
      "bad-response",
      "The provider sent back something Noma couldn't read. Try again.",
    );
  }
  const ordered = [...items].sort((a, b) => {
    const ai = (a as { index?: unknown } | null)?.index;
    const bi = (b as { index?: unknown } | null)?.index;
    return typeof ai === "number" && typeof bi === "number" ? ai - bi : 0;
  });
  const out: Float32Array[] = [];
  let dims = -1;
  for (const item of ordered) {
    const vector = validateEmbeddingVector(
      (item as { embedding?: unknown } | null)?.embedding,
      "The provider sent back something Noma couldn't read. Try again.",
    );
    if (dims === -1) dims = vector.length;
    else if (vector.length !== dims) {
      throw new AiError(
        "bad-response",
        "The provider sent back something Noma couldn't read. Try again.",
      );
    }
    out.push(vector);
  }
  return out;
}

/**
 * Embed a batch of texts with the configured provider. `task` picks
 * the retrieval flavour ("document" for notes being indexed, "query"
 * for a search string); only Gemini's API distinguishes them. Every
 * returned vector is validated and L2-normalised. Throws AiError on
 * any failure — callers decide whether that is loud (index build) or
 * swallowed (search falls back to keyword-only).
 */
export async function embedTexts(
  settings: EmbeddingSettings | null,
  texts: string[],
  task: EmbedTask,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const apiKey = settings?.apiKey ?? "";
  if (settings?.provider === "openai-compatible") {
    const presetId = resolveAiPreset(settings.provider, settings.baseUrl);
    const capability = embeddingCapabilityForPreset(presetId);
    if (capability.mode === "none") {
      throw new AiError(
        "bad-response",
        "This provider has no embeddings service, so semantic search isn't available with it.",
      );
    }
    const endpoint = normalizeBaseUrl(settings.baseUrl);
    return embedViaCompatible(
      apiKey,
      endpoint,
      settings.embeddingModel?.trim() || capability.defaultModel || "",
      texts,
      endpoint === OPENROUTER_BASE_URL,
    );
  }
  const model =
    settings?.embeddingModel?.trim() ||
    embeddingCapabilityForPreset("gemini").defaultModel ||
    "gemini-embedding-001";
  return embedViaGemini(apiKey, model, texts, task);
}

/**
 * Single dispatch for every AI call: old records (no provider field)
 * and explicit "gemini" records take the native Gemini path; records
 * with provider "openai-compatible" take the chat-completions path
 * with their stored endpoint + model. Prompts never change.
 */
async function generateText(
  apiKey: string,
  prompt: string,
  settings: AiSettings | null,
): Promise<GenerateResult> {
  if (settings?.provider === "openai-compatible") {
    const endpoint = normalizeBaseUrl(settings.baseUrl);
    return generateChatCompletion(
      apiKey,
      endpoint,
      settings.model ?? "",
      prompt,
      endpoint === OPENROUTER_BASE_URL,
    );
  }
  return generateContent(apiKey, prompt, modelFor(settings));
}

/** Settings "Test connection": one tiny call; resolves true, throws AiError otherwise. */
export async function testAiConnection(
  apiKey: string,
  settings: AiSettings | null = null,
): Promise<boolean> {
  await generateText(apiKey, "Reply with the single word: ready", settings);
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
  const { text } = await generateText(apiKey, prompt, settings);
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
  const { text } = await generateText(apiKey, prompt, settings);
  return { tags: parseTagSuggestions(text, input.currentTagNames), truncated: prepared.truncated };
}


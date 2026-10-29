import {
  embeddingCapabilityForPreset,
  OPENAI_PRESETS,
  resolveAiPreset,
  type AiEmbeddingTarget,
  type AiSettings,
} from "./ai";
import type { AskCitation, AskExcerpt } from "./ask";
import type { SemanticIndexStatus } from "./semantic";

/**
 * Pure view logic for the Ask Noma screen (spec §4): which gate state the
 * screen is in, the in-memory thread's state transitions, and how a parsed
 * answer maps to citation chips and source cards. Kept free of React and
 * Dexie so every rule is unit-testable; the component (ask-view.tsx) only
 * wires these to the retrieval/generation seams in ask.ts and ai.ts.
 */

/**
 * The gate shown before (or instead of) the thread. Order matters — the
 * derivation checks configuration before index state, so a user without a
 * key never sees index copy, and a user whose provider has no embeddings
 * service gets that honest note instead of a Build button that can't help.
 */
export type AskGate =
  /** Index status hasn't loaded yet. */
  | "loading"
  /** AI is off or no key is saved — BYOK explainer + a route to Settings. */
  | "ai-off"
  /** The active preset has no embeddings service (Groq / DeepSeek). */
  | "no-embeddings"
  /** A compatible preset is active but no embedding model is chosen yet. */
  | "needs-embedding-model"
  /** No semantic index exists yet — Build control. */
  | "needs-index"
  /** The index was built for another provider/model/endpoint — Rebuild. */
  | "needs-rebuild"
  /** Vectors exist but the chunk half is missing (a pre-Ask index) — Update. */
  | "chunks-pending"
  /** The thread is usable. A stale notice may still ride on top of it. */
  | "ready";

export function deriveAskGate(input: {
  settings: AiSettings | null;
  target: AiEmbeddingTarget | null;
  indexStatus: SemanticIndexStatus | null;
}): AskGate {
  const { settings, target, indexStatus } = input;
  if (!settings?.enabled || !(settings.apiKey ?? "").trim()) return "ai-off";
  const presetId = resolveAiPreset(settings.provider, settings.baseUrl);
  if (embeddingCapabilityForPreset(presetId).mode === "none") return "no-embeddings";
  if (!target) return "needs-embedding-model";
  if (!indexStatus) return "loading";
  if (indexStatus.state === "not-built") return "needs-index";
  if (indexStatus.state === "invalid-provider") return "needs-rebuild";
  // A pre-chunk index has vectors but zero chunk rows while every note's
  // chunks read stale — Ask has literally nothing to retrieve until one
  // Update backfills them. (An empty library also has zero chunks, but
  // nothing is stale there, so it falls through to "ready" and every
  // question honestly lands on the no-evidence state.)
  if (indexStatus.chunkCount === 0 && indexStatus.chunksStaleCount > 0) return "chunks-pending";
  return "ready";
}

/** True when a ready index is behind the library — a quiet notice, never a gate. */
export function askIndexStale(status: SemanticIndexStatus | null): boolean {
  return status?.state === "ready" && (status.staleCount > 0 || status.chunksStaleCount > 0);
}

/**
 * The provider's display name for the disclosure line, mirroring the
 * Settings AI section's naming (Google Gemini / preset label / your custom
 * endpoint) so the two surfaces never disagree about who received text.
 */
export function askProviderName(settings: AiSettings | null): string {
  if (!settings) return "this provider";
  const presetId = resolveAiPreset(settings.provider, settings.baseUrl);
  if (presetId === "gemini") return "Google Gemini";
  if (presetId === "custom") return "your custom endpoint";
  return OPENAI_PRESETS.find((preset) => preset.id === presetId)?.label ?? "this provider";
}

/** The §4 disclosure sentence, worded for the excerpts actually sent. */
export function askDisclosureLine(sentExcerpts: AskExcerpt[], providerName: string): string {
  const notes = new Set(sentExcerpts.map((excerpt) => excerpt.noteId)).size;
  return `Sent excerpts from ${notes} note${notes === 1 ? "" : "s"} to ${providerName}. Your index and notes stay on this device.`;
}

// ---------------------------------------------------------------------------
// Thread state — memory only (spec §2: no Dexie table, no localStorage).
// ---------------------------------------------------------------------------

export type AskAnswerStatus = "answer" | "refusal" | "no-evidence" | "error";

export interface AskAnswerEntry {
  kind: "answer";
  id: number;
  status: AskAnswerStatus;
  /** Parsed answer text — only for status "answer". */
  text: string;
  citations: AskCitation[];
  /**
   * The excerpts actually sent to the provider (post-budget), so source
   * cards and the disclosure describe the real prompt, not the wider
   * retrieval. Empty when no provider call happened.
   */
  sentExcerpts: AskExcerpt[];
  /** The disclosure line for this exchange, or null when nothing was sent. */
  disclosure: string | null;
  /** Calm AiError copy — only for status "error". */
  errorMessage: string | null;
}

export type AskThreadEntry = { kind: "question"; id: number; text: string } | AskAnswerEntry;

export interface AskThreadState {
  entries: AskThreadEntry[];
  busy: boolean;
  nextId: number;
}

export const initialAskThreadState: AskThreadState = { entries: [], busy: false, nextId: 1 };

export type AskThreadAction =
  | { type: "submitted"; question: string }
  | { type: "answered"; entry: Omit<AskAnswerEntry, "kind" | "id"> }
  | { type: "cleared" };

export function askThreadReducer(state: AskThreadState, action: AskThreadAction): AskThreadState {
  switch (action.type) {
    case "submitted":
      // One question in flight at a time — the reducer refuses a second
      // submit rather than trusting every caller to disable its button.
      if (state.busy) return state;
      return {
        entries: [...state.entries, { kind: "question", id: state.nextId, text: action.question }],
        busy: true,
        nextId: state.nextId + 1,
      };
    case "answered":
      return {
        entries: [...state.entries, { ...action.entry, kind: "answer", id: state.nextId }],
        busy: false,
        nextId: state.nextId + 1,
      };
    case "cleared":
      return initialAskThreadState;
  }
}

/**
 * The follow-up context for the next question (§3): only the immediately
 * previous exchange, and only when it actually produced an answer — a
 * refusal, a no-evidence result or an error is not conversation the model
 * should build on, and anything older than one turn is out of scope for v1.
 */
export function previousTurnOf(
  entries: AskThreadEntry[],
): { question: string; answer: string } | undefined {
  const answer = entries[entries.length - 1];
  const question = entries[entries.length - 2];
  if (answer?.kind !== "answer" || question?.kind !== "question") return undefined;
  if (answer.status !== "answer") return undefined;
  return { question: question.text, answer: answer.text };
}

// ---------------------------------------------------------------------------
// Answer rendering: citation chips and source cards.
// ---------------------------------------------------------------------------

export type AskTextSegment =
  | { kind: "text"; text: string }
  | { kind: "citation"; n: number; noteId: string; chunkIndex: number };

/**
 * Split answer text into plain runs and citation chips. Only numbers the
 * parser validated (they arrive in `citations`) become chips — anything
 * else that merely looks like [n] stays literal text, so a chip can never
 * point at a source the answer didn't earn.
 */
export function citationSegments(text: string, citations: AskCitation[]): AskTextSegment[] {
  const byNumber = new Map(citations.map((citation) => [citation.n, citation]));
  const segments: AskTextSegment[] = [];
  const pattern = /\[(\d{1,3})\]/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const citation = byNumber.get(Number(match[1]));
    if (!citation) continue;
    if (match.index > last) segments.push({ kind: "text", text: text.slice(last, match.index) });
    segments.push({
      kind: "citation",
      n: citation.n,
      noteId: citation.noteId,
      chunkIndex: citation.chunkIndex,
    });
    last = match.index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  if (segments.length === 0) segments.push({ kind: "text", text });
  return segments;
}

export interface AskSourceCard {
  noteId: string;
  chunkIndex: number;
  title: string;
  text: string;
}

/**
 * One source card per cited note (§4), in citation order — a note cited
 * through two chunks still gets one card, snippeted from its first cited
 * chunk. The excerpt text comes from the excerpts actually sent, so the
 * snippet is the exact passage the model saw; a citation whose excerpt
 * is missing (defensive — the parser only emits citations into the sent
 * list) is dropped, never rendered as an empty card.
 */
export function sourceCardsFor(
  sentExcerpts: AskExcerpt[],
  citations: AskCitation[],
): AskSourceCard[] {
  const cards: AskSourceCard[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    if (seen.has(citation.noteId)) continue;
    const excerpt = sentExcerpts.find(
      (item) => item.noteId === citation.noteId && item.chunkIndex === citation.chunkIndex,
    );
    if (!excerpt) continue;
    seen.add(citation.noteId);
    cards.push({
      noteId: excerpt.noteId,
      chunkIndex: excerpt.chunkIndex,
      title: excerpt.title,
      text: excerpt.text,
    });
  }
  return cards;
}

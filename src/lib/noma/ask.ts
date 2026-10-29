import {
  AI_MAX_INPUT_CHARS,
  embedTexts,
  noteEligibleForAi,
  truncateMiddle,
  type AiEmbeddingTarget,
  type EmbeddingSettings,
} from "./ai";
import type { NomaDatabase } from "./db";
import { SEMANTIC_THRESHOLD, chunkNoteText, fnv1a, providerKeyFor } from "./semantic";
import type { Note } from "./types";

/**
 * Ask Noma — retrieval, prompt assembly and answer parsing (spec §2).
 *
 * The chunk index (PR-A) holds one vector per ~700-char passage of
 * every eligible note. This module turns a question into at most six
 * excerpts from that index, assembles the grounded prompt inside the
 * same character budget every other AI feature obeys, and parses the
 * model's reply into a typed result whose citations can only point at
 * excerpts that were actually sent. Generation itself lives behind
 * the `askNotes` seam in ai.ts; the Ask view is PR-C. Nothing here is
 * ambient: every function runs only because the user asked a question.
 */

/**
 * The exact sentence the model must reply with when the excerpts do
 * not answer the question — and the string the parser keys on. The UI
 * renders its own honest empty state from the typed refusal; this
 * sentence itself is never presented as an "answer".
 */
export const ASK_REFUSAL_SENTENCE = "I couldn't find that in your notes.";

/** At most this many excerpts ride along in one prompt. */
export const ASK_MAX_EXCERPTS = 6;
/** At most this many chunks from any single note — diversity beats depth. */
export const ASK_MAX_EXCERPTS_PER_NOTE = 2;
/** Character sub-budget for excerpt text inside the overall AI cap. */
export const ASK_EXCERPT_BUDGET_CHARS = 16_000;
/** Character cap for the optional previous Q/A pair (context, never evidence). */
export const ASK_PREVIOUS_TURN_BUDGET_CHARS = 2_000;

/** One retrieved passage, ready to be numbered into a prompt. */
export interface AskExcerpt {
  noteId: string;
  chunkIndex: number;
  /** The source note's title, as it stood at retrieval time. */
  title: string;
  /** The chunk's plain text. */
  text: string;
  /** Dot-product similarity against the question (index vectors are L2-normalised). */
  similarity: number;
}

/** A validated citation: excerpt number `n` in the prompt ↔ its source chunk. */
export interface AskCitation {
  n: number;
  noteId: string;
  chunkIndex: number;
}

export type AskAnswerResult =
  | { status: "answer"; text: string; citations: AskCitation[] }
  | { status: "refusal" }
  | { status: "no-evidence" };

/**
 * What `parseAskAnswer` can return. "no-evidence" is decided before
 * any provider call, so it is not among the parser's outcomes.
 */
export type ParsedAskAnswer = Exclude<AskAnswerResult, { status: "no-evidence" }>;

/* ---------------- Retrieval ---------------- */

/** Same embedding-settings projection semantic.ts builds for a target. */
function embeddingSettings(target: AiEmbeddingTarget): EmbeddingSettings {
  return { ...target.settings, embeddingModel: target.embeddingModel };
}

/**
 * Scores the chunk index against the question and returns the best
 * eligible excerpts, best first. A row only scores when it belongs to
 * the target's embedding space (its stored providerKey equals the
 * key this target writes today — the prefix identity plus its dims),
 * its vector length matches the query vector, AND its note is in the
 * caller's live list and eligible *right now*: a note locked, trashed
 * or deleted after indexing is dropped however high it scores, so a
 * stale chunk can never surface text the user has since locked away.
 * Freshness is validated too: a surviving row must still be exactly a
 * chunk of the note's current text (same chunk index, same content
 * hash — the index's own identity mechanism). Save-time re-embedding
 * is best-effort and fails silently, so an edited note can leave stale
 * rows behind; without this check Ask would quote text the user has
 * since removed or rewritten as if it were current.
 */
export async function retrieveChunks(
  db: NomaDatabase,
  question: string,
  target: AiEmbeddingTarget | null,
  notesById: ReadonlyMap<string, Note>,
): Promise<AskExcerpt[]> {
  if (!target || !question.trim()) return [];
  // A database opened before the v6 upgrade may not carry the table.
  const table = db.noteChunks ?? null;
  if (!table) return [];
  const rows = await table.toArray();
  if (rows.length === 0) return [];
  const [queryVector] = await embedTexts(embeddingSettings(target), [question], "query");
  if (!queryVector) return [];

  const scored: AskExcerpt[] = [];
  const rowHashes = new Map<string, string>();
  for (const row of rows) {
    if (row.providerKey !== providerKeyFor(target, row.dims)) continue;
    if (row.vector.length !== queryVector.length) continue;
    const note = notesById.get(row.noteId);
    if (!note || !noteEligibleForAi(note)) continue;
    let dot = 0;
    for (let i = 0; i < row.vector.length; i++) {
      dot += row.vector[i]! * queryVector[i]!;
    }
    if (dot < SEMANTIC_THRESHOLD) continue;
    rowHashes.set(row.id, row.contentHash);
    scored.push({
      noteId: row.noteId,
      chunkIndex: row.chunkIndex,
      title: note.title,
      text: row.text,
      similarity: dot,
    });
  }
  // Best first; note id + chunk index break ties so the order (and
  // therefore the citation numbering) is deterministic.
  scored.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : a.chunkIndex - b.chunkIndex),
  );

  // Freshness, per candidate note, computed at most once: the content
  // hash of each chunk of the note's CURRENT text, by chunk index.
  const freshHashes = new Map<string, Map<number, string>>();
  const currentChunkHashes = (note: Note): Map<number, string> => {
    let hashes = freshHashes.get(note.id);
    if (!hashes) {
      hashes = new Map(chunkNoteText(note).map((text, index) => [index, fnv1a(text)]));
      freshHashes.set(note.id, hashes);
    }
    return hashes;
  };

  const perNote = new Map<string, number>();
  const out: AskExcerpt[] = [];
  for (const item of scored) {
    if (out.length >= ASK_MAX_EXCERPTS) break;
    const note = notesById.get(item.noteId)!;
    if (
      currentChunkHashes(note).get(item.chunkIndex) !==
      rowHashes.get(`${item.noteId}#${item.chunkIndex}`)
    )
      continue;
    const count = perNote.get(item.noteId) ?? 0;
    if (count >= ASK_MAX_EXCERPTS_PER_NOTE) continue;
    perNote.set(item.noteId, count + 1);
    out.push(item);
  }
  return out;
}

/* ---------------- Prompt assembly ---------------- */

/**
 * `truncateMiddle`'s elision marker adds ~48 chars beyond the cap it
 * is given, so budget calls in this module leave room for it — the
 * caps here are hard caps, not approximations.
 */
const ELISION_ALLOWANCE = 64;

function truncateTo(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return truncateMiddle(text, Math.max(1, maxChars - ELISION_ALLOWANCE)).text;
}

const ASK_INSTRUCTIONS = [
  "You are Ask Noma, answering a question using only excerpts from the user's own notes.",
  "",
  "Rules:",
  "- Answer using ONLY the numbered excerpts below. Do not use outside knowledge.",
  "- Cite every claim with its excerpt number, like [1].",
  `- If the excerpts do not answer the question, reply with exactly this sentence and nothing else: ${ASK_REFUSAL_SENTENCE}`,
  "- Answer in the language of the question.",
  "- Be concise.",
].join("\n");

export interface AskPrompt {
  prompt: string;
  /**
   * The excerpts actually included, in prompt order. Citation numbers
   * in the model's reply index into this list — budget trimming may
   * have dropped (or, for a lone oversized chunk, truncated) some of
   * the retrieved excerpts.
   */
  excerpts: AskExcerpt[];
}

/**
 * Assembles the grounded prompt. Budgets, in order: excerpt text is
 * capped at ASK_EXCERPT_BUDGET_CHARS by dropping the lowest-ranked
 * chunks whole (a chunk is never cut mid-text; a lone chunk that
 * still cannot fit is middle-truncated, elision marker visible to
 * the model); the whole prompt is capped at AI_MAX_INPUT_CHARS by
 * the same shedding, then by truncation. The previous Q/A pair, when
 * given, is added only with whatever budget remains after excerpts,
 * truncated to ASK_PREVIOUS_TURN_BUDGET_CHARS and labelled as
 * conversation — never as evidence.
 */
export function buildAskPrompt(
  question: string,
  excerpts: AskExcerpt[],
  previousTurn?: { question: string; answer: string },
): AskPrompt {
  let used = [...excerpts];

  const excerptChars = (list: AskExcerpt[]) =>
    list.reduce((sum, excerpt) => sum + excerpt.text.length, 0);
  while (used.length > 1 && excerptChars(used) > ASK_EXCERPT_BUDGET_CHARS) used.pop();
  if (used.length === 1 && used[0]!.text.length > ASK_EXCERPT_BUDGET_CHARS) {
    used = [{ ...used[0]!, text: truncateTo(used[0]!.text, ASK_EXCERPT_BUDGET_CHARS) }];
  }

  const excerptBlock = (list: AskExcerpt[]) =>
    list.map((excerpt, i) => `[${i + 1}] From "${excerpt.title}": ${excerpt.text}`).join("\n\n");

  const assemble = (list: AskExcerpt[], conversation: string | null, q: string) =>
    [
      ASK_INSTRUCTIONS,
      ...(conversation ? ["", conversation] : []),
      "",
      "Excerpts from the user's notes:",
      excerptBlock(list),
      "",
      `Question: ${q}`,
    ].join("\n");

  let prompt = assemble(used, null, question);
  while (used.length > 1 && prompt.length > AI_MAX_INPUT_CHARS) {
    used.pop();
    prompt = assemble(used, null, question);
  }
  if (used.length === 1 && prompt.length > AI_MAX_INPUT_CHARS) {
    // One excerpt left and still over: shrink its text to whatever
    // room the fixed parts leave (the sub-budget pass above means
    // this needs a very long question, not a very long chunk).
    const room = AI_MAX_INPUT_CHARS - (prompt.length - used[0]!.text.length);
    const text =
      room <= 0
        ? ""
        : room < used[0]!.text.length
          ? truncateTo(used[0]!.text, room)
          : used[0]!.text;
    used = [{ ...used[0]!, text }];
    prompt = assemble(used, null, question);
  }
  if (prompt.length > AI_MAX_INPUT_CHARS) {
    // The question itself is the overflow (defensive; unreachable
    // from the UI): middle-truncate it so the cap always holds.
    const room = Math.max(0, AI_MAX_INPUT_CHARS - (prompt.length - question.length));
    prompt = assemble(used, null, truncateTo(question, room));
  }

  if (previousTurn) {
    const raw = [
      "Earlier conversation (context only — not evidence):",
      `Q: ${previousTurn.question}`,
      `A: ${previousTurn.answer}`,
    ].join("\n");
    const capped =
      raw.length > ASK_PREVIOUS_TURN_BUDGET_CHARS
        ? truncateTo(raw, ASK_PREVIOUS_TURN_BUDGET_CHARS)
        : raw;
    const withConversation = assemble(used, capped, question);
    if (withConversation.length <= AI_MAX_INPUT_CHARS) prompt = withConversation;
  }

  return { prompt, excerpts: used };
}

/* ---------------- Answer parsing ---------------- */

/**
 * Turns the model's raw reply into a typed result. The refusal
 * sentence (matched at the head of the whitespace-normalised reply)
 * is a refusal. Otherwise, `[n]` citations are validated against the
 * excerpts actually sent: an out-of-range number is a hallucination
 * and is stripped from the text, never rendered; valid citations are
 * returned deduplicated in first-use order, mapped back to their
 * source note + chunk. A reply with NO valid citation at all is not
 * an answer either: Ask's promise is grounded-or-silent, and text the
 * model produced without citing any excerpt it was given is
 * indistinguishable from an ungrounded invention, so it degrades to
 * the same refusal the view renders honestly. The text is otherwise
 * the model's own words — rendering it safely is the view's job
 * (PR-C), exactly as with summaries.
 */
export function parseAskAnswer(raw: string, excerpts: AskExcerpt[]): ParsedAskAnswer {
  const normalized = raw.trim().replace(/\s+/g, " ");
  if (normalized.startsWith(ASK_REFUSAL_SENTENCE)) return { status: "refusal" };

  const citations: AskCitation[] = [];
  const seen = new Set<number>();
  const text = raw
    .replace(/\[(\d+)\]/g, (match, digits: string) => {
      const n = Number(digits);
      if (n < 1 || n > excerpts.length) return "";
      if (!seen.has(n)) {
        seen.add(n);
        const excerpt = excerpts[n - 1]!;
        citations.push({ n, noteId: excerpt.noteId, chunkIndex: excerpt.chunkIndex });
      }
      return match;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  if (citations.length === 0) return { status: "refusal" };
  return { status: "answer", text, citations };
}

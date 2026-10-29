import {
  AiError,
  embedTexts,
  getAiEmbeddingTarget,
  normalizeBaseUrl,
  noteEligibleForAi,
  type AiEmbeddingTarget,
} from "./ai";
import type { NomaDatabase } from "./db";
import { notePreviewText } from "./note-export";
import { htmlToPlainText } from "./sanitize";
import type { SearchResult } from "./search";
import type { Note, NoteChunk, NoteEmbedding } from "./types";

/**
 * Semantic search (#8.5) — a meaning-based layer over the existing
 * keyword search. Notes are embedded once into vectors by the user's
 * chosen AI provider (see ai.ts `embedTexts`), stored in the local
 * `noteEmbeddings` table (Dexie v5), and a search query is embedded
 * and compared by cosine similarity, blended into the keyword score.
 *
 * The #8 rules carry over verbatim:
 *
 * - Opt-in, BYOK: nothing here runs until the user explicitly builds
 *   an index in Settings. After that opt-in, maintenance happens only
 *   inside the user's own flows — their note saves, their searches,
 *   their Build/Update taps. Nothing ambient, nothing scheduled.
 * - Eligibility is `noteEligibleForAi`: locked, template and trashed
 *   notes are NEVER embedded and never surfaced semantically.
 * - Vectors are derived data: local-only, never in backups, never
 *   synced (the table is excluded from collectBackup by construction
 *   and from copyDatabase by its explicit table list). A provider,
 *   endpoint or embedding-model change invalidates the index — vectors
 *   from two embedding spaces are never mixed or compared.
 *
 * Ask Noma (chunk index) — alongside the per-note vectors, each note's
 * text is also split into overlapping chunks with a vector per chunk
 * (Dexie v6 `noteChunks`), fine-grained enough for grounded answers
 * with passage-level citations. The chunk half obeys every rule above:
 * same eligibility, same providerKey identity, same local-only status,
 * and it is built, reconciled, maintained and invalidated in the SAME
 * pass as the note vectors — one Build/Update action maintains both.
 *
 * Any failure in this layer (offline, quota, bad key) degrades search
 * to keyword-only; searchNotes itself is untouched.
 */

/** Per-note text budget for embedding (Gemini's 2048-token cap, Bengali-safe). */
export const EMBED_MAX_CHARS = 6000;
/** Cosine similarity a note must reach to earn a semantic contribution. */
export const SEMANTIC_THRESHOLD = 0.5;

/**
 * Per-model similarity floors, resolved by `similarityFloorFor` and
 * used by every similarity consumer (Ask retrieval, search merge) so
 * the two never disagree about the same index. Calibrated on a
 * measured EN/BN matrix (2026-10-29, 4 notes × 8 questions, spec at
 * ~/workspace/projects/noma-embedding-threshold-calibration-spec.md):
 * gemini-embedding-001's true matches land 0.71–0.78, so it keeps the
 * 0.5 default; text-embedding-3-large's matches land 0.41–0.78 with
 * unrelated controls ≤ 0.36 at native dims, so it gets 0.38. Models
 * not listed keep 0.5 — notably text-embedding-3-small, whose
 * cross-language matches (0.07–0.34) score BELOW an unrelated control
 * (0.45): no lower floor is defensible for it, which is why the
 * OpenAI/OpenRouter slots now default to 3-large instead.
 */
const SIMILARITY_FLOORS: Record<string, number> = {
  "text-embedding-3-large": 0.38,
};

/**
 * The similarity floor for an embedding model id. Vendor prefixes
 * are stripped first ("openai/text-embedding-3-large" via OpenRouter
 * is the same model as "text-embedding-3-large" via OpenAI), and
 * unknown models get the SEMANTIC_THRESHOLD default.
 */
export function similarityFloorFor(embeddingModel: string): number {
  const bare = embeddingModel.trim().toLowerCase().split("/").pop() ?? "";
  return SIMILARITY_FLOORS[bare] ?? SEMANTIC_THRESHOLD;
}
/** Weight of a semantic hit: similarity 0.8 ≈ a title keyword hit (6). */
export const SEMANTIC_WEIGHT = 10;

/** Notes are embedded in groups so a build can report progress and cancel. */
const EMBED_GROUP_SIZE = 25;

/** FNV-1a (hex) — the same hash family sync.ts uses for content hashes. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The exact text a note is embedded as: title, then the body's plain text, head-kept. */
export function embeddedTextForNote(note: Pick<Note, "title" | "content">): string {
  return `${note.title}\n${htmlToPlainText(note.content)}`.slice(0, EMBED_MAX_CHARS);
}

/**
 * The endpoint segment of the embedding-space identity: the normalized
 * base URL for an OpenAI-compatible target — for the Custom preset
 * that URL is the user's own, so repointing it at another server is a
 * different embedding space even when the model name stays the same —
 * or the constant "native" for Gemini's native API, whose endpoint is
 * fixed by the provider.
 */
function identityEndpoint(target: AiEmbeddingTarget): string {
  return target.mode === "compatible" ? normalizeBaseUrl(target.settings.baseUrl) : "native";
}

/** The identity of the embedding space a target writes into, minus dims. */
function identityPrefix(target: AiEmbeddingTarget): string {
  return `${target.presetId}|${identityEndpoint(target)}|${target.embeddingModel}|`;
}

/**
 * "<slotId>|<endpoint>|<embeddingModel>|<dims>" — the full providerKey
 * stored per row. Segments are "|"-joined because the endpoint segment
 * itself contains ":" and "/" (a URL), which the old ":"-joined format
 * could neither hold nor parse back.
 */
export function providerKeyFor(target: AiEmbeddingTarget, dims: number): string {
  return `${identityPrefix(target)}${dims}`;
}

function embeddingSettings(target: AiEmbeddingTarget) {
  return { ...target.settings, embeddingModel: target.embeddingModel };
}

/** noteId → the text+hash the index should hold for it (eligible, non-empty notes only). */
function desiredEmbeddings(notes: Note[]): Map<string, { text: string; hash: string }> {
  const out = new Map<string, { text: string; hash: string }>();
  for (const note of notes) {
    if (!noteEligibleForAi(note)) continue;
    const text = embeddedTextForNote(note);
    if (!text.trim()) continue;
    out.set(note.id, { text, hash: fnv1a(text) });
  }
  return out;
}

/* ---------------- Chunking (Ask Noma) ---------------- */

/** Target size of one chunk, in characters. */
export const CHUNK_MAX_CHARS = 700;
/** How much of the previous chunk's tail each chunk repeats, in characters. */
export const CHUNK_OVERLAP_CHARS = 100;

/**
 * One piece of a text being chunked: the piece itself plus the joiner
 * that belongs in front of it when it is appended to a non-empty
 * chunk — "\n" across a paragraph break, " " across a sentence
 * break, "" across a hard split — so a packed chunk reads like the
 * original text instead of a re-glued one.
 */
interface ChunkSegment {
  text: string;
  joiner: string;
}

/**
 * Breaks a text into segments no longer than CHUNK_MAX_CHARS,
 * preferring coarse boundaries: paragraphs first; a paragraph that is
 * still too long falls to sentences; a sentence that is still too
 * long is hard-split. Sentence ends include the Bengali danda (।)
 * alongside Latin punctuation. (In practice the plain-text extractor
 * collapses a note body to a single space-joined line, so the title
 * break is the one paragraph boundary most notes have — sentences do
 * the real work.)
 */
function chunkSegments(text: string): ChunkSegment[] {
  const segments: ChunkSegment[] = [];
  const push = (piece: string, joiner: string) => {
    const trimmed = piece.trim();
    if (trimmed) segments.push({ text: trimmed, joiner });
  };
  for (const paragraph of text.split(/\n+/)) {
    if (!paragraph.trim()) continue;
    if (paragraph.length <= CHUNK_MAX_CHARS) {
      push(paragraph, "\n");
      continue;
    }
    let firstSentence = true;
    for (const sentence of paragraph.split(/(?<=[.!?…।])\s+/)) {
      if (sentence.length <= CHUNK_MAX_CHARS) {
        push(sentence, firstSentence ? "\n" : " ");
        firstSentence = false;
        continue;
      }
      for (let i = 0; i < sentence.length; i += CHUNK_MAX_CHARS) {
        push(sentence.slice(i, i + CHUNK_MAX_CHARS), i === 0 ? (firstSentence ? "\n" : " ") : "");
      }
      firstSentence = false;
    }
  }
  return segments;
}

/**
 * The chunks a note is indexed as for Ask Noma: the same text
 * `embeddedTextForNote` produces (title first, EMBED_MAX_CHARS cap),
 * packed from boundary-respecting segments into ~CHUNK_MAX_CHARS
 * chunks, each after the first prefixed with the previous chunk's
 * tail (snapped forward to a word boundary) so a passage that
 * straddles a boundary survives whole in one chunk or the other.
 * Deterministic: identical text → identical chunks → stable content
 * hashes. An empty/whitespace note yields zero chunks.
 */
export function chunkNoteText(note: Pick<Note, "title" | "content">): string[] {
  const text = embeddedTextForNote(note);
  if (!text.trim()) return [];
  const segments = chunkSegments(text);

  const base: string[] = [];
  let current = "";
  for (const segment of segments) {
    if (!current) {
      current = segment.text;
      continue;
    }
    const candidate = `${current}${segment.joiner}${segment.text}`;
    if (candidate.length <= CHUNK_MAX_CHARS) {
      current = candidate;
    } else {
      base.push(current);
      current = segment.text;
    }
  }
  if (current) base.push(current);

  return base.map((chunk, index) => {
    if (index === 0) return chunk;
    const previous = base[index - 1]!;
    const tail = previous.slice(-CHUNK_OVERLAP_CHARS);
    const boundary = tail.search(/\s/);
    const overlap = boundary >= 0 ? tail.slice(boundary).trim() : "";
    return overlap ? `${overlap}\n${chunk}` : chunk;
  });
}

/** One note's wanted chunks: index, exact text, and its content hash. */
export interface DesiredChunk {
  index: number;
  text: string;
  hash: string;
}

/** noteId → the chunks the index should hold (same eligible, non-empty notes as desiredEmbeddings). */
function desiredChunks(notes: Note[]): Map<string, DesiredChunk[]> {
  const out = new Map<string, DesiredChunk[]>();
  for (const note of notes) {
    if (!noteEligibleForAi(note)) continue;
    const chunks = chunkNoteText(note);
    if (chunks.length === 0) continue;
    out.set(
      note.id,
      chunks.map((text, index) => ({ index, text, hash: fnv1a(text) })),
    );
  }
  return out;
}

/**
 * A comparable signature of one note's chunk set: "index:hash" pairs
 * in chunk order. Stored rows and wanted chunks are current for each
 * other exactly when their signatures are equal.
 */
function chunkSignature(chunks: Array<{ index: number; hash: string }>): string {
  return [...chunks]
    .sort((a, b) => a.index - b.index)
    .map((chunk) => `${chunk.index}:${chunk.hash}`)
    .join(",");
}

function storedChunkSignature(rows: NoteChunk[]): string {
  return chunkSignature(rows.map((row) => ({ index: row.chunkIndex, hash: row.contentHash })));
}

/** The chunks table, or null on a database that predates v6 (defensive, like the noteEmbeddings guards). */
function chunkTable(db: NomaDatabase): NomaDatabase["noteChunks"] | null {
  return db.noteChunks ?? null;
}

/** Deletes every chunk row of one note. No provider call. */
async function deleteNoteChunks(db: NomaDatabase, noteId: string): Promise<void> {
  const table = chunkTable(db);
  if (!table) return;
  await table.where("noteId").equals(noteId).delete();
}

/* ---------------- Index lifecycle ---------------- */

export interface IndexProgress {
  done: number;
  total: number;
}

export interface BuildOptions {
  onProgress?: (progress: IndexProgress) => void;
  signal?: AbortSignal;
}

function abortError(): Error {
  const error = new Error("Index build cancelled");
  error.name = "AbortError";
  return error;
}

/**
 * Embeds the given notes in groups and stores their rows. All vectors
 * in one run must share a dimension — a provider that changes dims
 * mid-run fails loudly rather than storing a mixed space.
 */
async function embedAndStore(
  db: NomaDatabase,
  target: AiEmbeddingTarget,
  entries: Array<[string, { text: string; hash: string }]>,
  options: BuildOptions = {},
): Promise<void> {
  let dims: number | null = null;
  let done = 0;
  for (let i = 0; i < entries.length; i += EMBED_GROUP_SIZE) {
    if (options.signal?.aborted) throw abortError();
    const group = entries.slice(i, i + EMBED_GROUP_SIZE);
    const vectors = await embedTexts(
      embeddingSettings(target),
      group.map(([, want]) => want.text),
      "document",
    );
    if (vectors.length !== group.length) throw new AiError("bad-response");
    const now = Date.now();
    const rows: NoteEmbedding[] = group.map(([noteId, want], index) => {
      const vector = vectors[index]!;
      if (dims === null) dims = vector.length;
      else if (vector.length !== dims) throw new AiError("bad-response");
      return {
        noteId,
        providerKey: providerKeyFor(target, vector.length),
        dims: vector.length,
        vector,
        contentHash: want.hash,
        updatedAt: now,
      };
    });
    await db.noteEmbeddings.bulkPut(rows);
    done += group.length;
    options.onProgress?.({ done, total: entries.length });
  }
}

/** A flattened chunk waiting to be embedded: which note, which chunk, what text. */
interface ChunkEmbedItem {
  noteId: string;
  index: number;
  text: string;
  hash: string;
}

/**
 * Embeds the given notes' chunks in groups and stores their rows —
 * the chunk-level twin of embedAndStore, with the same rules: one
 * dimension across a run, abort checked per group, and a cancel
 * leaves the chunks stored so far in place as a valid partial index.
 * Callers delete a note's old chunk rows before re-embedding them.
 */
async function embedChunksAndStore(
  db: NomaDatabase,
  target: AiEmbeddingTarget,
  items: ChunkEmbedItem[],
  options: BuildOptions = {},
): Promise<void> {
  const table = chunkTable(db);
  if (!table || items.length === 0) return;
  let dims: number | null = null;
  let done = 0;
  for (let i = 0; i < items.length; i += EMBED_GROUP_SIZE) {
    if (options.signal?.aborted) throw abortError();
    const group = items.slice(i, i + EMBED_GROUP_SIZE);
    const vectors = await embedTexts(
      embeddingSettings(target),
      group.map((item) => item.text),
      "document",
    );
    if (vectors.length !== group.length) throw new AiError("bad-response");
    const now = Date.now();
    const rows: NoteChunk[] = group.map((item, index) => {
      const vector = vectors[index]!;
      if (dims === null) dims = vector.length;
      else if (vector.length !== dims) throw new AiError("bad-response");
      return {
        id: `${item.noteId}#${item.index}`,
        noteId: item.noteId,
        chunkIndex: item.index,
        providerKey: providerKeyFor(target, vector.length),
        dims: vector.length,
        vector,
        contentHash: item.hash,
        text: item.text,
        updatedAt: now,
      };
    });
    await table.bulkPut(rows);
    done += group.length;
    options.onProgress?.({ done, total: items.length });
  }
}

/** Flattens wanted chunks for the given notes into embed items, in note order. */
function chunkEmbedItems(
  wanted: Map<string, DesiredChunk[]>,
  noteIds: Iterable<string>,
): ChunkEmbedItem[] {
  const items: ChunkEmbedItem[] = [];
  for (const noteId of noteIds) {
    for (const chunk of wanted.get(noteId) ?? []) {
      items.push({ noteId, index: chunk.index, text: chunk.text, hash: chunk.hash });
    }
  }
  return items;
}

/**
 * Full (re)build: wipes both index tables first — a rebuild never
 * mixes vectors from a previous provider/model — then embeds every
 * eligible note, first its note vector, then its chunks. Cancelling
 * mid-build leaves the notes embedded so far in place; the status
 * then honestly reports the rest as stale, and Update completes
 * the job.
 */
export async function buildIndex(
  db: NomaDatabase,
  target: AiEmbeddingTarget,
  options: BuildOptions = {},
): Promise<{ indexed: number }> {
  const notes = await db.notes.toArray();
  const desired = desiredEmbeddings(notes);
  const wantedChunks = desiredChunks(notes);
  await db.noteEmbeddings.clear();
  await chunkTable(db)?.clear();
  const entries = [...desired.entries()];
  const chunkItems = chunkEmbedItems(wantedChunks, desired.keys());
  // Progress counts notes and chunks together: the build is done when
  // both halves of the index are stored.
  const total = entries.length + chunkItems.length;
  options.onProgress?.({ done: 0, total });
  await embedAndStore(db, target, entries, {
    ...options,
    onProgress: (p) => options.onProgress?.({ done: p.done, total }),
  });
  await embedChunksAndStore(db, target, chunkItems, {
    ...options,
    onProgress: (p) => options.onProgress?.({ done: entries.length + p.done, total }),
  });
  return { indexed: entries.length };
}

/**
 * Reconcile: embeds new/changed notes, deletes vectors for notes
 * that are gone or no longer eligible (deleted, locked, trashed,
 * templated), and drops any row written by a different provider/model
 * (re-embedding it under the current one when the note still wants a
 * vector). The chunk half reconciles in the same pass, per note: a
 * note whose chunks are missing or stale — including every note in a
 * pre-chunk index, whose vectors reconcile as unchanged while their
 * chunks backfill — is re-chunked and re-embedded; an unchanged note
 * costs no provider call at all. Returns per-note counts (a note
 * counts once, for whichever half did the work), for the Settings
 * status line.
 */
export async function reconcileIndex(
  db: NomaDatabase,
  target: AiEmbeddingTarget,
): Promise<{ embedded: number; deleted: number; unchanged: number }> {
  const notes = await db.notes.toArray();
  const desired = desiredEmbeddings(notes);
  const wantedChunks = desiredChunks(notes);
  const prefix = identityPrefix(target);

  const rows = await db.noteEmbeddings.toArray();
  const vectorById = new Map(rows.map((row) => [row.noteId, row]));
  const chunkRows = (await chunkTable(db)?.toArray()) ?? [];
  const chunksByNote = new Map<string, NoteChunk[]>();
  for (const row of chunkRows) {
    const list = chunksByNote.get(row.noteId);
    if (list) list.push(row);
    else chunksByNote.set(row.noteId, [row]);
  }

  let embedded = 0;
  let deleted = 0;
  let unchanged = 0;

  // Notes the index holds rows for but no longer wants: drop both halves.
  const storedIds = new Set([...vectorById.keys(), ...chunksByNote.keys()]);
  for (const noteId of storedIds) {
    if (desired.has(noteId)) continue;
    if (vectorById.has(noteId)) await db.noteEmbeddings.delete(noteId);
    if (chunksByNote.has(noteId)) await deleteNoteChunks(db, noteId);
    deleted++;
  }

  const vectorsToEmbed: Array<[string, { text: string; hash: string }]> = [];
  const chunksToEmbed: ChunkEmbedItem[] = [];
  for (const [noteId, want] of desired) {
    const row = vectorById.get(noteId);
    const vectorOk = !!row && row.providerKey.startsWith(prefix) && row.contentHash === want.hash;
    if (!vectorOk) vectorsToEmbed.push([noteId, want]);

    const stored = (chunksByNote.get(noteId) ?? []).filter((chunk) =>
      chunk.providerKey.startsWith(prefix),
    );
    const wanted = wantedChunks.get(noteId) ?? [];
    const chunksOk =
      stored.length === (chunksByNote.get(noteId) ?? []).length &&
      storedChunkSignature(stored) === chunkSignature(wanted);
    if (!chunksOk) {
      // Re-chunking replaces the note's chunk rows wholesale: drop the
      // old (or foreign-provider) rows first, then embed the wanted set.
      if ((chunksByNote.get(noteId) ?? []).length) await deleteNoteChunks(db, noteId);
      chunksToEmbed.push(...chunkEmbedItems(wantedChunks, [noteId]));
    }

    if (vectorOk && chunksOk) unchanged++;
    else embedded++;
  }

  await embedAndStore(db, target, vectorsToEmbed);
  await embedChunksAndStore(db, target, chunksToEmbed);
  return { embedded, deleted, unchanged };
}

/** Remove the whole index — search returns to keyword-only and Ask Noma has nothing to read. */
export async function removeIndex(db: NomaDatabase): Promise<void> {
  await db.noteEmbeddings.clear();
  await chunkTable(db)?.clear();
}

/* ---------------- Status ---------------- */

export interface SemanticIndexStatus {
  state: "not-built" | "invalid-provider" | "ready";
  /** Vectors currently stored (any provider). */
  indexedCount: number;
  /** Eligible notes missing/changed, plus stored rows that no longer belong. Ready state only. */
  staleCount: number;
  /** The embedding model the stored vectors were built with, when an index exists. */
  embeddingModel: string | null;
  /** Chunk rows currently stored (any provider). */
  chunkCount: number;
  /**
   * Indexed notes whose Ask Noma chunks are missing or stale — an
   * index built before the chunk half existed reports every indexed
   * note here until Update backfills it. Ready state only.
   */
  chunksStaleCount: number;
}

function modelFromProviderKey(providerKey: string): string | null {
  const parts = providerKey.split("|");
  if (parts.length !== 4) return null;
  return parts[2] || null;
}

/**
 * Derives the index state from the table + live notes + the current
 * target. No rows → not-built. Rows that don't all belong to the
 * current provider/model (or no usable target at all — AI off, key
 * removed, a no-embeddings provider) → invalid-provider: the semantic
 * layer stays off until a rebuild. Otherwise ready, with a stale
 * count so the user can see when Update has work to do. The chunk
 * half is reported alongside: chunk rows count, and how many indexed
 * notes still need their chunks built or refreshed for Ask Noma.
 */
export async function getIndexStatus(
  db: NomaDatabase,
  target: AiEmbeddingTarget | null,
): Promise<SemanticIndexStatus> {
  const rows = await db.noteEmbeddings.toArray();
  const chunkRows = (await chunkTable(db)?.toArray()) ?? [];
  if (rows.length === 0) {
    return {
      state: "not-built",
      indexedCount: 0,
      staleCount: 0,
      embeddingModel: null,
      chunkCount: chunkRows.length,
      chunksStaleCount: 0,
    };
  }
  const embeddingModel = modelFromProviderKey(rows[0]!.providerKey);
  const prefix = target ? identityPrefix(target) : null;
  const valid =
    prefix !== null &&
    rows.every((row) => row.providerKey.startsWith(prefix)) &&
    chunkRows.every((row) => row.providerKey.startsWith(prefix));
  if (!valid) {
    return {
      state: "invalid-provider",
      indexedCount: rows.length,
      staleCount: 0,
      embeddingModel,
      chunkCount: chunkRows.length,
      chunksStaleCount: 0,
    };
  }
  const notes = await db.notes.toArray();
  const desired = desiredEmbeddings(notes);
  const byId = new Map(rows.map((row) => [row.noteId, row]));
  let stale = 0;
  for (const [noteId, want] of desired) {
    const row = byId.get(noteId);
    if (!row || row.contentHash !== want.hash) stale++;
  }
  for (const row of rows) {
    if (!desired.has(row.noteId)) stale++;
  }
  // The chunk half of the staleness story: an indexed note whose
  // chunk set doesn't match what its current text wants (missing
  // entirely in a pre-chunk index, or stale after an edit), plus
  // chunk rows that belong to no indexed note.
  const wantedChunks = desiredChunks(notes);
  const chunksByNote = new Map<string, NoteChunk[]>();
  for (const row of chunkRows) {
    const list = chunksByNote.get(row.noteId);
    if (list) list.push(row);
    else chunksByNote.set(row.noteId, [row]);
  }
  let chunksStale = 0;
  for (const [noteId, wanted] of wantedChunks) {
    if (storedChunkSignature(chunksByNote.get(noteId) ?? []) !== chunkSignature(wanted)) {
      chunksStale++;
    }
  }
  for (const noteId of chunksByNote.keys()) {
    if (!wantedChunks.has(noteId)) chunksStale++;
  }
  return {
    state: "ready",
    indexedCount: rows.length,
    staleCount: stale,
    embeddingModel,
    chunkCount: chunkRows.length,
    chunksStaleCount: chunksStale,
  };
}

/**
 * The one-line index status Settings shows, as a pure derivation so
 * the wording is testable without the component. It covers BOTH
 * tables honestly — note vectors (semantic search) and passage
 * chunks (Ask Noma) — with counts only: the index's byte size is
 * never computed anywhere, so the line never invents one.
 */
export function indexStatusLine(status: SemanticIndexStatus, providerName: string): string {
  switch (status.state) {
    case "not-built":
      return `No search index yet. Building one sends each note's text to ${providerName} under your key — once per note, and again in small overlapping chunks for Ask Noma — and keeps the index on this device only.`;
    case "invalid-provider":
      return `The index on this device was built with ${status.embeddingModel ?? "a different embedding model"} — rebuild it to use semantic search and Ask Noma with the current provider. Search stays keyword-only until then.`;
    case "ready": {
      const line = `Indexed ${status.indexedCount} note${status.indexedCount === 1 ? "" : "s"} · ${status.chunkCount} passage${status.chunkCount === 1 ? "" : "s"} · ${status.embeddingModel ?? "unknown model"} · ${
        status.staleCount > 0 ? `${status.staleCount} changed since` : "up to date"
      }`;
      return status.chunksStaleCount > 0
        ? `${line} · Ask Noma chunks pending for ${status.chunksStaleCount} note${status.chunksStaleCount === 1 ? "" : "s"} — Update index adds them`
        : line;
    }
  }
}

/* ---------------- Vector invalidation (direct-write paths) ----------------
 * Several modules write db.notes directly, bypassing updateNote's save
 * hook: note locking/unlocking (note-lock.ts), version restores
 * (versions.ts), permanent deletion, backup restore / sync merge
 * (backup.ts) and imports (importers.ts). The invariant they must all
 * preserve: a locked, template or trashed note NEVER has a vector —
 * note-level or chunk — at rest, and a stored row never claims
 * content its note doesn't currently have. (Chunk rows carry the
 * note's plain text, so the invariant matters even more for them.)
 * The helpers here are LOCAL-ONLY — they delete rows and never
 * call the provider; re-embedding stays inside user flows (a save, an
 * unlock, Build/Update), so a mismatch simply reads as stale until
 * then. */

/** Deletes one note's vector row AND its chunk rows, if any exist. No provider call. */
export async function invalidateNoteVector(db: NomaDatabase, noteId: string): Promise<void> {
  if (!db.noteEmbeddings) return;
  await db.noteEmbeddings.delete(noteId);
  await deleteNoteChunks(db, noteId);
}

/**
 * Deletes the index rows of the given notes wherever a row no longer
 * tells the truth: the note is gone, no longer eligible (locked,
 * template, trashed), emptied, or its stored contentHash doesn't
 * match the hash of the note's current embedded text. A note whose
 * vector row is deleted loses its chunk rows with it — chunks derive
 * from the same text, so a stale vector means stale chunks. Eligible
 * notes whose rows still match are kept untouched (a note whose
 * chunks were never built is NOT a mismatch — that is the status
 * backfill case, repaired by Update, not by deletion).
 */
export async function invalidateMismatchedVectors(
  db: NomaDatabase,
  noteIds: Iterable<string>,
): Promise<void> {
  if (!db.noteEmbeddings) return;
  for (const noteId of noteIds) {
    const row = await db.noteEmbeddings.get(noteId);
    if (!row) continue;
    const note = await db.notes.get(noteId);
    if (!note || !noteEligibleForAi(note)) {
      await db.noteEmbeddings.delete(noteId);
      await deleteNoteChunks(db, noteId);
      continue;
    }
    const text = embeddedTextForNote(note);
    if (!text.trim() || row.contentHash !== fnv1a(text)) {
      await db.noteEmbeddings.delete(noteId);
      await deleteNoteChunks(db, noteId);
    }
  }
}

/* ---------------- Save-time maintenance ---------------- */

/**
 * Keeps one note's vector — and its chunks — current after a save,
 * but only when a valid index already exists (the user's build was
 * the opt-in; this never creates an index, never writes into a
 * different provider's space). An ineligible or emptied note loses
 * both halves. A note whose vector is already current but whose
 * chunks are missing (an index built before chunks existed) or stale
 * gets just its chunks embedded — one note's worth, inside the save
 * flow the user already triggered. Failures propagate to the caller;
 * the notes.ts hook swallows them, and any miss shows up in the stale
 * counts for Update to repair.
 */
export async function embedNoteIfIndexed(
  db: NomaDatabase,
  note: Note,
  target: AiEmbeddingTarget | null,
): Promise<void> {
  if (!target) return;
  const rows = await db.noteEmbeddings.toArray();
  if (rows.length === 0) return;
  const prefix = identityPrefix(target);
  if (!rows.every((row) => row.providerKey.startsWith(prefix))) return;
  const table = chunkTable(db);
  const chunkRows = table ? await table.toArray() : [];
  if (!chunkRows.every((row) => row.providerKey.startsWith(prefix))) return;

  if (!noteEligibleForAi(note)) {
    await db.noteEmbeddings.delete(note.id);
    await deleteNoteChunks(db, note.id);
    return;
  }
  const text = embeddedTextForNote(note);
  if (!text.trim()) {
    await db.noteEmbeddings.delete(note.id);
    await deleteNoteChunks(db, note.id);
    return;
  }
  const hash = fnv1a(text);
  const existing = rows.find((row) => row.noteId === note.id);
  if (!existing || existing.contentHash !== hash) {
    const [vector] = await embedTexts(embeddingSettings(target), [text], "document");
    if (!vector) throw new AiError("bad-response");
    await db.noteEmbeddings.put({
      noteId: note.id,
      providerKey: providerKeyFor(target, vector.length),
      dims: vector.length,
      vector,
      contentHash: hash,
      updatedAt: Date.now(),
    });
  }

  // The chunk half: current exactly when the stored rows are the
  // wanted chunks under the current provider identity.
  const wanted = desiredChunks([note]).get(note.id) ?? [];
  const stored = chunkRows.filter((row) => row.noteId === note.id);
  const chunksCurrent =
    stored.every((row) => row.providerKey.startsWith(prefix)) &&
    storedChunkSignature(stored) === chunkSignature(wanted);
  if (!chunksCurrent) {
    await deleteNoteChunks(db, note.id);
    await embedChunksAndStore(db, target, chunkEmbedItems(new Map([[note.id, wanted]]), [note.id]));
  }
}

/**
 * The account a database belongs to, from its name — the databases
 * are named `noma_<uid>`, or `noma_guest` for the guest account (see
 * DatabaseContext). Anything else (legacy "noma", test doubles) has
 * no resolvable AI record and returns undefined.
 */
function ownerIdForDatabaseName(name: string | undefined): string | null | undefined {
  if (name === "noma_guest") return null;
  if (typeof name === "string" && name.startsWith("noma_") && name.length > 5) {
    return name.slice(5);
  }
  return undefined;
}

/**
 * The notes.ts save hook (also used by versions.ts restores and
 * note-lock.ts unlocks), kept here so callers stay thin: refreshes one
 * note's vector and chunks after a write. Best-effort by design —
 * every failure is swallowed, because a save must never fail over a
 * search index; Update index repairs anything this misses. Does
 * nothing when no index exists.
 *
 * The truth enforcement runs FIRST and needs no provider target at
 * all: a gone, ineligible (locked/template/trashed) or emptied note
 * loses its vector and its chunks locally, even when AI is off or the
 * key was removed — plaintext-derived rows must never outlive the
 * state that made their note unembeddable. Only the re-embed of an
 * eligible note waits for a resolvable target.
 */
export async function maintainSemanticIndexForNote(
  db: NomaDatabase,
  noteId: string,
): Promise<void> {
  try {
    if (!db.noteEmbeddings) return;
    const chunkCount = (await chunkTable(db)?.count()) ?? 0;
    if ((await db.noteEmbeddings.count()) === 0 && chunkCount === 0) return;
    const note = await db.notes.get(noteId);
    if (!note || !noteEligibleForAi(note) || !embeddedTextForNote(note).trim()) {
      await db.noteEmbeddings.delete(noteId);
      await deleteNoteChunks(db, noteId);
      return;
    }
    const ownerId = ownerIdForDatabaseName(db.name);
    if (ownerId === undefined) return;
    const target = getAiEmbeddingTarget(ownerId);
    if (!target) return;
    await embedNoteIfIndexed(db, note, target);
  } catch {
    /* best-effort maintenance — reconcile is the repair path */
  }
}

/* ---------------- Query path ---------------- */

/**
 * Embeds the query once and scores every validly-indexed note by
 * cosine similarity (dot product over pre-normalised vectors).
 * Returns an empty map — never throws for configuration problems —
 * when there is no usable index; a provider failure DOES throw, and
 * the caller treats it as "keyword results only".
 */
export async function semanticScores(
  db: NomaDatabase,
  query: string,
  target: AiEmbeddingTarget | null,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (!target || !query.trim()) return scores;
  const rows = await db.noteEmbeddings.toArray();
  if (rows.length === 0) return scores;
  const prefix = identityPrefix(target);
  const valid = rows.filter((row) => row.providerKey.startsWith(prefix));
  if (valid.length === 0) return scores;
  const [queryVector] = await embedTexts(embeddingSettings(target), [query], "query");
  if (!queryVector) return scores;
  for (const row of valid) {
    if (row.vector.length !== queryVector.length) continue;
    let dot = 0;
    for (let i = 0; i < row.vector.length; i++) {
      dot += row.vector[i]! * queryVector[i]!;
    }
    scores.set(row.noteId, dot);
  }
  return scores;
}

/**
 * Blends semantic scores into keyword results: a note's final score
 * is its keyword score plus similarity × SEMANTIC_WEIGHT when the
 * similarity clears the floor, and semantic-only notes above the
 * floor join with a plain-text-head snippet. The floor is the one
 * resolved for the index's embedding model (`similarityFloorFor`);
 * it defaults to SEMANTIC_THRESHOLD. Defence in depth: a boost or a
 * semantic-only entry is only ever applied to a note that is
 * eligible right now (never locked/template/trashed) and present in
 * the caller's live note list — a stale vector can never surface a
 * note on its own. With no scores, the keyword results are returned
 * untouched.
 */
export function mergeSemanticResults(
  keywordResults: SearchResult[],
  scores: Map<string, number> | null,
  notes: Note[],
  floor: number = SEMANTIC_THRESHOLD,
): SearchResult[] {
  if (!scores || scores.size === 0) return keywordResults;
  const byId = new Map(notes.map((note) => [note.id, note]));
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const result of keywordResults) {
    seen.add(result.note.id);
    const similarity = scores.get(result.note.id);
    if (similarity !== undefined && similarity >= floor && noteEligibleForAi(result.note)) {
      merged.push({ ...result, score: result.score + similarity * SEMANTIC_WEIGHT });
    } else {
      merged.push(result);
    }
  }
  for (const [noteId, similarity] of scores) {
    if (seen.has(noteId) || similarity < floor) continue;
    const note = byId.get(noteId);
    if (!note || !noteEligibleForAi(note)) continue;
    merged.push({
      note,
      score: similarity * SEMANTIC_WEIGHT,
      snippet: notePreviewText(note.content).slice(0, 120),
    });
  }
  return merged.sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt);
}

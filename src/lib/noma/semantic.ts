import {
  AiError,
  embedTexts,
  getAiEmbeddingTarget,
  normalizeBaseUrl,
  noteEligibleForAi,
  type AiEmbeddingTarget,
} from "./ai";
import type { NomaDatabase } from "./db";
import { htmlToPlainText } from "./sanitize";
import type { SearchResult } from "./search";
import type { Note, NoteEmbedding } from "./types";

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
 * Any failure in this layer (offline, quota, bad key) degrades search
 * to keyword-only; searchNotes itself is untouched.
 */

/** Per-note text budget for embedding (Gemini's 2048-token cap, Bengali-safe). */
export const EMBED_MAX_CHARS = 6000;
/** Cosine similarity a note must reach to earn a semantic contribution. */
export const SEMANTIC_THRESHOLD = 0.5;
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

/**
 * Full (re)build: wipes the table first — a rebuild never mixes
 * vectors from a previous provider/model — then embeds every eligible
 * note. Cancelling mid-build leaves the notes embedded so far in
 * place; the status then honestly reports the rest as stale, and
 * Update completes the job.
 */
export async function buildIndex(
  db: NomaDatabase,
  target: AiEmbeddingTarget,
  options: BuildOptions = {},
): Promise<{ indexed: number }> {
  const notes = await db.notes.toArray();
  const desired = desiredEmbeddings(notes);
  await db.noteEmbeddings.clear();
  const entries = [...desired.entries()];
  options.onProgress?.({ done: 0, total: entries.length });
  await embedAndStore(db, target, entries, options);
  return { indexed: entries.length };
}

/**
 * Reconcile: embeds new/changed notes, deletes vectors for notes
 * that are gone or no longer eligible (deleted, locked, trashed,
 * templated), and drops any row written by a different provider/model
 * (re-embedding it under the current one when the note still wants a
 * vector). Returns what it did, for the Settings status line.
 */
export async function reconcileIndex(
  db: NomaDatabase,
  target: AiEmbeddingTarget,
): Promise<{ embedded: number; deleted: number; unchanged: number }> {
  const notes = await db.notes.toArray();
  const desired = desiredEmbeddings(notes);
  const rows = await db.noteEmbeddings.toArray();
  const prefix = identityPrefix(target);
  const byId = new Map(rows.map((row) => [row.noteId, row]));

  const toDelete: string[] = [];
  for (const row of rows) {
    if (!desired.has(row.noteId) || !row.providerKey.startsWith(prefix)) {
      toDelete.push(row.noteId);
    }
  }

  const toEmbed: Array<[string, { text: string; hash: string }]> = [];
  let unchanged = 0;
  for (const [noteId, want] of desired) {
    const row = byId.get(noteId);
    if (row && row.providerKey.startsWith(prefix) && row.contentHash === want.hash) {
      unchanged++;
    } else {
      toEmbed.push([noteId, want]);
    }
  }

  if (toDelete.length) await db.noteEmbeddings.bulkDelete(toDelete);
  await embedAndStore(db, target, toEmbed);
  return { embedded: toEmbed.length, deleted: toDelete.length, unchanged };
}

/** Remove the whole index — search returns to keyword-only. */
export async function removeIndex(db: NomaDatabase): Promise<void> {
  await db.noteEmbeddings.clear();
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
 * count so the user can see when Update has work to do.
 */
export async function getIndexStatus(
  db: NomaDatabase,
  target: AiEmbeddingTarget | null,
): Promise<SemanticIndexStatus> {
  const rows = await db.noteEmbeddings.toArray();
  if (rows.length === 0) {
    return { state: "not-built", indexedCount: 0, staleCount: 0, embeddingModel: null };
  }
  const embeddingModel = modelFromProviderKey(rows[0]!.providerKey);
  const prefix = target ? identityPrefix(target) : null;
  const valid = prefix !== null && rows.every((row) => row.providerKey.startsWith(prefix));
  if (!valid) {
    return {
      state: "invalid-provider",
      indexedCount: rows.length,
      staleCount: 0,
      embeddingModel,
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
  return { state: "ready", indexedCount: rows.length, staleCount: stale, embeddingModel };
}

/* ---------------- Vector invalidation (direct-write paths) ----------------
 * Several modules write db.notes directly, bypassing updateNote's save
 * hook: note locking/unlocking (note-lock.ts), version restores
 * (versions.ts), permanent deletion, backup restore / sync merge
 * (backup.ts) and imports (importers.ts). The invariant they must all
 * preserve: a locked, template or trashed note NEVER has a vector at
 * rest, and a vector never claims content its note doesn't currently
 * have. The helpers here are LOCAL-ONLY — they delete rows and never
 * call the provider; re-embedding stays inside user flows (a save, an
 * unlock, Build/Update), so a mismatch simply reads as stale until
 * then. */

/** Deletes one note's vector row, if one exists. No provider call. */
export async function invalidateNoteVector(db: NomaDatabase, noteId: string): Promise<void> {
  if (!db.noteEmbeddings) return;
  await db.noteEmbeddings.delete(noteId);
}

/**
 * Deletes the vector rows of the given notes wherever a row no longer
 * tells the truth: the note is gone, no longer eligible (locked,
 * template, trashed), emptied, or its stored contentHash doesn't match
 * the hash of the note's current embedded text. Eligible notes whose
 * rows still match are kept untouched.
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
      continue;
    }
    const text = embeddedTextForNote(note);
    if (!text.trim() || row.contentHash !== fnv1a(text)) {
      await db.noteEmbeddings.delete(noteId);
    }
  }
}

/* ---------------- Save-time maintenance ---------------- */

/**
 * Keeps one note's vector current after a save — but only when a
 * valid index already exists (the user's build was the opt-in; this
 * never creates an index, never writes into a different provider's
 * space). An ineligible or emptied note loses its vector. Failures
 * propagate to the caller; the notes.ts hook swallows them, and any
 * miss shows up in the stale count for Update to repair.
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

  if (!noteEligibleForAi(note)) {
    await db.noteEmbeddings.delete(note.id);
    return;
  }
  const text = embeddedTextForNote(note);
  if (!text.trim()) {
    await db.noteEmbeddings.delete(note.id);
    return;
  }
  const hash = fnv1a(text);
  const existing = rows.find((row) => row.noteId === note.id);
  if (existing && existing.contentHash === hash) return;
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
 * note's vector after a write. Best-effort by design — every failure
 * is swallowed, because a save must never fail over a search index;
 * Update index repairs anything this misses. Does nothing when no
 * index exists.
 *
 * The truth enforcement runs FIRST and needs no provider target at
 * all: a gone, ineligible (locked/template/trashed) or emptied note
 * loses its vector locally, even when AI is off or the key was
 * removed — a plaintext-derived vector must never outlive the state
 * that made its note unembeddable. Only the re-embed of an eligible
 * note waits for a resolvable target.
 */
export async function maintainSemanticIndexForNote(
  db: NomaDatabase,
  noteId: string,
): Promise<void> {
  try {
    if (!db.noteEmbeddings) return;
    if ((await db.noteEmbeddings.count()) === 0) return;
    const note = await db.notes.get(noteId);
    if (!note || !noteEligibleForAi(note) || !embeddedTextForNote(note).trim()) {
      await db.noteEmbeddings.delete(noteId);
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
 * similarity clears SEMANTIC_THRESHOLD, and semantic-only notes above
 * the threshold join with a plain-text-head snippet. Defence in
 * depth: a boost or a semantic-only entry is only ever applied to a
 * note that is eligible right now (never locked/template/trashed) and
 * present in the caller's live note list — a stale vector can never
 * surface a note on its own. With no scores, the keyword results are
 * returned untouched.
 */
export function mergeSemanticResults(
  keywordResults: SearchResult[],
  scores: Map<string, number> | null,
  notes: Note[],
): SearchResult[] {
  if (!scores || scores.size === 0) return keywordResults;
  const byId = new Map(notes.map((note) => [note.id, note]));
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const result of keywordResults) {
    seen.add(result.note.id);
    const similarity = scores.get(result.note.id);
    if (
      similarity !== undefined &&
      similarity >= SEMANTIC_THRESHOLD &&
      noteEligibleForAi(result.note)
    ) {
      merged.push({ ...result, score: result.score + similarity * SEMANTIC_WEIGHT });
    } else {
      merged.push(result);
    }
  }
  for (const [noteId, similarity] of scores) {
    if (seen.has(noteId) || similarity < SEMANTIC_THRESHOLD) continue;
    const note = byId.get(noteId);
    if (!note || !noteEligibleForAi(note)) continue;
    merged.push({
      note,
      score: similarity * SEMANTIC_WEIGHT,
      snippet: htmlToPlainText(note.content).slice(0, 120),
    });
  }
  return merged.sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt);
}

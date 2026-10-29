// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAiEmbeddingTarget, saveAiRecord, type AiEmbeddingTarget } from "./ai";
import { buildBackupZip, collectBackup } from "./backup";
import type { NomaDatabase } from "./db";
import { searchNotes } from "./search";
import {
  CHUNK_MAX_CHARS,
  CHUNK_OVERLAP_CHARS,
  EMBED_MAX_CHARS,
  buildIndex,
  chunkNoteText,
  embedNoteIfIndexed,
  embeddedTextForNote,
  fnv1a,
  getIndexStatus,
  invalidateMismatchedVectors,
  invalidateNoteVector,
  maintainSemanticIndexForNote,
  mergeSemanticResults,
  providerKeyFor,
  reconcileIndex,
  removeIndex,
  semanticScores,
} from "./semantic";
import type {
  AppSettings,
  AttachmentMeta,
  Folder,
  Note,
  NoteChunk,
  NoteEmbedding,
  Reminder,
  SyncTombstone,
  Tag,
} from "./types";

const OWNER = "user-1";

const FAKE_LOCK: Note["lock"] = {
  v: 1,
  slots: {},
  biometric: false,
  failedAttempts: 0,
  lockoutUntil: null,
  lockedAt: 1,
};
const API_KEY = "<redacted>";

/* ---------------- Storage stand-in (same pattern as ai.test.ts) ---------------- */

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  clear(): void {
    this.values.clear();
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: new MemoryStorage(), dispatchEvent: () => true },
    configurable: true,
  });
  vi.unstubAllGlobals();
});

/* ---------------- Fake tables ---------------- */

type Row = { id: string };

class FakeTable<T extends Row> {
  rows = new Map<string, T>();
  async get(id: string): Promise<T | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }
  async put(row: T): Promise<string> {
    this.rows.set(row.id, structuredClone(row));
    return row.id;
  }
  async bulkPut(rows: T[]): Promise<void> {
    for (const row of rows) this.rows.set(row.id, structuredClone(row));
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
  async bulkDelete(ids: string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
  async clear(): Promise<void> {
    this.rows.clear();
  }
  async count(): Promise<number> {
    return this.rows.size;
  }
  async toArray(): Promise<T[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
}

class FakeEmbeddingTable {
  rows = new Map<string, NoteEmbedding>();
  async get(noteId: string): Promise<NoteEmbedding | undefined> {
    const row = this.rows.get(noteId);
    return row ? structuredClone(row) : undefined;
  }
  async put(row: NoteEmbedding): Promise<string> {
    this.rows.set(row.noteId, structuredClone(row));
    return row.noteId;
  }
  async bulkPut(rows: NoteEmbedding[]): Promise<void> {
    for (const row of rows) this.rows.set(row.noteId, structuredClone(row));
  }
  async delete(noteId: string): Promise<void> {
    this.rows.delete(noteId);
  }
  async bulkDelete(ids: string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
  async clear(): Promise<void> {
    this.rows.clear();
  }
  async count(): Promise<number> {
    return this.rows.size;
  }
  async toArray(): Promise<NoteEmbedding[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
}

/** Stand-in for the v6 noteChunks table (keyed by id, indexed by noteId). */
class FakeChunkTable {
  rows = new Map<string, NoteChunk>();
  async get(id: string): Promise<NoteChunk | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }
  async put(row: NoteChunk): Promise<string> {
    this.rows.set(row.id, structuredClone(row));
    return row.id;
  }
  async bulkPut(rows: NoteChunk[]): Promise<void> {
    for (const row of rows) this.rows.set(row.id, structuredClone(row));
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
  async bulkDelete(ids: string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
  async clear(): Promise<void> {
    this.rows.clear();
  }
  async count(): Promise<number> {
    return this.rows.size;
  }
  async toArray(): Promise<NoteChunk[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
  where(field: string) {
    const matches = (value: unknown) =>
      [...this.rows.values()].filter(
        (row) => (row as unknown as Record<string, unknown>)[field] === value,
      );
    return {
      equals: (value: unknown) => ({
        toArray: async () => matches(value).map((row) => structuredClone(row)),
        delete: async () => {
          const found = matches(value);
          for (const row of found) this.rows.delete(row.id);
          return found.length;
        },
      }),
    };
  }
}

class FakeDb {
  name = `noma_${OWNER}`;
  notes = new FakeTable<Note>();
  folders = new FakeTable<Folder>();
  tags = new FakeTable<Tag>();
  attachments = new FakeTable<AttachmentMeta>();
  reminders = new FakeTable<Reminder>();
  settings = new FakeTable<AppSettings>();
  backups = new FakeTable<Row & { createdAt: number }>();
  tombstones = new FakeTable<SyncTombstone>();
  noteEmbeddings = new FakeEmbeddingTable();
  noteChunks = new FakeChunkTable();

  async transaction(...args: unknown[]): Promise<void> {
    const fn = args[args.length - 1] as () => Promise<void>;
    await fn();
  }
}

function asDb(fake: FakeDb): NomaDatabase {
  return fake as unknown as NomaDatabase;
}

function baseNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "n1",
    title: "Rain notes",
    content: "<p>Heavy rain all week.</p>",
    contentFormat: "tiptap-html",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    folderId: null,
    tagIds: [],
    pinned: false,
    favorite: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    reminderAt: null,
    wordCount: 4,
    ...overrides,
  };
}

/* ---------------- Deterministic fake embedder ----------------
 * "rain"/"monsoon" texts point along +x, "cats" texts along +y,
 * everything else diagonal — enough geometry for similarity tests. */

function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  if (lower.includes("rain") || lower.includes("monsoon")) return [1, 0.2];
  if (lower.includes("cats")) return [0.2, 1];
  return [0.5, 0.5];
}

function stubEmbedFetch(): { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      calls.push({ url: String(url), body });
      const parsed = JSON.parse(body) as {
        requests?: Array<{ content: { parts: Array<{ text: string }> } }>;
      };
      const texts = (parsed.requests ?? []).map((r) => r.content.parts[0]!.text);
      return new Response(
        JSON.stringify({ embeddings: texts.map((text) => ({ values: fakeVector(text) })) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  return { calls };
}

function geminiTarget(): AiEmbeddingTarget {
  saveAiRecord(OWNER, {
    enabled: true,
    activePreset: "gemini",
    providers: { gemini: { apiKey: API_KEY } },
  });
  const target = getAiEmbeddingTarget(OWNER);
  if (!target) throw new Error("expected a gemini embedding target");
  return target;
}

/* ---------------- Text + hash ---------------- */

describe("embedded text and content hash", () => {
  it("embeds title then plain-text body, head-truncated to EMBED_MAX_CHARS", () => {
    const note = baseNote({ title: "Title", content: "<p>Hello <b>world</b></p>" });
    expect(embeddedTextForNote(note)).toBe("Title\nHello world");
    const long = baseNote({ title: "", content: `<p>${"x".repeat(EMBED_MAX_CHARS + 500)}</p>` });
    expect(embeddedTextForNote(long).length).toBe(EMBED_MAX_CHARS);
  });

  it("hashes with stable FNV-1a hex (same input, same hash)", () => {
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toBe("e40c292c");
    expect(fnv1a("Heavy rain all week.")).toBe(fnv1a("Heavy rain all week."));
    expect(fnv1a("rain")).not.toBe(fnv1a("cats"));
  });
});

/* ---------------- Index build / status / reconcile ---------------- */

describe("semantic index lifecycle", () => {
  it("builds vectors only for eligible notes and reports a ready status", async () => {
    stubEmbedFetch();
    const db = new FakeDb();
    await db.notes.put(baseNote({ id: "rain" }));
    await db.notes.put(baseNote({ id: "cats", title: "Cats", content: "<p>Cats are great.</p>" }));
    await db.notes.put(baseNote({ id: "locked", lock: FAKE_LOCK }));
    await db.notes.put(baseNote({ id: "template", isTemplate: true }));
    await db.notes.put(baseNote({ id: "trashed", deleted: true, deletedAt: 1 }));
    await db.notes.put(baseNote({ id: "empty", title: "", content: "" }));

    const target = geminiTarget();
    const progress: number[] = [];
    const { indexed } = await buildIndex(asDb(db), target, {
      onProgress: (p) => progress.push(p.done),
    });
    expect(indexed).toBe(2);
    // Progress counts notes and chunks together (2 notes + 2 chunks).
    expect(progress[progress.length - 1]).toBe(4);

    const rows = await db.noteEmbeddings.toArray();
    expect(rows.map((r) => r.noteId).sort()).toEqual(["cats", "rain"]);
    expect(rows[0]!.providerKey).toBe("gemini|native|gemini-embedding-001|2");
    expect(rows[0]!.dims).toBe(2);
    expect(rows[0]!.contentHash).toBe(fnv1a(embeddedTextForNote(baseNote({ id: "rain" }))));

    const status = await getIndexStatus(asDb(db), target);
    expect(status).toEqual({
      state: "ready",
      indexedCount: 2,
      staleCount: 0,
      embeddingModel: "gemini-embedding-001",
      chunkCount: 2,
      chunksStaleCount: 0,
    });
  });

  it("reports not-built for an empty table", async () => {
    const db = new FakeDb();
    expect(await getIndexStatus(asDb(db), geminiTarget())).toEqual({
      state: "not-built",
      indexedCount: 0,
      staleCount: 0,
      embeddingModel: null,
      chunkCount: 0,
      chunksStaleCount: 0,
    });
  });

  it("invalidates the index when the provider/model changes or no target resolves", async () => {
    stubEmbedFetch();
    const db = new FakeDb();
    await db.notes.put(baseNote({ id: "rain" }));
    await buildIndex(asDb(db), geminiTarget());

    // Switch the active provider to OpenAI: the stored Gemini vectors
    // belong to a different embedding space.
    saveAiRecord(OWNER, {
      enabled: true,
      activePreset: "openai",
      providers: { openai: { apiKey: API_KEY } },
    });
    const openAiTarget = getAiEmbeddingTarget(OWNER);
    expect(openAiTarget?.presetId).toBe("openai");
    const status = await getIndexStatus(asDb(db), openAiTarget);
    expect(status.state).toBe("invalid-provider");
    expect(status.embeddingModel).toBe("gemini-embedding-001");

    // And with no target at all (AI off), the index is unusable too.
    saveAiRecord(OWNER, {
      enabled: false,
      activePreset: "gemini",
      providers: { gemini: { apiKey: API_KEY } },
    });
    expect((await getIndexStatus(asDb(db), getAiEmbeddingTarget(OWNER))).state).toBe(
      "invalid-provider",
    );
  });

  it("reconcile embeds new/changed notes and deletes gone or ineligible ones", async () => {
    stubEmbedFetch();
    const db = new FakeDb();
    const target = geminiTarget();
    await db.notes.put(baseNote({ id: "rain" }));
    await db.notes.put(baseNote({ id: "cats", title: "Cats", content: "<p>Cats.</p>" }));
    await buildIndex(asDb(db), target);

    // Change one note, lock another, add a third.
    await db.notes.put(baseNote({ id: "rain", content: "<p>Rain and more rain.</p>" }));
    await db.notes.put(
      baseNote({ id: "cats", title: "Cats", content: "<p>Cats.</p>", lock: FAKE_LOCK }),
    );
    await db.notes.put(baseNote({ id: "new", title: "Fresh", content: "<p>Brand new.</p>" }));

    expect((await getIndexStatus(asDb(db), target)).staleCount).toBe(3);

    const result = await reconcileIndex(asDb(db), target);
    expect(result).toEqual({ embedded: 2, deleted: 1, unchanged: 0 });
    const rows = await db.noteEmbeddings.toArray();
    expect(rows.map((r) => r.noteId).sort()).toEqual(["new", "rain"]);
    expect((await getIndexStatus(asDb(db), target)).staleCount).toBe(0);

    // A second reconcile with nothing changed is a no-op.
    expect(await reconcileIndex(asDb(db), target)).toEqual({
      embedded: 0,
      deleted: 0,
      unchanged: 2,
    });

    // Deleting the note outright removes its vector on reconcile.
    db.notes.rows.delete("new");
    expect(await reconcileIndex(asDb(db), target)).toEqual({
      embedded: 0,
      deleted: 1,
      unchanged: 1,
    });
  });

  it("a cancelled build rejects with AbortError and leaves an honest stale state", async () => {
    stubEmbedFetch();
    const db = new FakeDb();
    const target = geminiTarget();
    await db.notes.put(baseNote({ id: "rain" }));
    const controller = new AbortController();
    controller.abort();
    await expect(buildIndex(asDb(db), target, { signal: controller.signal })).rejects.toMatchObject(
      { name: "AbortError" },
    );
  });

  it("removeIndex wipes both index tables", async () => {
    stubEmbedFetch();
    const db = new FakeDb();
    await db.notes.put(baseNote({ id: "rain" }));
    await buildIndex(asDb(db), geminiTarget());
    expect(await db.noteChunks.count()).toBeGreaterThan(0);
    await removeIndex(asDb(db));
    expect(await db.noteEmbeddings.count()).toBe(0);
    expect(await db.noteChunks.count()).toBe(0);
  });
});

/* ---------------- Index identity: the endpoint is part of the key ---------------- */

function stubCompatibleEmbedFetch(): { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      calls.push({ url: String(url), body });
      const parsed = JSON.parse(body) as { input: string[] };
      return new Response(
        JSON.stringify({
          data: parsed.input.map((text, index) => ({ index, embedding: fakeVector(text) })),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  return { calls };
}

function customTarget(baseUrl: string): AiEmbeddingTarget {
  saveAiRecord(OWNER, {
    enabled: true,
    activePreset: "custom",
    providers: { custom: { apiKey: API_KEY, baseUrl, embeddingModel: "embed-x" } },
  });
  const target = getAiEmbeddingTarget(OWNER);
  if (!target) throw new Error("expected a custom embedding target");
  return target;
}

describe("providerKey identity", () => {
  it("keys Gemini's native API with the constant native segment", () => {
    const target: AiEmbeddingTarget = {
      settings: { enabled: true, apiKey: API_KEY, provider: "gemini" },
      presetId: "gemini",
      embeddingModel: "gemini-embedding-001",
      mode: "native",
    };
    expect(providerKeyFor(target, 768)).toBe("gemini|native|gemini-embedding-001|768");
  });

  it("distinguishes two custom endpoints that share a model name", () => {
    const literal = (baseUrl: string): AiEmbeddingTarget => ({
      settings: { enabled: true, apiKey: API_KEY, provider: "openai-compatible", baseUrl },
      presetId: "custom",
      embeddingModel: "embed-x",
      mode: "compatible",
    });
    const a = providerKeyFor(literal("https://embed-a.example/v1"), 2);
    const b = providerKeyFor(literal("https://embed-b.example/v1"), 2);
    expect(a).toBe("custom|https://embed-a.example/v1|embed-x|2");
    expect(b).toBe("custom|https://embed-b.example/v1|embed-x|2");
    expect(a).not.toBe(b);
    // The same endpoint modulo a trailing slash is the SAME space.
    expect(providerKeyFor(literal("https://embed-a.example/v1/"), 2)).toBe(a);
  });

  it("changing only the custom endpoint invalidates the index; the model still parses out of the URL-bearing key", async () => {
    const { calls } = stubCompatibleEmbedFetch();
    const db = new FakeDb();
    await db.notes.put(baseNote({ id: "rain" }));

    const targetA = customTarget("https://embed-a.example/v1");
    await buildIndex(asDb(db), targetA);
    const rows = await db.noteEmbeddings.toArray();
    expect(rows[0]!.providerKey).toBe("custom|https://embed-a.example/v1|embed-x|2");
    const ready = await getIndexStatus(asDb(db), targetA);
    expect(ready.state).toBe("ready");
    expect(ready.embeddingModel).toBe("embed-x");

    // Same provider slot, same model name, different server: the old
    // vectors belong to a different embedding space and must read as
    // invalid — never silently compared against new-endpoint queries.
    const targetB = customTarget("https://embed-b.example/v1");
    const status = await getIndexStatus(asDb(db), targetB);
    expect(status.state).toBe("invalid-provider");
    expect(status.embeddingModel).toBe("embed-x");

    // And no scores are produced against the stale space (no call made).
    const callsBefore = calls.length;
    expect((await semanticScores(asDb(db), "monsoon", targetB)).size).toBe(0);
    expect(calls).toHaveLength(callsBefore);
  });
});

/* ---------------- Save-time maintenance ---------------- */

describe("embedNoteIfIndexed / maintainSemanticIndexForNote", () => {
  it("does nothing when no index exists (no provider call)", async () => {
    const { calls } = stubEmbedFetch();
    const db = new FakeDb();
    const note = baseNote({ id: "rain" });
    await embedNoteIfIndexed(asDb(db), note, geminiTarget());
    expect(calls).toHaveLength(0);
    expect(await db.noteEmbeddings.count()).toBe(0);
  });

  it("re-embeds a changed note, skips an unchanged one, and purges a locked one", async () => {
    const { calls } = stubEmbedFetch();
    const db = new FakeDb();
    const target = geminiTarget();
    const note = baseNote({ id: "rain" });
    await db.notes.put(note);
    await buildIndex(asDb(db), target);
    const callsAfterBuild = calls.length;

    await embedNoteIfIndexed(asDb(db), note, target);
    expect(calls).toHaveLength(callsAfterBuild);

    const changed = baseNote({ id: "rain", content: "<p>Rain, again.</p>" });
    await embedNoteIfIndexed(asDb(db), changed, target);
    expect(calls.length).toBeGreaterThan(callsAfterBuild);
    const row = await db.noteEmbeddings.get("rain");
    expect(row?.contentHash).toBe(fnv1a(embeddedTextForNote(changed)));

    const locked = baseNote({
      id: "rain",
      content: "<p>Rain, again.</p>",
      lock: FAKE_LOCK,
    });
    await embedNoteIfIndexed(asDb(db), locked, target);
    expect(await db.noteEmbeddings.get("rain")).toBeUndefined();
    // The note's chunk rows — which hold its plain text — die with it.
    expect(await db.noteChunks.where("noteId").equals("rain").toArray()).toEqual([]);
  });

  it("maintainSemanticIndexForNote resolves the owner from the database name", async () => {
    stubEmbedFetch();
    const db = new FakeDb();
    const target = geminiTarget();
    await db.notes.put(baseNote({ id: "rain" }));
    await buildIndex(asDb(db), target);

    await db.notes.put(baseNote({ id: "rain", content: "<p>Even more rain.</p>" }));
    await maintainSemanticIndexForNote(asDb(db), "rain");
    const row = await db.noteEmbeddings.get("rain");
    expect(row?.contentHash).toBe(
      fnv1a(embeddedTextForNote(baseNote({ id: "rain", content: "<p>Even more rain.</p>" }))),
    );

    // A database whose name carries no account never resolves a record.
    const alien = new FakeDb();
    alien.name = "some-other-db";
    await alien.notes.put(baseNote({ id: "rain" }));
    await alien.noteEmbeddings.bulkPut(await db.noteEmbeddings.toArray());
    await maintainSemanticIndexForNote(asDb(alien), "rain");
    expect((await alien.noteEmbeddings.get("rain"))?.contentHash).toBe(row!.contentHash);
  });

  it("drops a locked or deleted note's vector even when no AI target resolves", async () => {
    stubEmbedFetch();
    const db = new FakeDb();
    const target = geminiTarget();
    await db.notes.put(baseNote({ id: "rain" }));
    await buildIndex(asDb(db), target);
    expect(await db.noteEmbeddings.count()).toBe(1);
    expect(await db.noteChunks.count()).toBe(1);

    // The note is locked behind the save hook's back AND the AI record
    // is removed: the plaintext-derived vector is still dropped —
    // locally, with no target and no provider call.
    await db.notes.put(baseNote({ id: "rain", lock: FAKE_LOCK }));
    saveAiRecord(OWNER, null);
    await maintainSemanticIndexForNote(asDb(db), "rain");
    expect(await db.noteEmbeddings.get("rain")).toBeUndefined();
    expect(await db.noteChunks.count()).toBe(0);

    // Same for a note deleted outright.
    await db.noteEmbeddings.put({
      noteId: "rain",
      providerKey: providerKeyFor(target, 2),
      dims: 2,
      vector: new Float32Array([1, 0]),
      contentHash: "abc123",
      updatedAt: 1,
    });
    db.notes.rows.delete("rain");
    await maintainSemanticIndexForNote(asDb(db), "rain");
    expect(await db.noteEmbeddings.get("rain")).toBeUndefined();
  });
});

/* ---------------- Invalidation helpers (direct-write paths) ---------------- */

describe("invalidateNoteVector / invalidateMismatchedVectors", () => {
  it("keeps a truthful row and deletes changed, ineligible and orphaned ones — with no provider call", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("invalidation must never call the provider");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const db = new FakeDb();
    const target = geminiTarget();
    const key = providerKeyFor(target, 2);
    const rowFor = (note: Note, hashOf: Note = note): NoteEmbedding => ({
      noteId: note.id,
      providerKey: key,
      dims: 2,
      vector: new Float32Array([1, 0]),
      contentHash: fnv1a(embeddedTextForNote(hashOf)),
      updatedAt: 1,
    });

    const keep = baseNote({ id: "keep" });
    const changedBefore = baseNote({ id: "changed", content: "<p>Old text.</p>" });
    const changedAfter = baseNote({ id: "changed", content: "<p>New text.</p>" });
    const locked = baseNote({ id: "locked", lock: FAKE_LOCK });
    await db.notes.put(keep);
    await db.notes.put(changedAfter);
    await db.notes.put(locked);
    await db.noteEmbeddings.put(rowFor(keep));
    await db.noteEmbeddings.put(rowFor(changedBefore));
    await db.noteEmbeddings.put(rowFor(locked));
    await db.noteEmbeddings.put(rowFor(baseNote({ id: "ghost" })));
    // Chunk rows ride along with their note's vector row.
    const chunkFor = (note: Note): NoteChunk => ({
      id: `${note.id}#0`,
      noteId: note.id,
      chunkIndex: 0,
      providerKey: key,
      dims: 2,
      vector: new Float32Array([1, 0]),
      contentHash: fnv1a(embeddedTextForNote(note)),
      text: embeddedTextForNote(note),
      updatedAt: 1,
    });
    await db.noteChunks.put(chunkFor(keep));
    await db.noteChunks.put(chunkFor(changedBefore));
    await db.noteChunks.put(chunkFor(locked));
    await db.noteChunks.put(chunkFor(baseNote({ id: "ghost" })));

    await invalidateMismatchedVectors(asDb(db), ["keep", "changed", "locked", "ghost"]);

    expect(await db.noteEmbeddings.get("keep")).toBeDefined();
    expect(await db.noteEmbeddings.get("changed")).toBeUndefined();
    expect(await db.noteEmbeddings.get("locked")).toBeUndefined();
    expect(await db.noteEmbeddings.get("ghost")).toBeUndefined();
    const remainingChunks = await db.noteChunks.toArray();
    expect(remainingChunks.map((row) => row.noteId)).toEqual(["keep"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("invalidateNoteVector deletes the vector row and the note's chunks, tolerating missing ones", async () => {
    const db = new FakeDb();
    await db.noteEmbeddings.put({
      noteId: "n1",
      providerKey: "gemini|native|gemini-embedding-001|2",
      dims: 2,
      vector: new Float32Array([1, 0]),
      contentHash: "abc123",
      updatedAt: 1,
    });
    await db.noteChunks.put({
      id: "n1#0",
      noteId: "n1",
      chunkIndex: 0,
      providerKey: "gemini|native|gemini-embedding-001|2",
      dims: 2,
      vector: new Float32Array([1, 0]),
      contentHash: "abc123",
      text: "Some note text",
      updatedAt: 1,
    });
    await invalidateNoteVector(asDb(db), "n1");
    expect(await db.noteEmbeddings.get("n1")).toBeUndefined();
    expect(await db.noteChunks.count()).toBe(0);
    await expect(invalidateNoteVector(asDb(db), "n1")).resolves.toBeUndefined();
  });
});

/* ---------------- Query path + blending ---------------- */

describe("semantic scores and result blending", () => {
  async function indexedDb(): Promise<{ db: FakeDb; target: AiEmbeddingTarget }> {
    stubEmbedFetch();
    const db = new FakeDb();
    const target = geminiTarget();
    await db.notes.put(baseNote({ id: "rain" }));
    await db.notes.put(baseNote({ id: "cats", title: "Cats", content: "<p>Cats are great.</p>" }));
    await buildIndex(asDb(db), target);
    return { db, target };
  }

  it("scores by cosine similarity against stored vectors", async () => {
    const { db, target } = await indexedDb();
    const scores = await semanticScores(asDb(db), "monsoon weather", target);
    expect(scores.get("rain")).toBeGreaterThan(0.9);
    expect(scores.get("cats")).toBeLessThan(0.5);
  });

  it("returns an empty map without an index or a target — and makes no call", async () => {
    const { calls } = stubEmbedFetch();
    const db = new FakeDb();
    expect((await semanticScores(asDb(db), "monsoon", geminiTarget())).size).toBe(0);
    expect((await semanticScores(asDb(db), "monsoon", null)).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("surfaces a semantic-only note above threshold with a plain-text snippet", async () => {
    const { db, target } = await indexedDb();
    const notes = await db.notes.toArray();
    const scores = await semanticScores(asDb(db), "monsoon weather", target);
    // Keyword search finds nothing for this query — the note only says "rain".
    expect(searchNotes("monsoon weather", notes, [], [])).toEqual([]);
    const merged = mergeSemanticResults([], scores, notes);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.note.id).toBe("rain");
    expect(merged[0]!.score).toBeGreaterThan(5);
    expect(merged[0]!.snippet).toContain("Heavy rain all week.");
  });

  it("semantic-only snippets keep list markers, plain notes unchanged", () => {
    const list = baseNote({
      id: "list",
      title: "Testing",
      content:
        '<ol start="1"><li>Hlw</li></ol><ul><li>1</li><li>2</li><li>3</li></ul><ol start="2"><li>Hi</li></ol>',
    });
    const plain = baseNote({ id: "plain", content: "<p>Heavy rain all week.</p>" });
    const merged = mergeSemanticResults(
      [],
      new Map([
        ["list", 0.9],
        ["plain", 0.9],
      ]),
      [list, plain],
    );
    const listHit = merged.find((r) => r.note.id === "list");
    expect(listHit).toBeDefined();
    expect(listHit!.snippet).toContain("1.");
    expect(listHit!.snippet).toContain("•");
    expect(listHit!.snippet).toContain("2. Hi");
    const plainHit = merged.find((r) => r.note.id === "plain");
    expect(plainHit!.snippet).toBe("Heavy rain all week.");
  });

  it("boosts keyword hits but never lets a stale vector surface an ineligible note", async () => {
    const { db, target } = await indexedDb();
    const notes = await db.notes.toArray();
    const scores = await semanticScores(asDb(db), "monsoon weather", target);

    const keyword = searchNotes("cats", notes, [], []);
    expect(keyword).toHaveLength(1);
    const boosted = mergeSemanticResults(keyword, new Map([["cats", 0.9]]), notes);
    expect(boosted[0]!.score).toBeCloseTo(keyword[0]!.score + 9);

    // A locked note with a (stale) perfect score is not added and not boosted.
    const locked = baseNote({ id: "locked", lock: FAKE_LOCK });
    const withLocked = [...notes, locked];
    const merged = mergeSemanticResults([], new Map([["locked", 1]]), withLocked);
    expect(merged).toEqual([]);

    // No scores → the exact keyword array back, untouched.
    expect(mergeSemanticResults(keyword, null, notes)).toBe(keyword);
    expect(mergeSemanticResults(keyword, new Map(), notes)).toBe(keyword);
  });

  it("keeps keyword-only ordering identical when every similarity is below threshold", async () => {
    const { db } = await indexedDb();
    const notes = await db.notes.toArray();
    const keyword = searchNotes("rain", notes, [], []);
    const merged = mergeSemanticResults(keyword, new Map([["rain", 0.2]]), notes);
    expect(merged.map((r) => r.note.id)).toEqual(keyword.map((r) => r.note.id));
    expect(merged[0]!.score).toBe(keyword[0]!.score);
  });
});

/* ---------------- Local-only proof ---------------- */

describe("embeddings never leave the device", () => {
  it("a backup built with an index present contains no vector data", async () => {
    stubEmbedFetch();
    const db = new FakeDb();
    await db.notes.put(baseNote({ id: "rain" }));
    await buildIndex(asDb(db), geminiTarget());
    await db.noteEmbeddings.put({
      noteId: "sentinel",
      providerKey: "gemini:SENTINEL-MODEL-XYZ:2",
      dims: 2,
      vector: new Float32Array([0.123456, 0.654321]),
      contentHash: "deadbeef",
      updatedAt: 1,
    });

    await db.noteChunks.put({
      id: "sentinel#0",
      noteId: "sentinel",
      chunkIndex: 0,
      providerKey: "gemini:SENTINEL-MODEL-XYZ:2",
      dims: 2,
      vector: new Float32Array([0.123456, 0.654321]),
      contentHash: "cafebabe",
      text: "CHUNK-SENTINEL-TEXT",
      updatedAt: 1,
    });

    const payload = await collectBackup(asDb(db), OWNER);
    expect(JSON.stringify(payload)).not.toContain("SENTINEL-MODEL-XYZ");
    expect(JSON.stringify(payload)).not.toContain("noteEmbeddings");
    expect(JSON.stringify(payload)).not.toContain("noteChunks");
    expect(JSON.stringify(payload)).not.toContain("CHUNK-SENTINEL-TEXT");
    expect(JSON.stringify(payload)).not.toContain("deadbeef");

    const { blob } = await buildBackupZip(asDb(db), OWNER);
    const rawText = new TextDecoder("latin1").decode(await blob.arrayBuffer());
    expect(rawText).not.toContain("SENTINEL-MODEL-XYZ");
    expect(rawText).not.toContain("CHUNK-SENTINEL-TEXT");
  });
});

/* ---------------- Chunking (Ask Noma) ---------------- */

/** A sentence of exactly `length` chars: a marker word, filler, and a full stop. */
function sentenceOf(marker: string, length: number): string {
  const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";
  let text = marker;
  while (text.length < length - 1) text += ` ${words}`;
  return `${text.slice(0, length - 1)}.`;
}

/** Every text sent to the (fake) provider across the given fetch calls. */
function embeddedTextsInCalls(calls: Array<{ body: string }>): string[] {
  return calls.flatMap((call) => {
    const parsed = JSON.parse(call.body) as {
      requests?: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    return (parsed.requests ?? []).map((r) => r.content.parts[0]!.text);
  });
}

describe("chunkNoteText", () => {
  it("returns no chunks for an empty or whitespace-only note", () => {
    expect(chunkNoteText(baseNote({ title: "", content: "" }))).toEqual([]);
    expect(chunkNoteText(baseNote({ title: "", content: "<p>   </p>" }))).toEqual([]);
  });

  it("keeps a short note as a single chunk equal to its embedded text, title first", () => {
    const note = baseNote({ title: "My Title", content: "<p>Hello world.</p>" });
    const chunks = chunkNoteText(note);
    expect(chunks).toEqual([embeddedTextForNote(note)]);
    expect(chunks[0]!.startsWith("My Title")).toBe(true);
  });

  it("is deterministic — same note in, same chunks and stable hashes out", () => {
    const content = `<p>${sentenceOf("Alpha", 300)} ${sentenceOf("Beta", 300)} ${sentenceOf("Gamma", 300)}</p>`;
    const a = chunkNoteText(baseNote({ title: "Long", content }));
    const b = chunkNoteText(baseNote({ title: "Long", content }));
    expect(a.length).toBeGreaterThan(1);
    expect(a).toEqual(b);
    expect(a.map((chunk) => fnv1a(chunk))).toEqual(b.map((chunk) => fnv1a(chunk)));
  });

  it("breaks at sentence boundaries when sentences fit, packing them whole", () => {
    const s1 = sentenceOf("One", 300);
    const s2 = sentenceOf("Two", 300);
    const s3 = sentenceOf("Three", 300);
    const chunks = chunkNoteText(baseNote({ title: "", content: `<p>${s1} ${s2} ${s3}</p>` }));
    expect(chunks).toHaveLength(2);
    // The first chunk is the first two sentences, rejoined exactly.
    expect(chunks[0]).toBe(`${s1} ${s2}`);
    expect(chunks[0]!.endsWith(".")).toBe(true);
    expect(chunks[1]).toContain(s3);
  });

  it("prefixes each later chunk with the previous chunk's tail (overlap)", () => {
    const s1 = sentenceOf("One", 300);
    const s2 = sentenceOf("Two", 300);
    const s3 = sentenceOf("Three", 300);
    const chunks = chunkNoteText(baseNote({ title: "", content: `<p>${s1} ${s2} ${s3}</p>` }));
    const overlapLine = chunks[1]!.split("\n")[0]!;
    expect(overlapLine.length).toBeGreaterThan(0);
    expect(chunks[0]).toContain(overlapLine);
    expect(chunks[1]!.length).toBeGreaterThan(s3.length);
  });

  it("hard-splits a run with no sentence boundaries, at the size cap", () => {
    const words = Array.from({ length: 300 }, () => "word").join(" ");
    const chunks = chunkNoteText(baseNote({ title: "", content: `<p>${words}</p>` }));
    expect(chunks).toHaveLength(3);
    // The first slice fills the cap (minus a trimmed trailing space).
    expect(chunks[0]!.length).toBeGreaterThan(CHUNK_MAX_CHARS - 5);
    expect(chunks[0]!.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS + CHUNK_OVERLAP_CHARS + 1);
    }
  });

  it("never chunks text past the EMBED_MAX_CHARS cap", () => {
    const body = `${sentenceOf("Head", 500)} ${"filler ".repeat(1200)}ZZZTAILMARKER`;
    const chunks = chunkNoteText(baseNote({ title: "Cap", content: `<p>${body}</p>` }));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(12);
    expect(chunks.join("\n")).not.toContain("ZZZTAILMARKER");
  });
});

/* ---------------- Chunk index lifecycle (Ask Noma) ---------------- */

/** A note whose text runs to three chunks (title + five ~320-char sentences). */
function longNote(id: string): Note {
  const body = [0, 1, 2, 3, 4].map((i) => sentenceOf(`Part${i}`, 320)).join(" ");
  return baseNote({ id, title: `Long ${id}`, content: `<p>${body}</p>` });
}

/** Like stubEmbedFetch, but aborts the controller during the Nth provider call. */
function stubEmbedFetchAbortingAfter(controller: AbortController, abortOnCall: number): void {
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls++;
      const body = String(init?.body ?? "");
      const parsed = JSON.parse(body) as {
        requests?: Array<{ content: { parts: Array<{ text: string }> } }>;
      };
      const texts = (parsed.requests ?? []).map((r) => r.content.parts[0]!.text);
      if (calls >= abortOnCall) controller.abort();
      return new Response(
        JSON.stringify({ embeddings: texts.map((text) => ({ values: fakeVector(text) })) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
}

describe("chunk index lifecycle", () => {
  it("build stores chunk rows keyed noteId#index with text, hash and the note's providerKey", async () => {
    stubEmbedFetch();
    const db = new FakeDb();
    const target = geminiTarget();
    const note = baseNote({ id: "rain" });
    await db.notes.put(note);
    await buildIndex(asDb(db), target);

    const chunks = await db.noteChunks.toArray();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      id: "rain#0",
      noteId: "rain",
      chunkIndex: 0,
      text: embeddedTextForNote(note),
      contentHash: fnv1a(embeddedTextForNote(note)),
      providerKey: "gemini|native|gemini-embedding-001|2",
      dims: 2,
    });
  });

  it("a pre-chunk index reads chunks-pending; Update backfills chunks without re-embedding note vectors", async () => {
    const { calls } = stubEmbedFetch();
    const db = new FakeDb();
    const target = geminiTarget();
    await db.notes.put(baseNote({ id: "rain" }));
    await db.notes.put(longNote("long"));
    await buildIndex(asDb(db), target);
    const chunkTotal = await db.noteChunks.count();
    expect(chunkTotal).toBe(4);

    // Simulate an index built before the chunk half existed.
    await db.noteChunks.clear();
    const before = await getIndexStatus(asDb(db), target);
    expect(before.state).toBe("ready");
    expect(before.staleCount).toBe(0);
    expect(before.chunkCount).toBe(0);
    expect(before.chunksStaleCount).toBe(2);

    const callsBefore = calls.length;
    const result = await reconcileIndex(asDb(db), target);
    expect(result).toEqual({ embedded: 2, deleted: 0, unchanged: 0 });
    // Only chunk texts went to the provider — no note text was resent,
    // and every text sent is chunk-sized, never a whole long note.
    const sent = embeddedTextsInCalls(calls.slice(callsBefore));
    expect(sent).toHaveLength(chunkTotal);
    expect(sent.every((text) => text.length <= CHUNK_MAX_CHARS + CHUNK_OVERLAP_CHARS + 1)).toBe(
      true,
    );

    const after = await getIndexStatus(asDb(db), target);
    expect(after.chunkCount).toBe(chunkTotal);
    expect(after.chunksStaleCount).toBe(0);
  });

  it("reconcile re-chunks only the changed note; the other note's chunks are untouched", async () => {
    const { calls } = stubEmbedFetch();
    const db = new FakeDb();
    const target = geminiTarget();
    await db.notes.put(baseNote({ id: "rain" }));
    await db.notes.put(longNote("long"));
    await buildIndex(asDb(db), target);
    const longHashesBefore = (await db.noteChunks.toArray())
      .filter((row) => row.noteId === "long")
      .map((row) => row.contentHash);

    await db.notes.put(baseNote({ id: "rain", content: "<p>Rain, changed.</p>" }));
    const callsBefore = calls.length;
    const result = await reconcileIndex(asDb(db), target);
    expect(result).toEqual({ embedded: 1, deleted: 0, unchanged: 1 });
    const sent = embeddedTextsInCalls(calls.slice(callsBefore));
    expect(sent).toHaveLength(2); // the changed note's vector + its single chunk
    expect(sent.every((text) => text.includes("changed"))).toBe(true);
    const longHashesAfter = (await db.noteChunks.toArray())
      .filter((row) => row.noteId === "long")
      .map((row) => row.contentHash);
    expect(longHashesAfter).toEqual(longHashesBefore);
  });

  it("a build cancelled in the chunk phase keeps all vectors and reports every chunk pending", async () => {
    const controller = new AbortController();
    stubEmbedFetchAbortingAfter(controller, 2);
    const db = new FakeDb();
    const target = geminiTarget();
    for (let i = 0; i < 30; i++) {
      await db.notes.put(baseNote({ id: `n${i}`, title: `Note ${i}` }));
    }
    await expect(buildIndex(asDb(db), target, { signal: controller.signal })).rejects.toMatchObject(
      { name: "AbortError" },
    );
    expect(await db.noteEmbeddings.count()).toBe(30);
    expect(await db.noteChunks.count()).toBe(0);
    const status = await getIndexStatus(asDb(db), target);
    expect(status.state).toBe("ready");
    expect(status.staleCount).toBe(0);
    expect(status.chunksStaleCount).toBe(30);
  });

  it("embedNoteIfIndexed backfills a pre-chunk note's chunks on save, without re-embedding its vector", async () => {
    const { calls } = stubEmbedFetch();
    const db = new FakeDb();
    const target = geminiTarget();
    const note = longNote("long");
    await db.notes.put(note);
    await buildIndex(asDb(db), target);
    await db.noteChunks.clear();

    const callsBefore = calls.length;
    await embedNoteIfIndexed(asDb(db), note, target);
    expect(await db.noteChunks.count()).toBe(3);
    const sent = embeddedTextsInCalls(calls.slice(callsBefore));
    expect(sent).toHaveLength(3);
    // The ~1,600-char whole-note vector text was never resent.
    expect(sent.every((text) => text.length < 1000)).toBe(true);
  });
});

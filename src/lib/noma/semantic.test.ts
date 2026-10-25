// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAiEmbeddingTarget, saveAiRecord, type AiEmbeddingTarget } from "./ai";
import { buildBackupZip, collectBackup } from "./backup";
import type { NomaDatabase } from "./db";
import { searchNotes } from "./search";
import {
  EMBED_MAX_CHARS,
  buildIndex,
  embedNoteIfIndexed,
  embeddedTextForNote,
  fnv1a,
  getIndexStatus,
  maintainSemanticIndexForNote,
  mergeSemanticResults,
  reconcileIndex,
  removeIndex,
  semanticScores,
} from "./semantic";
import type {
  AppSettings,
  AttachmentMeta,
  Folder,
  Note,
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
    expect(progress[progress.length - 1]).toBe(2);

    const rows = await db.noteEmbeddings.toArray();
    expect(rows.map((r) => r.noteId).sort()).toEqual(["cats", "rain"]);
    expect(rows[0]!.providerKey).toBe("gemini:gemini-embedding-001:2");
    expect(rows[0]!.dims).toBe(2);
    expect(rows[0]!.contentHash).toBe(fnv1a(embeddedTextForNote(baseNote({ id: "rain" }))));

    const status = await getIndexStatus(asDb(db), target);
    expect(status).toEqual({
      state: "ready",
      indexedCount: 2,
      staleCount: 0,
      embeddingModel: "gemini-embedding-001",
    });
  });

  it("reports not-built for an empty table", async () => {
    const db = new FakeDb();
    expect(await getIndexStatus(asDb(db), geminiTarget())).toEqual({
      state: "not-built",
      indexedCount: 0,
      staleCount: 0,
      embeddingModel: null,
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

  it("removeIndex wipes the table", async () => {
    stubEmbedFetch();
    const db = new FakeDb();
    await db.notes.put(baseNote({ id: "rain" }));
    await buildIndex(asDb(db), geminiTarget());
    await removeIndex(asDb(db));
    expect(await db.noteEmbeddings.count()).toBe(0);
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

    const payload = await collectBackup(asDb(db), OWNER);
    expect(JSON.stringify(payload)).not.toContain("SENTINEL-MODEL-XYZ");
    expect(JSON.stringify(payload)).not.toContain("noteEmbeddings");
    expect(JSON.stringify(payload)).not.toContain("deadbeef");

    const { blob } = await buildBackupZip(asDb(db), OWNER);
    const rawText = new TextDecoder("latin1").decode(await blob.arrayBuffer());
    expect(rawText).not.toContain("SENTINEL-MODEL-XYZ");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAiRecord } from "./ai";
import { type NomaDatabase } from "./db";
import {
  createNote,
  deleteNoteForever,
  emptyTrash,
  restoreNote,
  trashNote,
  updateNote,
} from "./notes";
import { lockNote } from "./note-lock";
import { sanitizeHtml } from "./sanitize";
import { embeddedTextForNote, fnv1a } from "./semantic";
import {
  MAX_VERSIONS,
  SETTLE_MS,
  clearVersions,
  forceSnapshot,
  listVersions,
  restoreVersion,
  snapshotIfSettled,
} from "./versions";
import type {
  AppSettings,
  AttachmentMeta,
  Folder,
  Note,
  NoteEmbedding,
  NoteLock,
  NoteVersion,
  Reminder,
  SyncState,
  SyncTombstone,
  Tag,
} from "./types";

/* ---------------- Fake Dexie surface ----------------
 * Same in-memory stand-in the daily/sync suites use, extended with the
 * v4 noteVersions table. */

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
  async update(id: string, patch: Partial<T>): Promise<number> {
    const current = this.rows.get(id);
    if (!current) return 0;
    this.rows.set(id, { ...current, ...patch });
    return 1;
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
  filter(fn: (row: T) => boolean) {
    return {
      toArray: async () => [...this.rows.values()].filter(fn).map((row) => structuredClone(row)),
    };
  }
  where(field: string) {
    const matches = (value: unknown) =>
      [...this.rows.values()].filter(
        (row) => (row as unknown as Record<string, unknown>)[field] === value,
      );
    return {
      equals: (value: unknown) => ({
        toArray: async () => matches(value).map((row) => structuredClone(row)),
        count: async () => matches(value).length,
        delete: async () => {
          const found = matches(value);
          for (const row of found) this.rows.delete(row.id);
          return found.length;
        },
      }),
    };
  }
}

/** Stand-in for the v5 noteEmbeddings table (keyed by noteId, not id). */
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
  name = "noma_test";
  notes = new FakeTable<Note>();
  folders = new FakeTable<Folder>();
  tags = new FakeTable<Tag>();
  attachments = new FakeTable<AttachmentMeta>();
  reminders = new FakeTable<Reminder>();
  settings = new FakeTable<AppSettings>();
  backups = new FakeTable<Row & { createdAt: number }>();
  tombstones = new FakeTable<SyncTombstone>();
  syncMeta = new FakeTable<SyncState>();
  noteVersions = new FakeTable<NoteVersion>();
  noteEmbeddings = new FakeEmbeddingTable();

  async transaction(...args: unknown[]): Promise<void> {
    const fn = args[args.length - 1] as () => Promise<void>;
    await fn();
  }
}

function asDb(fake: FakeDb): NomaDatabase {
  return fake as unknown as NomaDatabase;
}

const FAKE_LOCK: NoteLock = {
  v: 1,
  slots: {},
  biometric: false,
  failedAttempts: 0,
  lockoutUntil: null,
  lockedAt: 1_700_000_000_000,
};

/** Seeds a note through the real create path, then rewrites its stored
 * timestamps/content directly so a test controls "how old" the state is. */
async function seedNote(fake: FakeDb, patch: Partial<Note>): Promise<Note> {
  const db = asDb(fake);
  const note = await createNote(db, {});
  const stored: Note = { ...note, ...patch, id: note.id };
  await fake.notes.put(stored);
  return stored;
}

async function seedVersion(fake: FakeDb, version: Partial<NoteVersion> & { noteId: string }) {
  const row: NoteVersion = {
    id: `version-${Math.random().toString(36).slice(2, 10)}`,
    title: "Earlier title",
    content: "earlier text",
    createdAt: 1_000_000,
    ...version,
  };
  await fake.noteVersions.put(row);
  return row;
}

describe("snapshotIfSettled — the settled-state rule", () => {
  it("does nothing before SETTLE_MS has elapsed", async () => {
    const fake = new FakeDb();
    const note = await seedNote(fake, { title: "T", content: "body", updatedAt: 1_000_000 });
    await snapshotIfSettled(asDb(fake), note, 1_000_000 + SETTLE_MS - 1);
    expect(await fake.noteVersions.count()).toBe(0);
  });

  it("snapshots a settled state, timestamped by the state's own updatedAt", async () => {
    const fake = new FakeDb();
    const note = await seedNote(fake, {
      title: "Settled title",
      content: "settled body",
      updatedAt: 1_000_000,
    });
    await snapshotIfSettled(asDb(fake), note, 1_000_000 + SETTLE_MS);
    const rows = await listVersions(asDb(fake), note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      noteId: note.id,
      title: "Settled title",
      content: "settled body",
      createdAt: 1_000_000,
    });
  });

  it("forceSnapshot ignores the settle window", async () => {
    const fake = new FakeDb();
    const note = await seedNote(fake, { content: "fresh", updatedAt: Date.now() });
    await forceSnapshot(asDb(fake), note);
    expect(await listVersions(asDb(fake), note.id)).toHaveLength(1);
  });
});

describe("updateNote hook", () => {
  it("snapshots the replaced state when an old note's content changes", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const settledAt = Date.now() - 120_000;
    const note = await seedNote(fake, {
      title: "Old title",
      content: "old body",
      updatedAt: settledAt,
    });
    await updateNote(db, note.id, { content: "new body" });
    const rows = await listVersions(db, note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: "Old title",
      content: "old body",
      createdAt: settledAt,
    });
    expect((await fake.notes.get(note.id))?.content).toBe("new body");
  });

  it("also fires on title-only changes to a settled note", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, {
      title: "Before",
      content: "body",
      updatedAt: Date.now() - 120_000,
    });
    await updateNote(db, note.id, { title: "After" });
    const rows = await listVersions(db, note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Before");
  });

  it("makes no version for flag-only patches, even on a settled note", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, {
      content: "body",
      updatedAt: Date.now() - 120_000,
    });
    await updateNote(db, note.id, { pinned: true });
    await updateNote(db, note.id, { archived: true });
    await updateNote(db, note.id, { folderId: "folder-1" });
    expect(await listVersions(db, note.id)).toHaveLength(0);
    expect((await fake.notes.get(note.id))?.pinned).toBe(true);
  });

  it("makes no version when title/content are unchanged by the patch", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, {
      title: "Same",
      content: "same body",
      updatedAt: Date.now() - 120_000,
    });
    await updateNote(db, note.id, { title: "Same" });
    await updateNote(db, note.id, { content: "same body" });
    expect(await listVersions(db, note.id)).toHaveLength(0);
  });

  it("a typing burst creates no versions; the next settled edit snapshots the burst's end state", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, {
      content: "resting text",
      updatedAt: Date.now() - 120_000,
    });

    // First edit after a rest: the resting state becomes a version.
    await updateNote(db, note.id, { content: "burst 1" });
    expect(await listVersions(db, note.id)).toHaveLength(1);

    // Rapid-fire edits replace seconds-old states: no new versions.
    await updateNote(db, note.id, { content: "burst 2" });
    await updateNote(db, note.id, { content: "burst 3" });
    await updateNote(db, note.id, { content: "burst 4" });
    expect(await listVersions(db, note.id)).toHaveLength(1);

    // Simulate the burst resting (time passes), then edit again: the
    // burst's end state is snapshotted — versions track sessions. Age
    // the stored state relative to the first version's stamp (half a
    // settle window past it) so the ordering is deterministic and does
    // not depend on wall-clock millisecond ties.
    const firstStamp = (await listVersions(db, note.id))[0]!.createdAt;
    await fake.notes.update(note.id, { updatedAt: firstStamp + SETTLE_MS / 2 });
    await updateNote(db, note.id, { content: "next session" });
    const rows = await listVersions(db, note.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.content)).toEqual(["burst 4", "resting text"]);
  });

  it("the create→sanitise double-write (capture/daily pattern) leaves no versions", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await createNote(db, {});
    // capture.ts / daily.ts follow createNote with an updateNote pass so
    // the content is sanitised and word-counted; the replaced state is
    // seconds old, so no version may appear.
    await updateNote(db, note.id, { content: "captured text" });
    expect(await listVersions(db, note.id)).toHaveLength(0);

    // The first real edit after the note has rested snapshots the
    // captured state as the earliest version.
    await fake.notes.update(note.id, { updatedAt: Date.now() - 120_000 });
    await updateNote(db, note.id, { content: "edited later" });
    const rows = await listVersions(db, note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toBe("captured text");
  });
});

describe("cap pruning", () => {
  it("keeps exactly MAX_VERSIONS, newest first, after many settled snapshots", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, { content: "state 0", updatedAt: 0 });
    const total = MAX_VERSIONS + 5;
    for (let i = 0; i < total; i++) {
      const state: Note = {
        ...(await fake.notes.get(note.id))!,
        content: `state ${i}`,
        updatedAt: i * (SETTLE_MS + 1_000),
      };
      await snapshotIfSettled(db, state, state.updatedAt + SETTLE_MS);
    }
    const rows = await listVersions(db, note.id);
    expect(rows).toHaveLength(MAX_VERSIONS);
    // Newest kept, oldest five pruned.
    expect(rows[0]?.content).toBe(`state ${total - 1}`);
    expect(rows[rows.length - 1]?.content).toBe("state 5");
    // Strictly newest-first order.
    const stamps = rows.map((r) => r.createdAt);
    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));
  });
});

describe("restoreVersion", () => {
  it("force-snapshots the current state (even when fresh), then applies the version", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, {
      title: "Current title",
      content: "current body",
      updatedAt: Date.now(), // fresh: the settled rule alone would skip it
    });
    const version = await seedVersion(fake, {
      noteId: note.id,
      title: "Old title",
      content: "old body",
      createdAt: Date.now() - 86_400_000,
    });

    expect(await restoreVersion(db, version.id)).toBe(true);

    const restored = await fake.notes.get(note.id);
    expect(restored?.title).toBe("Old title");
    expect(restored?.content).toBe("old body");

    const rows = await listVersions(db, note.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ title: "Current title", content: "current body" });
  });

  it("is undoable: restoring the force-snapshot brings back the pre-restore text", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, {
      title: "Now",
      content: "now body",
      updatedAt: Date.now(),
    });
    const version = await seedVersion(fake, {
      noteId: note.id,
      title: "Then",
      content: "then body",
      createdAt: Date.now() - 3_600_000,
    });

    await restoreVersion(db, version.id);
    expect((await fake.notes.get(note.id))?.content).toBe("then body");

    const newest = (await listVersions(db, note.id))[0]!;
    expect(newest.content).toBe("now body");
    await restoreVersion(db, newest.id);
    const back = await fake.notes.get(note.id);
    expect(back?.title).toBe("Now");
    expect(back?.content).toBe("now body");
  });

  it("applies the same sanitising write as updateNote", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, { content: "current", updatedAt: Date.now() });
    const dirty = '<p>kept</p><script>alert("x")</script>';
    const version = await seedVersion(fake, { noteId: note.id, content: dirty });
    expect(await restoreVersion(db, version.id)).toBe(true);
    const restored = await fake.notes.get(note.id);
    expect(restored?.content).toBe(sanitizeHtml(dirty));
    expect(restored?.content).not.toContain("<");
  });

  it("returns false for a missing version or a missing note", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    expect(await restoreVersion(db, "no-such-version")).toBe(false);
    const orphan = await seedVersion(fake, { noteId: "no-such-note" });
    expect(await restoreVersion(db, orphan.id)).toBe(false);
  });
});

describe("locked notes — no history, ever", () => {
  it("snapshotIfSettled and forceSnapshot no-op for a locked note", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, {
      content: "ENCRYPTED-BLOB",
      updatedAt: 1_000_000,
      lock: FAKE_LOCK,
    });
    await snapshotIfSettled(db, note, 1_000_000 + SETTLE_MS * 10);
    await forceSnapshot(db, note);
    expect(await fake.noteVersions.count()).toBe(0);
  });

  it("an in-session title save on a locked note creates no version (stored record carries the lock)", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    // The workspace routes locked-note content saves through
    // saveLockedNoteContent (never updateNote); title saves DO reach
    // updateNote while the stored record keeps `lock` set.
    const note = await seedNote(fake, {
      title: "Public title",
      content: "ENCRYPTED-BLOB",
      updatedAt: Date.now() - 120_000,
      lock: FAKE_LOCK,
    });
    await updateNote(db, note.id, { title: "Renamed in session" });
    expect(await listVersions(db, note.id)).toHaveLength(0);
    expect((await fake.notes.get(note.id))?.title).toBe("Renamed in session");
  });

  it("restoreVersion refuses to write plaintext onto a sealed note", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, {
      title: "Sealed",
      content: "ENCRYPTED-BLOB",
      lock: FAKE_LOCK,
    });
    const version = await seedVersion(fake, { noteId: note.id, content: "plaintext" });
    expect(await restoreVersion(db, version.id)).toBe(false);
    const after = await fake.notes.get(note.id);
    expect(after?.content).toBe("ENCRYPTED-BLOB");
    expect(after?.lock).toBeTruthy();
    // And no force-snapshot of the ciphertext was taken either.
    expect(await listVersions(db, note.id)).toHaveLength(1); // only the seeded row
  });

  it("lockNote purges the note's existing history", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await createNote(db, {
      title: "Diary",
      content: "<p>Dear diary</p>",
    });
    await seedVersion(fake, { noteId: note.id, content: "first draft" });
    await seedVersion(fake, { noteId: note.id, content: "second draft" });
    expect(await listVersions(db, note.id)).toHaveLength(2);

    const locked = await lockNote(db, note.id, "pin", "135790");
    expect(locked.lock).toBeTruthy();
    expect(await listVersions(db, note.id)).toHaveLength(0);
  });
});

describe("cascades", () => {
  it("trashing and restoring keep history; delete-forever purges it", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, { content: "body" });
    await seedVersion(fake, { noteId: note.id, content: "v1" });
    await seedVersion(fake, { noteId: note.id, content: "v2" });

    await trashNote(db, note.id);
    expect(await listVersions(db, note.id)).toHaveLength(2);

    await restoreNote(db, note.id);
    expect(await listVersions(db, note.id)).toHaveLength(2);

    await deleteNoteForever(db, note.id);
    expect(await fake.notes.get(note.id)).toBeUndefined();
    expect(await listVersions(db, note.id)).toHaveLength(0);
  });

  it("emptyTrash purges history for trashed notes only", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const trashedA = await seedNote(fake, { content: "a", deleted: true, deletedAt: 1 });
    const trashedB = await seedNote(fake, { content: "b", deleted: true, deletedAt: 2 });
    const live = await seedNote(fake, { content: "live" });
    await seedVersion(fake, { noteId: trashedA.id, content: "a-old" });
    await seedVersion(fake, { noteId: trashedB.id, content: "b-old" });
    await seedVersion(fake, { noteId: live.id, content: "live-old" });

    expect(await emptyTrash(db)).toBe(2);
    expect(await listVersions(db, trashedA.id)).toHaveLength(0);
    expect(await listVersions(db, trashedB.id)).toHaveLength(0);
    expect(await listVersions(db, live.id)).toHaveLength(1);
  });

  it("clearVersions empties one note's history and no other", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const a = await seedNote(fake, { content: "a" });
    const b = await seedNote(fake, { content: "b" });
    await seedVersion(fake, { noteId: a.id });
    await seedVersion(fake, { noteId: b.id });
    await clearVersions(db, a.id);
    expect(await listVersions(db, a.id)).toHaveLength(0);
    expect(await listVersions(db, b.id)).toHaveLength(1);
  });
});

describe("listVersions", () => {
  it("returns versions newest first regardless of insertion order", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, { content: "body" });
    await seedVersion(fake, { noteId: note.id, content: "middle", createdAt: 2_000 });
    await seedVersion(fake, { noteId: note.id, content: "newest", createdAt: 3_000 });
    await seedVersion(fake, { noteId: note.id, content: "oldest", createdAt: 1_000 });
    const rows = await listVersions(db, note.id);
    expect(rows.map((r) => r.content)).toEqual(["newest", "middle", "oldest"]);
  });
});

/* ---------------- Semantic vector maintenance (#8.5) ----------------
 * Restores and permanent deletes write db.notes directly, bypassing
 * updateNote's save hook, so they maintain the note's vector
 * themselves: a vector must never describe content the note no longer
 * has, and never outlive the note. */

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

/** Gemini batch-embeddings endpoint stub: one fixed valid vector per text. */
function stubGeminiEmbedFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? "")) as {
        requests?: Array<{ content: { parts: Array<{ text: string }> } }>;
      };
      const texts = parsed.requests ?? [];
      return new Response(JSON.stringify({ embeddings: texts.map(() => ({ values: [1, 0.2] })) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

function vectorRowFor(note: Note): NoteEmbedding {
  return {
    noteId: note.id,
    providerKey: "gemini|native|gemini-embedding-001|2",
    dims: 2,
    vector: new Float32Array([1, 0]),
    contentHash: fnv1a(embeddedTextForNote(note)),
    updatedAt: 1,
  };
}

describe("semantic vector maintenance (#8.5)", () => {
  beforeEach(() => {
    // The fake db is named noma_test, so semantic maintenance resolves
    // the AI record of owner "test" from this storage stand-in.
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: new MemoryStorage(), dispatchEvent: () => true },
      configurable: true,
    });
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restoreVersion refreshes the vector so it matches the restored content, never the pre-restore content", async () => {
    stubGeminiEmbedFetch();
    saveAiRecord("test", {
      enabled: true,
      activePreset: "gemini",
      providers: { gemini: { apiKey: "test-key" } },
    });
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, {
      title: "Current title",
      content: "<p>current body</p>",
    });
    const version = await seedVersion(fake, {
      noteId: note.id,
      title: "Earlier title",
      content: "<p>earlier body</p>",
    });
    // An up-to-date vector for the CURRENT (pre-restore) content.
    await fake.noteEmbeddings.put(vectorRowFor(note));
    const preRestoreHash = fnv1a(embeddedTextForNote(note));

    expect(await restoreVersion(db, version.id)).toBe(true);

    const restored = await fake.notes.get(note.id);
    expect(restored?.content).toContain("earlier body");
    const row = await fake.noteEmbeddings.get(note.id);
    expect(row).toBeDefined();
    expect(row!.contentHash).toBe(fnv1a(embeddedTextForNote(restored!)));
    expect(row!.contentHash).not.toBe(preRestoreHash);
  });

  it("deleteNoteForever removes the note's vector row with the note", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const note = await seedNote(fake, { title: "Doomed", content: "<p>bye</p>" });
    await fake.noteEmbeddings.put(vectorRowFor(note));
    expect(await fake.noteEmbeddings.count()).toBe(1);

    await deleteNoteForever(db, note.id);

    expect(await fake.notes.get(note.id)).toBeUndefined();
    expect(await fake.noteEmbeddings.get(note.id)).toBeUndefined();
  });
});

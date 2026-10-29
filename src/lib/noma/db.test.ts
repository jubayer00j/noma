import { describe, expect, it } from "vitest";
import { NomaDatabase, copyDatabase } from "./db";
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

/* ---------------- Dexie v6 schema (Ask Noma chunk index) ---------------- */

describe("NomaDatabase schema v6", () => {
  it("registers version 6 with the noteChunks table, keeping v5 tables", () => {
    const db = new NomaDatabase("noma_schema_probe");
    expect(db.verno).toBe(6);
    const versions = (
      db as unknown as {
        _versions: Array<{ _cfg: { storesSource: Record<string, string> } }>;
      }
    )._versions;
    const latest = versions[versions.length - 1]!._cfg.storesSource;
    expect(latest["noteChunks"]).toBe("id, noteId");
    expect(latest["noteEmbeddings"]).toBe("noteId");
    // The v4 local-only history table and the core tables survive.
    expect(latest["noteVersions"]).toBe("id, noteId");
    expect(latest["notes"]).toContain("id");
    expect(latest["syncMeta"]).toBe("id");
  });
});

/* ---------------- copyDatabase exclusion ----------------
 * Minimal in-memory stand-ins for the two databases, following the
 * fake-table pattern of the other suites. */

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
  async toArray(): Promise<T[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
}

class FakeEmbeddingTable {
  rows = new Map<string, NoteEmbedding>();
  async put(row: NoteEmbedding): Promise<string> {
    this.rows.set(row.noteId, structuredClone(row));
    return row.noteId;
  }
  async bulkPut(rows: NoteEmbedding[]): Promise<void> {
    for (const row of rows) this.rows.set(row.noteId, structuredClone(row));
  }
  async toArray(): Promise<NoteEmbedding[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
}

class FakeDb {
  notes = new FakeTable<Note>();
  folders = new FakeTable<Folder>();
  tags = new FakeTable<Tag>();
  attachments = new FakeTable<AttachmentMeta>();
  settings = new FakeTable<AppSettings>();
  backups = new FakeTable<Row & { createdAt: number }>();
  reminders = new FakeTable<Reminder>();
  tombstones = new FakeTable<SyncTombstone>();
  noteEmbeddings = new FakeEmbeddingTable();
  noteChunks = new FakeTable<NoteChunk>();

  async transaction(...args: unknown[]): Promise<void> {
    const fn = args[args.length - 1] as () => Promise<void>;
    await fn();
  }
}

function baseNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "n1",
    title: "Trip notes",
    content: "<p>Pack the camera.</p>",
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
    wordCount: 3,
    ...overrides,
  };
}

describe("copyDatabase", () => {
  it("copies content but never the semantic index (local-only derived data)", async () => {
    const source = new FakeDb();
    const target = new FakeDb();
    await source.notes.put(baseNote());
    await source.noteEmbeddings.put({
      noteId: "n1",
      providerKey: "gemini:gemini-embedding-001:2",
      dims: 2,
      vector: new Float32Array([0.6, 0.8]),
      contentHash: "abc123",
      updatedAt: 1,
    });
    await source.noteChunks.put({
      id: "n1#0",
      noteId: "n1",
      chunkIndex: 0,
      providerKey: "gemini:gemini-embedding-001:2",
      dims: 2,
      vector: new Float32Array([0.6, 0.8]),
      contentHash: "def456",
      text: "Trip notes\nPack the camera.",
      updatedAt: 1,
    });

    await copyDatabase(source as unknown as NomaDatabase, target as unknown as NomaDatabase);

    expect(await target.notes.toArray()).toHaveLength(1);
    expect(await target.noteEmbeddings.toArray()).toEqual([]);
    expect(await target.noteChunks.toArray()).toEqual([]);
  });
});

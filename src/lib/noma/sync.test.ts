import JSZip from "jszip";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyBackup,
  buildBackupZip,
  collectBackup,
  readBackupZip,
  type BackupPayload,
} from "./backup";
import { type NomaDatabase } from "./db";
import { embeddedTextForNote, fnv1a } from "./semantic";
import {
  collectLibrarySnapshot,
  computeSyncHashes,
  entityContentHash,
  getSyncState,
  librarySyncSignature,
  planMerge,
  recordTombstone,
  syncNow,
  type LibrarySnapshot,
  type SyncDriveDeps,
} from "./sync";
import type {
  AppSettings,
  AttachmentMeta,
  Folder,
  Note,
  NoteChunk,
  NoteEmbedding,
  NoteLock,
  Reminder,
  SyncState,
  SyncTombstone,
  Tag,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

/* ---------------- Fake Dexie surface ----------------
 * The existing suites avoid a real IndexedDB; sync tests follow the same
 * pattern with an in-memory stand-in for the tables the sync/backup code
 * touches. */

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
  noteEmbeddings = new FakeEmbeddingTable();
  noteChunks = new FakeTable<NoteChunk>();

  async transaction(...args: unknown[]): Promise<void> {
    const fn = args[args.length - 1] as () => Promise<void>;
    await fn();
  }
}

function asDb(fake: FakeDb): NomaDatabase {
  return fake as unknown as NomaDatabase;
}

async function seedSettings(db: FakeDb, patch: Partial<AppSettings> = {}): Promise<void> {
  await db.settings.put({ ...DEFAULT_SETTINGS, backupMode: "sync", ...patch });
}

/* ---------------- Entity factories ---------------- */

const T0 = 1_700_000_000_000;

function makeNote(id: string, extra: Partial<Note> = {}): Note {
  return {
    id,
    title: `Note ${id}`,
    content: `<p>content ${id}</p>`,
    contentFormat: "tiptap-html",
    createdAt: T0,
    updatedAt: T0,
    folderId: null,
    tagIds: [],
    pinned: false,
    favorite: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    reminderAt: null,
    wordCount: 2,
    ...extra,
  };
}

function makeFolder(id: string, extra: Partial<Folder> = {}): Folder {
  return { id, name: `Folder ${id}`, parentId: null, createdAt: T0, updatedAt: T0, ...extra };
}

function makeTag(id: string, extra: Partial<Tag> = {}): Tag {
  return { id, name: `tag-${id}`, createdAt: T0, updatedAt: T0, ...extra };
}

function makeAttachment(
  id: string,
  noteId: string,
  extra: Partial<AttachmentMeta> = {},
): AttachmentMeta {
  return {
    id,
    noteId,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 10,
    createdAt: T0,
    updatedAt: T0,
    data: "data:image/png;base64,AAAA",
    ...extra,
  };
}

function makeReminder(id: string, noteId: string, extra: Partial<Reminder> = {}): Reminder {
  return {
    id,
    noteId,
    scheduledAt: T0 - 60_000,
    status: "pending",
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

function makePayload(partial: Partial<BackupPayload> = {}): BackupPayload {
  return {
    manifest: {
      backupFormatVersion: 2,
      nomaVersion: "1.2.0",
      createdAt: new Date(T0).toISOString(),
      noteCount: 0,
      folderCount: 0,
      tagCount: 0,
      attachmentCount: 0,
      ownerId: null,
      libraryId: "noma_test",
      deviceId: "device-b",
    },
    notes: [],
    folders: [],
    tags: [],
    attachments: [],
    reminders: [],
    settings: null,
    tombstones: [],
    deviceId: "device-b",
    ...partial,
  };
}

function snapshot(partial: Partial<LibrarySnapshot> = {}): LibrarySnapshot {
  return {
    notes: [],
    folders: [],
    tags: [],
    attachments: [],
    reminders: [],
    tombstones: [],
    ...partial,
  };
}

/* ---------------- Hash behaviour ---------------- */

describe("content hashes", () => {
  it("ignores device-local and derived fields", () => {
    const reminder = makeReminder("r1", "n1", { notificationId: 42 });
    expect(entityContentHash("reminder", reminder)).toBe(
      entityContentHash("reminder", { ...reminder, notificationId: 99 }),
    );

    const lock: NoteLock = {
      v: 1,
      slots: { password: { salt: "s", iterations: 1, wrappedKey: "w" } },
      biometric: false,
      failedAttempts: 0,
      lockoutUntil: null,
      lockedAt: T0,
    };
    const note = makeNote("n1", { lock, content: "envelope" });
    expect(entityContentHash("note", note)).toBe(
      entityContentHash("note", {
        ...note,
        lock: { ...lock, failedAttempts: 4, lockoutUntil: T0 + 30_000 },
        wordCount: 0,
      }),
    );
    // ...but real changes still register.
    expect(entityContentHash("note", note)).not.toBe(
      entityContentHash("note", { ...note, content: "other envelope" }),
    );
  });
});

/* ---------------- planMerge + applyBackup ---------------- */

describe("three-way merge", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  it("applies a remote-only change and keeps a local-only change", async () => {
    const baseNote = makeNote("n1");
    const baseOther = makeNote("n2");
    const base = snapshot({ notes: [baseNote, baseOther] });
    const baseHashes = computeSyncHashes(base);

    await db.notes.put(baseNote);
    await db.notes.put({ ...baseOther, content: "<p>local edit</p>", updatedAt: T0 + 2_000 });

    const remote = makePayload({
      notes: [{ ...baseNote, content: "<p>remote edit</p>", updatedAt: T0 + 2_000 }, baseOther],
    });
    const plan = planMerge(
      snapshot({
        notes: [baseNote, { ...baseOther, content: "<p>local edit</p>", updatedAt: T0 + 2_000 }],
      }),
      remote,
      baseHashes,
    );
    expect(plan.conflicts).toBe(0);
    await applyBackup(asDb(db), plan.payload, "merge");

    expect((await db.notes.get("n1"))?.content).toBe("<p>remote edit</p>");
    expect((await db.notes.get("n2"))?.content).toBe("<p>local edit</p>");
  });

  it("keeps the newer edit and preserves the loser as a conflict copy", async () => {
    const baseNote = makeNote("n1");
    const baseHashes = computeSyncHashes(snapshot({ notes: [baseNote] }));
    const localVersion = { ...baseNote, content: "<p>from this device</p>", updatedAt: T0 + 2_000 };
    const remoteVersion = {
      ...baseNote,
      content: "<p>from other device</p>",
      updatedAt: T0 + 3_000,
    };
    await db.notes.put(localVersion);

    const plan = planMerge(
      snapshot({ notes: [localVersion] }),
      makePayload({ notes: [remoteVersion] }),
      baseHashes,
    );
    expect(plan.conflicts).toBe(1);
    await applyBackup(asDb(db), plan.payload, "merge");

    expect((await db.notes.get("n1"))?.content).toBe("<p>from other device</p>");
    const copies = (await db.notes.toArray()).filter((n) => n.id !== "n1");
    expect(copies).toHaveLength(1);
    expect(copies[0]?.title).toBe("Note n1 (conflict copy)");
    expect(copies[0]?.content).toBe("<p>from this device</p>");
    // Deterministic id: re-planning the same conflict yields the same copy.
    const again = planMerge(
      snapshot({ notes: [localVersion] }),
      makePayload({ notes: [remoteVersion] }),
      baseHashes,
    );
    expect(again.payload.notes.find((n) => n.id !== "n1")?.id).toBe(copies[0]?.id);
  });

  it("preserves the remote loser as a conflict copy when the local edit is newer", async () => {
    const baseNote = makeNote("n1");
    const baseHashes = computeSyncHashes(snapshot({ notes: [baseNote] }));
    const localVersion = { ...baseNote, content: "<p>local newer</p>", updatedAt: T0 + 5_000 };
    const remoteVersion = { ...baseNote, content: "<p>remote older</p>", updatedAt: T0 + 3_000 };
    await db.notes.put(localVersion);

    const plan = planMerge(
      snapshot({ notes: [localVersion] }),
      makePayload({ notes: [remoteVersion] }),
      baseHashes,
    );
    expect(plan.conflicts).toBe(1);
    // The losing remote version must not be applied under the original id.
    expect(plan.payload.notes.some((n) => n.id === "n1")).toBe(false);
    await applyBackup(asDb(db), plan.payload, "merge");

    expect((await db.notes.get("n1"))?.content).toBe("<p>local newer</p>");
    const copies = (await db.notes.toArray()).filter((n) => n.id !== "n1");
    expect(copies).toHaveLength(1);
    expect(copies[0]?.content).toBe("<p>remote older</p>");
  });

  it("keeps a locked note's lock record and sealed attachments on the conflict copy", async () => {
    const lock: NoteLock = {
      v: 1,
      slots: { password: { salt: "s", iterations: 1, wrappedKey: "w" } },
      biometric: false,
      failedAttempts: 0,
      lockoutUntil: null,
      lockedAt: T0,
    };
    const baseNote = makeNote("n1", { lock, content: "envelope-v1" });
    const baseAttachment = makeAttachment("a1", "n1", { data: "sealed-v1", encrypted: true });
    const baseHashes = computeSyncHashes(
      snapshot({ notes: [baseNote], attachments: [baseAttachment] }),
    );
    const localVersion = { ...baseNote, content: "envelope-local", updatedAt: T0 + 2_000 };
    const localAttachment = { ...baseAttachment, data: "sealed-local", updatedAt: T0 + 2_000 };
    const remoteVersion = { ...baseNote, content: "envelope-remote", updatedAt: T0 + 3_000 };
    const remoteAttachment = { ...baseAttachment, data: "sealed-remote", updatedAt: T0 + 3_000 };
    await db.notes.put(localVersion);
    await db.attachments.put(localAttachment);

    const plan = planMerge(
      snapshot({ notes: [localVersion], attachments: [localAttachment] }),
      makePayload({ notes: [remoteVersion], attachments: [remoteAttachment] }),
      baseHashes,
    );
    await applyBackup(asDb(db), plan.payload, "merge");

    expect((await db.notes.get("n1"))?.content).toBe("envelope-remote");
    expect((await db.attachments.get("a1"))?.data).toBe("sealed-remote");
    const copies = (await db.notes.toArray()).filter((n) => n.id !== "n1");
    expect(copies).toHaveLength(1);
    expect(copies[0]?.lock).toEqual(lock);
    expect(copies[0]?.content).toBe("envelope-local");
    const copyAttachments = (await db.attachments.toArray()).filter(
      (a) => a.noteId === copies[0]?.id,
    );
    expect(copyAttachments).toHaveLength(1);
    expect(copyAttachments[0]?.data).toBe("sealed-local");
    expect(copyAttachments[0]?.encrypted).toBe(true);
  });

  it("propagates folder and tag renames (merge is no longer insert-only)", async () => {
    const folder = makeFolder("f1");
    const tag = makeTag("t1");
    await db.folders.put(folder);
    await db.tags.put(tag);
    const baseHashes = computeSyncHashes(snapshot({ folders: [folder], tags: [tag] }));

    const remote = makePayload({
      folders: [{ ...folder, name: "Renamed folder", updatedAt: T0 + 2_000 }],
      tags: [{ ...tag, name: "renamed-tag", updatedAt: T0 + 2_000 }],
    });
    const plan = planMerge(snapshot({ folders: [folder], tags: [tag] }), remote, baseHashes);
    const counts = await applyBackup(asDb(db), plan.payload, "merge");

    expect((await db.folders.get("f1"))?.name).toBe("Renamed folder");
    expect((await db.tags.get("t1"))?.name).toBe("renamed-tag");
    expect(counts.updated).toBe(2);
  });

  it("propagates attachment re-encryption by updatedAt", async () => {
    const attachment = makeAttachment("a1", "n1");
    const note = makeNote("n1", { content: '<p>x</p><img src="noma-attachment://a1" />' });
    await db.notes.put(note);
    await db.attachments.put(attachment);
    const baseHashes = computeSyncHashes(snapshot({ attachments: [attachment] }));

    const remote = makePayload({
      notes: [note],
      attachments: [
        { ...attachment, data: "sealed-envelope", encrypted: true, updatedAt: T0 + 2_000 },
      ],
    });
    const plan = planMerge(snapshot({ attachments: [attachment] }), remote, baseHashes);
    await applyBackup(asDb(db), plan.payload, "merge");

    const applied = await db.attachments.get("a1");
    expect(applied?.data).toBe("sealed-envelope");
    expect(applied?.encrypted).toBe(true);
  });

  it("converts phone-alarm reminders arriving from another device to notifications", async () => {
    const remote = makePayload({
      notes: [makeNote("n1")],
      reminders: [
        makeReminder("r1", "n1", {
          alertType: "phone-alarm",
          alarmToneMode: "system",
          scheduledAt: Date.now() + 3_600_000,
        }),
      ],
    });
    const plan = planMerge(snapshot(), remote, {});
    const planned = plan.payload.reminders.find((r) => r.id === "r1");
    expect(planned?.alertType).toBe("notification");
    expect(planned?.alarmToneMode).toBeUndefined();
  });
});

/* ---------------- applyBackup — semantic vector invalidation (#8.5) ----------------
 * Backup restores and sync merges write notes in bulk, bypassing
 * updateNote's save hook: any stored vector that stops telling the
 * truth (content replaced, note locked or gone) is dropped locally —
 * nothing is re-embedded during a restore/merge. */

describe("applyBackup — semantic vectors", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  function vectorRowFor(note: Note): NoteEmbedding {
    return {
      noteId: note.id,
      providerKey: "gemini|native|gemini-embedding-001|2",
      dims: 2,
      vector: new Float32Array([1, 0]),
      contentHash: fnv1a(embeddedTextForNote(note)),
      updatedAt: T0,
    };
  }

  function chunkRowFor(note: Note): NoteChunk {
    return {
      id: `${note.id}#0`,
      noteId: note.id,
      chunkIndex: 0,
      providerKey: "gemini|native|gemini-embedding-001|2",
      dims: 2,
      vector: new Float32Array([1, 0]),
      contentHash: fnv1a(embeddedTextForNote(note)),
      text: embeddedTextForNote(note),
      updatedAt: T0,
    };
  }

  async function chunksOf(noteId: string): Promise<NoteChunk[]> {
    return db.noteChunks.where("noteId").equals(noteId).toArray();
  }

  it("merge keeps a vector whose note is unchanged and drops one whose content was replaced", async () => {
    const keep = makeNote("keep");
    const changedLocal = makeNote("changed");
    await db.notes.put(keep);
    await db.notes.put(changedLocal);
    await db.noteEmbeddings.put(vectorRowFor(keep));
    await db.noteEmbeddings.put(vectorRowFor(changedLocal));
    await db.noteChunks.put(chunkRowFor(keep));
    await db.noteChunks.put(chunkRowFor(changedLocal));

    const payload = makePayload({
      notes: [
        { ...keep, updatedAt: T0 + 2_000 },
        { ...changedLocal, content: "<p>remote rewrite</p>", updatedAt: T0 + 2_000 },
      ],
    });
    await applyBackup(asDb(db), payload, "merge");

    expect((await db.notes.get("changed"))?.content).toBe("<p>remote rewrite</p>");
    expect(await db.noteEmbeddings.get("keep")).toBeDefined();
    expect(await db.noteEmbeddings.get("changed")).toBeUndefined();
    // Chunks follow their note's vector: kept when truthful, dropped when stale.
    expect(await chunksOf("keep")).toHaveLength(1);
    expect(await chunksOf("changed")).toHaveLength(0);
  });

  it("a note tombstone (permanent delete via merge) removes the vector row too", async () => {
    const note = makeNote("n1");
    await db.notes.put(note);
    await db.noteEmbeddings.put(vectorRowFor(note));
    await db.noteChunks.put(chunkRowFor(note));

    const payload = makePayload({
      tombstones: [{ entity: "note", id: "n1", deletedAt: T0 + 2_000, deviceId: "device-b" }],
    });
    const counts = await applyBackup(asDb(db), payload, "merge");

    expect(counts.deleted).toBeGreaterThan(0);
    expect(await db.notes.get("n1")).toBeUndefined();
    expect(await db.noteEmbeddings.get("n1")).toBeUndefined();
    // The chunk rows hold the note's plain text — none may outlive it.
    expect(await chunksOf("n1")).toHaveLength(0);
  });

  it("replace restore drops vectors for vanished notes and for notes that arrive locked", async () => {
    const staying = makeNote("staying");
    const vanishing = makeNote("vanishing");
    const locking = makeNote("locking");
    await db.notes.put(staying);
    await db.notes.put(vanishing);
    await db.notes.put(locking);
    await db.noteEmbeddings.put(vectorRowFor(staying));
    await db.noteEmbeddings.put(vectorRowFor(vanishing));
    await db.noteEmbeddings.put(vectorRowFor(locking));
    await db.noteChunks.put(chunkRowFor(staying));
    await db.noteChunks.put(chunkRowFor(vanishing));
    await db.noteChunks.put(chunkRowFor(locking));

    const lockedCopy: Note = {
      ...locking,
      lock: {
        v: 1,
        slots: {},
        biometric: false,
        failedAttempts: 0,
        lockoutUntil: null,
        lockedAt: T0,
      },
      updatedAt: T0 + 2_000,
    };
    await applyBackup(asDb(db), makePayload({ notes: [staying, lockedCopy] }), "replace");

    expect(await db.noteEmbeddings.get("staying")).toBeDefined();
    expect(await db.noteEmbeddings.get("vanishing")).toBeUndefined();
    expect(await db.noteEmbeddings.get("locking")).toBeUndefined();
    expect(await chunksOf("staying")).toHaveLength(1);
    expect(await chunksOf("vanishing")).toHaveLength(0);
    expect(await chunksOf("locking")).toHaveLength(0);
  });

  it("the sync snapshot never carries chunk rows (local-only index data)", async () => {
    const note = makeNote("n1");
    await db.notes.put(note);
    await db.noteChunks.put({
      ...chunkRowFor(note),
      text: "CHUNK-SENTINEL-TEXT",
      contentHash: "cafebabe",
    });
    const snapshot = await collectLibrarySnapshot(asDb(db));
    expect(JSON.stringify(snapshot)).not.toContain("CHUNK-SENTINEL-TEXT");
    expect(JSON.stringify(snapshot)).not.toContain("noteChunks");
    expect(JSON.stringify(snapshot)).not.toContain("cafebabe");
  });
});

describe("tombstones", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  it("propagates a delete-forever, cascading to attachments and reminders", async () => {
    await db.notes.put(makeNote("n1"));
    await db.attachments.put(makeAttachment("a1", "n1"));
    await db.reminders.put(makeReminder("r1", "n1"));

    const remote = makePayload({
      tombstones: [{ entity: "note", id: "n1", deletedAt: T0 + 2_000, deviceId: "device-b" }],
    });
    const plan = planMerge(snapshot({ notes: [makeNote("n1")] }), remote, {});
    const counts = await applyBackup(asDb(db), plan.payload, "merge");

    expect(await db.notes.get("n1")).toBeUndefined();
    expect(await db.attachments.get("a1")).toBeUndefined();
    expect(await db.reminders.get("r1")).toBeUndefined();
    expect(counts.deleted).toBe(3);
    // The tombstone is kept locally so it propagates onward.
    expect(await db.tombstones.get("n1")).toMatchObject({ entity: "note", deletedAt: T0 + 2_000 });
  });

  it("revives an entity edited locally after the tombstone", async () => {
    const edited = makeNote("n1", { content: "<p>edited after delete</p>", updatedAt: T0 + 5_000 });
    await db.notes.put(edited);
    const remote = makePayload({
      tombstones: [{ entity: "note", id: "n1", deletedAt: T0 + 2_000, deviceId: "device-b" }],
    });
    const plan = planMerge(snapshot({ notes: [edited] }), remote, {});
    expect(plan.tombstones).toHaveLength(0);
    await applyBackup(asDb(db), plan.payload, "merge");
    expect((await db.notes.get("n1"))?.content).toBe("<p>edited after delete</p>");
  });

  it("propagates folder, tag and reminder tombstones", async () => {
    await db.folders.put(makeFolder("f1"));
    await db.tags.put(makeTag("t1"));
    await db.notes.put(makeNote("n1", { folderId: "f1", tagIds: ["t1"] }));
    await db.reminders.put(makeReminder("r1", "n1"));

    const remote = makePayload({
      tombstones: [
        { entity: "folder", id: "f1", deletedAt: T0 + 2_000, deviceId: "device-b" },
        { entity: "tag", id: "t1", deletedAt: T0 + 2_000, deviceId: "device-b" },
        { entity: "reminder", id: "r1", deletedAt: T0 + 2_000, deviceId: "device-b" },
      ],
    });
    const plan = planMerge(
      snapshot({
        notes: [makeNote("n1", { folderId: "f1", tagIds: ["t1"] })],
        folders: [makeFolder("f1")],
        tags: [makeTag("t1")],
        reminders: [makeReminder("r1", "n1")],
      }),
      remote,
      {},
    );
    await applyBackup(asDb(db), plan.payload, "merge");

    expect(await db.folders.get("f1")).toBeUndefined();
    expect(await db.tags.get("t1")).toBeUndefined();
    expect(await db.reminders.get("r1")).toBeUndefined();
    const note = await db.notes.get("n1");
    expect(note?.folderId).toBeNull();
    expect(note?.tagIds).toEqual([]);
  });

  it("records tombstones via recordTombstone", async () => {
    await recordTombstone(asDb(db), "note", "n9");
    const stored = await db.tombstones.get("n9");
    expect(stored?.entity).toBe("note");
    expect(stored?.deletedAt).toBeGreaterThan(0);
  });
});

/* ---------------- Backup ZIP sync metadata ---------------- */

describe("backup ZIP sync metadata", () => {
  it("round-trips tombstones and deviceId through sync.json", async () => {
    const db = new FakeDb();
    await db.notes.put(makeNote("n1"));
    await db.tombstones.put({ entity: "note", id: "gone", deletedAt: T0, deviceId: "device-a" });

    const { blob, payload } = await buildBackupZip(asDb(db), null);
    expect(payload.tombstones).toHaveLength(1);
    expect(payload.deviceId).toBeTruthy();

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const syncJson = JSON.parse(await zip.file("sync.json")!.async("string")) as {
      tombstones: SyncTombstone[];
    };
    expect(syncJson.tombstones).toHaveLength(1);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as {
      backupFormatVersion: number;
      deviceId?: string;
    };
    expect(manifest.backupFormatVersion).toBe(2);
    expect(manifest.deviceId).toBe(payload.deviceId);

    // Node has no FileReader for JSZip's Blob input, so the tests hand it
    // the equivalent ArrayBuffer (browsers pass real Blobs, which work).
    const parsed = await readBackupZip((await blob.arrayBuffer()) as unknown as Blob, null);
    expect(parsed.tombstones).toHaveLength(1);
    expect(parsed.deviceId).toBe(payload.deviceId);
  });

  it("reads a pre-sync (v2, no sync.json) backup with empty tombstones", async () => {
    const zip = new JSZip();
    zip.file(
      "manifest.json",
      JSON.stringify({
        backupFormatVersion: 2,
        nomaVersion: "1.2.0",
        createdAt: new Date(T0).toISOString(),
        noteCount: 1,
        folderCount: 0,
        tagCount: 0,
        attachmentCount: 0,
      }),
    );
    zip.folder("notes")!.file("n1.json", JSON.stringify(makeNote("n1")));
    const buffer = await zip.generateAsync({ type: "uint8array" });

    const parsed = await readBackupZip(buffer as unknown as Blob, null);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.tombstones).toEqual([]);
    expect(parsed.deviceId).toBeNull();

    // …and it merges cleanly.
    const db = new FakeDb();
    const counts = await applyBackup(asDb(db), parsed, "merge");
    expect(counts.added).toBe(1);
    expect((await db.notes.get("n1"))?.title).toBe("Note n1");
  });
});

/* ---------------- syncNow cycle (fake Drive) ---------------- */

interface FakeRemote {
  payload: BackupPayload | null;
  modifiedTime: number;
  checksum: string | null;
  downloads: number;
  uploads: number;
  /** Encryption header the fake archive carries (null = plaintext). */
  encryption?: import("./backup-crypto").BackupEncryptionHeader | null;
}

function makeRemote(): FakeRemote {
  return { payload: null, modifiedTime: 0, checksum: null, downloads: 0, uploads: 0 };
}

function makeDeps(remote: FakeRemote): SyncDriveDeps {
  return {
    getConnection: () => ({
      email: "a@example.com",
      connectedAt: 1,
      lastBackupAt: null,
      folderId: "folder1",
      backupFileId: remote.payload ? "file1" : null,
      lastSignature: null,
    }),
    getCanonicalFileMeta: async () =>
      remote.payload
        ? {
            id: "file1",
            modifiedTime: remote.modifiedTime,
            md5Checksum: remote.checksum,
            size: null,
          }
        : null,
    fetchCanonicalBackup: async () => {
      remote.downloads++;
      if (!remote.payload) return null;
      return {
        payload: structuredClone(remote.payload),
        meta: {
          id: "file1",
          modifiedTime: remote.modifiedTime,
          md5Checksum: remote.checksum,
          size: null,
        },
        encryption: remote.encryption ?? null,
      };
    },
    backupNow: async (dbArg: NomaDatabase) => {
      remote.uploads++;
      const payload = await collectBackup(dbArg, null);
      remote.payload = payload;
      remote.modifiedTime += 10_000;
      remote.checksum = librarySyncSignature({
        notes: payload.notes,
        folders: payload.folders,
        tags: payload.tags,
        attachments: payload.attachments,
        reminders: payload.reminders,
        tombstones: payload.tombstones,
      });
      return {
        connection: {
          email: "a@example.com",
          connectedAt: 1,
          lastBackupAt: Date.now(),
          folderId: "folder1",
          backupFileId: "file1",
          lastSignature: null,
        },
        manifest: payload.manifest,
      };
    },
  };
}

/** Simulates another device replacing the remote snapshot. */
async function remoteWriteFrom(db: FakeDb, remote: FakeRemote): Promise<void> {
  remote.payload = await collectBackup(asDb(db), null);
  remote.modifiedTime += 10_000;
  remote.checksum = librarySyncSignature({
    notes: remote.payload.notes,
    folders: remote.payload.folders,
    tags: remote.payload.tags,
    attachments: remote.payload.attachments,
    reminders: remote.payload.reminders,
    tombstones: remote.payload.tombstones,
  });
}

describe("syncNow", () => {
  let remote: FakeRemote;
  let deviceA: FakeDb;
  let deviceB: FakeDb;

  beforeEach(async () => {
    remote = makeRemote();
    deviceA = new FakeDb();
    deviceB = new FakeDb();
    await seedSettings(deviceA);
    await seedSettings(deviceB);
  });

  it("pushes local changes, pulls them on a second device, and converges both ways", async () => {
    await deviceA.notes.put(makeNote("n1"));
    const first = await syncNow(asDb(deviceA), null, "manual", { deps: makeDeps(remote) });
    expect(first.status).toBe("synced");
    expect(first.pushed).toBe(true);
    expect(remote.uploads).toBe(1);

    const pulled = await syncNow(asDb(deviceB), null, "manual", { deps: makeDeps(remote) });
    expect(pulled.pulled).toBe(true);
    expect((await deviceB.notes.get("n1"))?.title).toBe("Note n1");

    // Device B edits; device A adds. After both sync, both have everything.
    await deviceB.notes.put(
      makeNote("n1", { content: "<p>edited on B</p>", updatedAt: T0 + 60_000 }),
    );
    await syncNow(asDb(deviceB), null, "manual", { deps: makeDeps(remote) });
    await deviceA.notes.put(makeNote("n2", { createdAt: T0 + 60_000, updatedAt: T0 + 60_000 }));
    await syncNow(asDb(deviceA), null, "manual", { deps: makeDeps(remote) });

    expect((await deviceA.notes.get("n1"))?.content).toBe("<p>edited on B</p>");
    expect((await deviceA.notes.get("n2"))?.title).toBe("Note n2");
    await syncNow(asDb(deviceB), null, "manual", { deps: makeDeps(remote) });
    expect((await deviceB.notes.get("n2"))?.title).toBe("Note n2");
  });

  it("adopts its own echo: a second cycle downloads and uploads nothing", async () => {
    await deviceA.notes.put(makeNote("n1"));
    const deps = makeDeps(remote);
    await syncNow(asDb(deviceA), null, "manual", { deps });
    expect(remote.uploads).toBe(1);

    const again = await syncNow(asDb(deviceA), null, "manual", { deps });
    expect(again.status).toBe("synced");
    expect(again.pushed).toBe(false);
    expect(remote.downloads).toBe(0);
    expect(remote.uploads).toBe(1);
  });

  it("never modifies settings during a sync merge", async () => {
    await seedSettings(deviceA, { theme: "dark", displayName: "Device A" });
    await seedSettings(deviceB, { theme: "light", displayName: "Device B" });
    await deviceB.notes.put(makeNote("n1"));
    await remoteWriteFrom(deviceB, remote);

    const result = await syncNow(asDb(deviceA), null, "manual", { deps: makeDeps(remote) });
    expect(result.status).toBe("synced");
    const settings = await deviceA.settings.get("app");
    expect(settings?.theme).toBe("dark");
    expect(settings?.displayName).toBe("Device A");
  });

  it("skips when backup mode is off", async () => {
    await seedSettings(deviceA, { backupMode: "off" });
    await deviceA.notes.put(makeNote("n1"));
    const result = await syncNow(asDb(deviceA), null, "manual", { deps: makeDeps(remote) });
    expect(result.status).toBe("skipped");
    expect(remote.uploads).toBe(0);
  });

  it("fails cleanly and leaves the local library untouched when the download fails", async () => {
    await deviceA.notes.put(makeNote("n1"));
    await remoteWriteFrom(deviceB, remote);
    const deps = makeDeps(remote);
    deps.fetchCanonicalBackup = async () => {
      throw new Error("This backup belongs to a different account.");
    };
    const result = await syncNow(asDb(deviceA), null, "manual", { deps });
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("different account");
    expect((await deviceA.notes.get("n1"))?.title).toBe("Note n1");
    expect(await getSyncState(asDb(deviceA))).toMatchObject({ lastSyncAt: null });
  });
});

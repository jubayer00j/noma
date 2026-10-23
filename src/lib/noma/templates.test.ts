import { describe, expect, it } from "vitest";
import { type NomaDatabase } from "./db";
import { formatDailyTitle } from "./daily";
import { createNote } from "./notes";
import { searchNotes } from "./search";
import {
  BUILTIN_TEMPLATES,
  createNoteFromTemplate,
  ensureBuiltinTemplates,
  saveAsTemplate,
  setDailyDefault,
} from "./templates";
import type {
  AppSettings,
  AttachmentMeta,
  Folder,
  Note,
  NoteLock,
  Reminder,
  SyncState,
  SyncTombstone,
  Tag,
} from "./types";
import { filterNotes, type ViewKind, type ViewState } from "./view";

/* ---------------- Fake Dexie surface ----------------
 * Same in-memory stand-in the sync suite uses. */

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
  lockedAt: 1_000,
};

describe("saveAsTemplate", () => {
  it("copies the note into a template and strips note-state flags", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const source = await createNote(db, {
      title: "Weekly review",
      content: "<p>Wins</p>",
      pinned: true,
      favorite: true,
      archived: true,
      reminderAt: 999,
      dailyDate: "2026-10-23",
    });

    const template = await saveAsTemplate(db, source.id, "Weekly review template");
    expect(template).not.toBeNull();
    expect(template!.id).not.toBe(source.id);
    expect(template!.isTemplate).toBe(true);
    expect(template!.title).toBe("Weekly review template");
    expect(template!.content).toBe("<p>Wins</p>");
    expect(template!.pinned).toBe(false);
    expect(template!.favorite).toBe(false);
    expect(template!.archived).toBe(false);
    expect(template!.reminderAt).toBeNull();
    expect(template!.dailyDate).toBeNull();
    expect(template!.dailyDefault).toBe(false);

    // The source note is untouched.
    const storedSource = await fake.notes.get(source.id);
    expect(storedSource!.isTemplate).toBeFalsy();
    expect(storedSource!.pinned).toBe(true);
  });

  it("refuses a locked note", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const locked = await createNote(db, { title: "Secret", lock: FAKE_LOCK });
    expect(await saveAsTemplate(db, locked.id, "Nope")).toBeNull();
    expect(await fake.notes.count()).toBe(1);
  });

  it("clones attachments so the template owns independent copies", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    await fake.attachments.put({
      id: "att-1",
      noteId: "pending",
      name: "photo.png",
      mimeType: "image/png",
      size: 3,
      createdAt: 1,
      data: "data:image/png;base64,AAA",
    });
    const source = await createNote(db, {
      title: "With image",
      content: '<p><img src="noma-attachment://att-1"></p>',
    });
    await fake.attachments.update("att-1", { noteId: source.id });

    const template = await saveAsTemplate(db, source.id, "Image template");
    expect(template).not.toBeNull();
    expect(template!.content).not.toContain("noma-attachment://att-1");
    const cloneId = /noma-attachment:\/\/([a-zA-Z0-9_-]+)/.exec(template!.content)?.[1];
    expect(cloneId).toBeTruthy();
    const clone = await fake.attachments.get(cloneId!);
    expect(clone?.noteId).toBe(template!.id);
    expect(clone?.data).toBe("data:image/png;base64,AAA");
  });
});

describe("createNoteFromTemplate", () => {
  it("mints a regular note with {{date}} expanded in title and content", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const template = await createNote(db, {
      title: "Standup — {{date}}",
      content: "<p>Notes for {{date}}</p>",
      isTemplate: true,
      dailyDefault: true,
    });

    const now = new Date(2026, 9, 23, 9, 0);
    const note = await createNoteFromTemplate(db, template.id, now);
    expect(note).not.toBeNull();
    expect(note!.title).toBe(`Standup — ${formatDailyTitle(now)}`);
    expect(note!.content).toContain(formatDailyTitle(now));
    expect(note!.content).not.toContain("{{date}}");
    expect(note!.isTemplate).toBeFalsy();
    expect(note!.dailyDate).toBeNull();
    expect(note!.dailyDefault).toBeFalsy();
    expect(note!.reminderAt).toBeNull();
  });

  it("returns null for a note that is not a template", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const plain = await createNote(db, { title: "Plain" });
    expect(await createNoteFromTemplate(db, plain.id)).toBeNull();
    expect(await fake.notes.count()).toBe(1);
  });

  it("clones the template's attachments into the new note", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const template = await createNote(db, {
      title: "Brief",
      content: '<p><img src="noma-attachment://att-t"></p>',
      isTemplate: true,
    });
    await fake.attachments.put({
      id: "att-t",
      noteId: template.id,
      name: "logo.png",
      mimeType: "image/png",
      size: 3,
      createdAt: 1,
      data: "data:image/png;base64,BBB",
    });

    const note = await createNoteFromTemplate(db, template.id);
    expect(note).not.toBeNull();
    // A fresh attachment row was cloned for the new note. (The content-ref
    // remap itself is asserted in the saveAsTemplate test: here the minted
    // content also passes through updateNote, whose DOM-less test fallback
    // strips markup, so the row-level clone is the durable evidence.)
    const clones = (await fake.attachments.toArray()).filter(
      (row) => row.noteId === note!.id && row.id !== "att-t",
    );
    expect(clones).toHaveLength(1);
    expect(clones[0]!.data).toBe("data:image/png;base64,BBB");
    // The template keeps its own attachment untouched.
    expect((await fake.attachments.get("att-t"))?.noteId).toBe(template.id);
  });
});

describe("setDailyDefault", () => {
  it("keeps exactly one daily default and can clear it", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const a = await createNote(db, { title: "A", isTemplate: true });
    const b = await createNote(db, { title: "B", isTemplate: true });

    await setDailyDefault(db, a.id);
    expect((await fake.notes.get(a.id))!.dailyDefault).toBe(true);
    expect((await fake.notes.get(b.id))!.dailyDefault).toBeFalsy();

    await setDailyDefault(db, b.id);
    expect((await fake.notes.get(a.id))!.dailyDefault).toBe(false);
    expect((await fake.notes.get(b.id))!.dailyDefault).toBe(true);

    await setDailyDefault(db, null);
    expect((await fake.notes.get(a.id))!.dailyDefault).toBe(false);
    expect((await fake.notes.get(b.id))!.dailyDefault).toBe(false);
  });
});

describe("ensureBuiltinTemplates", () => {
  it("seeds the three built-ins with their deterministic ids", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    await ensureBuiltinTemplates(db);
    expect(await fake.notes.count()).toBe(3);
    // Content needle per built-in: in the DOM-less test environment the
    // updateNote pass reduces content to its text, so assert on the
    // section wording rather than the HTML scaffolding.
    const needles: Record<string, string> = {
      "Meeting notes": "Attendees",
      "Morning pages": "Mind dump",
      Checklist: "First task",
    };
    for (const builtin of BUILTIN_TEMPLATES) {
      const seeded = await fake.notes.get(builtin.id);
      expect(seeded).toBeTruthy();
      expect(seeded!.isTemplate).toBe(true);
      expect(seeded!.title).toBe(builtin.title);
      expect(seeded!.content).toContain(needles[builtin.title]);
    }
  });

  it("is idempotent and never overwrites an edited built-in", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    await ensureBuiltinTemplates(db);
    const meeting = BUILTIN_TEMPLATES[0]!;
    await fake.notes.update(meeting.id, { title: "My meetings" });
    await ensureBuiltinTemplates(db);
    expect(await fake.notes.count()).toBe(3);
    expect((await fake.notes.get(meeting.id))!.title).toBe("My meetings");
  });

  it("skips a built-in the user deleted forever (tombstone present)", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const morning = BUILTIN_TEMPLATES[1]!;
    await fake.tombstones.put({
      entity: "note",
      id: morning.id,
      deletedAt: 42,
      deviceId: "device-1",
    });
    await ensureBuiltinTemplates(db);
    expect(await fake.notes.get(morning.id)).toBeUndefined();
    expect(await fake.notes.count()).toBe(2);
  });
});

/* -------- View + search partitioning (plain factories) -------- */

function makeNote(id: string, extra: Partial<Note> = {}): Note {
  return {
    id,
    title: `Title ${id}`,
    content: `<p>Body ${id}</p>`,
    contentFormat: "tiptap-html",
    createdAt: 1000,
    updatedAt: 1000,
    folderId: null,
    tagIds: [],
    pinned: false,
    favorite: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    reminderAt: null,
    wordCount: 5,
    ...extra,
  };
}

const view = (kind: ViewKind, id?: string | null): ViewState =>
  id === undefined ? { kind } : { kind, id };

describe("template partitioning in views and search", () => {
  const template = makeNote("tpl", {
    isTemplate: true,
    pinned: true,
    favorite: true,
    folderId: "f1",
    tagIds: ["t1"],
    reminderAt: 123,
    updatedAt: 9000,
  });
  const archivedTemplate = makeNote("tpl-arch", { isTemplate: true, archived: true });
  const trashedTemplate = makeNote("tpl-trash", {
    isTemplate: true,
    deleted: true,
    deletedAt: 9000,
  });
  const plain = makeNote("plain", { updatedAt: 2000 });
  const notes = [template, archivedTemplate, trashedTemplate, plain];

  it("excludes templates from every ordinary view", () => {
    const kinds: ViewKind[] = [
      "all",
      "recent",
      "pinned",
      "favorites",
      "archive",
      "trash",
      "reminders",
    ];
    for (const kind of kinds) {
      const ids = filterNotes(notes, view(kind)).map((n) => n.id);
      expect(ids, kind).not.toContain("tpl");
      expect(ids, kind).not.toContain("tpl-arch");
      expect(ids, kind).not.toContain("tpl-trash");
    }
    expect(filterNotes(notes, view("folder", "f1")).map((n) => n.id)).toEqual([]);
    expect(filterNotes(notes, view("tag", "t1")).map((n) => n.id)).toEqual([]);
  });

  it("lists live templates in the templates view, title-sorted", () => {
    const beta = makeNote("tpl-b", { isTemplate: true, title: "Beta" });
    const alpha = makeNote("tpl-a", { isTemplate: true, title: "Alpha" });
    const ids = filterNotes([beta, alpha, trashedTemplate, plain], view("templates")).map(
      (n) => n.id,
    );
    expect(ids).toEqual(["tpl-a", "tpl-b"]);
  });

  it("excludes templates from search results", () => {
    const results = searchNotes("Title", notes, [], []);
    expect(results.map((r) => r.note.id)).toEqual(["plain"]);
  });

  it("sorts the daily view by dailyDate descending and skips templates", () => {
    const d1 = makeNote("d1", { dailyDate: "2026-10-21", updatedAt: 5000 });
    const d2 = makeNote("d2", { dailyDate: "2026-10-23", updatedAt: 1000 });
    const d3 = makeNote("d3", { dailyDate: "2026-10-22", updatedAt: 4000 });
    const tplDaily = makeNote("tpl-d", {
      isTemplate: true,
      dailyDate: "2026-10-24",
      updatedAt: 9999,
    });
    const trashedDaily = makeNote("d-trash", {
      dailyDate: "2026-10-25",
      deleted: true,
      deletedAt: 1,
    });
    const ids = filterNotes(
      [d1, d2, d3, tplDaily, trashedDaily, plain],
      view("daily"),
    ).map((n) => n.id);
    expect(ids).toEqual(["d2", "d3", "d1"]);
  });
});

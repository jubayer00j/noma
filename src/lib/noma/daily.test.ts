import { describe, expect, it } from "vitest";
import { type NomaDatabase } from "./db";
import { formatDailyTitle, getOrCreateDailyNote, localDateKey } from "./daily";
import { createNote } from "./notes";
import type {
  AppSettings,
  AttachmentMeta,
  Folder,
  Note,
  Reminder,
  SyncState,
  SyncTombstone,
  Tag,
} from "./types";

/* ---------------- Fake Dexie surface ----------------
 * Same in-memory stand-in the sync suite uses: the daily code only
 * touches the notes table, but the full shape keeps the cast honest. */

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

/** 23 October 2026, 09:15 local. */
const TODAY = new Date(2026, 9, 23, 9, 15);
const TODAY_KEY = "2026-10-23";

describe("localDateKey", () => {
  it("builds the key from local components with zero padding", () => {
    expect(localDateKey(new Date(2026, 0, 5, 12, 0))).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 9, 23, 9, 15))).toBe("2026-10-23");
    expect(localDateKey(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31");
  });

  it("keeps just-after-midnight on the new local day (never the UTC day)", () => {
    // 00:30 local is still the previous day in UTC for positive offsets;
    // the key must follow the wall clock the user sees.
    expect(localDateKey(new Date(2026, 9, 23, 0, 30))).toBe("2026-10-23");
    expect(localDateKey(new Date(2026, 9, 22, 23, 59))).toBe("2026-10-22");
  });
});

describe("formatDailyTitle", () => {
  it("renders the long-form local date", () => {
    const title = formatDailyTitle(new Date(2026, 9, 23));
    expect(title).toContain("Friday");
    expect(title).toContain("23");
    expect(title).toContain("October");
    expect(title).toContain("2026");
  });
});

describe("getOrCreateDailyNote", () => {
  it("creates today's note with the date key and long-form title", async () => {
    const fake = new FakeDb();
    const note = await getOrCreateDailyNote(asDb(fake), TODAY);
    expect(note.dailyDate).toBe(TODAY_KEY);
    expect(note.title).toBe(formatDailyTitle(TODAY));
    expect(note.deleted).toBe(false);
    expect(note.isTemplate).toBeFalsy();
    expect(await fake.notes.count()).toBe(1);
  });

  it("is idempotent: a second call the same day returns the same note", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const first = await getOrCreateDailyNote(db, TODAY);
    const second = await getOrCreateDailyNote(db, new Date(2026, 9, 23, 21, 40));
    expect(second.id).toBe(first.id);
    expect(await fake.notes.count()).toBe(1);
  });

  it("creates a separate note for a different day", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const today = await getOrCreateDailyNote(db, TODAY);
    const tomorrow = await getOrCreateDailyNote(db, new Date(2026, 9, 24, 8, 0));
    expect(tomorrow.id).not.toBe(today.id);
    expect(tomorrow.dailyDate).toBe("2026-10-24");
    expect(await fake.notes.count()).toBe(2);
  });

  it("restores a trashed daily note instead of duplicating the day", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const original = await createNote(db, {
      title: "Earlier page",
      dailyDate: TODAY_KEY,
      deleted: true,
      deletedAt: 123,
    });
    const note = await getOrCreateDailyNote(db, TODAY);
    expect(note.id).toBe(original.id);
    expect(note.deleted).toBe(false);
    expect(note.deletedAt).toBeNull();
    expect(await fake.notes.count()).toBe(1);
  });

  it("seeds content from the daily-default template with {{date}} expanded", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    await createNote(db, {
      title: "My morning template",
      content: "<p>Pages for {{date}}</p>",
      isTemplate: true,
      dailyDefault: true,
    });
    const note = await getOrCreateDailyNote(db, TODAY);
    expect(note.content).not.toContain("{{date}}");
    expect(note.content).toContain(formatDailyTitle(TODAY));
    // updateNote pass: content was word-counted like any other note.
    expect(note.wordCount).toBeGreaterThan(0);
    // The title is the day's title, not the template's.
    expect(note.title).toBe(formatDailyTitle(TODAY));
  });

  it("ignores a non-default template when seeding", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    await createNote(db, {
      title: "Plain template",
      content: "<p>Should not seed</p>",
      isTemplate: true,
    });
    const note = await getOrCreateDailyNote(db, TODAY);
    expect(note.content).toBe("");
  });

  it("single-flight: two concurrent calls create exactly one note", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const [a, b] = await Promise.all([
      getOrCreateDailyNote(db, TODAY),
      getOrCreateDailyNote(db, TODAY),
    ]);
    expect(a.id).toBe(b.id);
    expect(await fake.notes.count()).toBe(1);
  });
});

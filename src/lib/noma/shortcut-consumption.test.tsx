// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NomaDatabase } from "./db";
import { getOrCreateDailyNote } from "./daily";
import { processShortcutUrl, resetShortcutStateForTests, useShortcutConsumption } from "./shortcut";
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

/* Native-feel #9: the workspace's shortcut-consumption gate, tested at
 * the seam the workspace uses — the real useShortcutConsumption hook with
 * the real daily engine against an in-memory db. The native plugin is
 * inert here: triggers are fed straight into the pending slot. */

/* No Capacitor mocks here on purpose: the daily engine's import graph
 * registers native plugins at module load, so @capacitor/core must stay
 * real. In a web test environment the real Capacitor reports a
 * non-native platform, which keeps the shortcut listener inert — triggers
 * are fed straight into the pending slot via processShortcutUrl. */

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

/* ---------------- Fake Dexie surface (same stand-in as daily.test.ts) ------- */

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

/* ---------------- Probe: the workspace gate, nothing else ------------------ */

interface ProbeProps {
  db: NomaDatabase | null;
  isLocked: boolean;
  isLockStateResolving: boolean;
  onNewNote: () => void;
  onToday: () => void | Promise<void>;
  onVoiceNote?: () => void | Promise<void>;
}

function Probe(props: ProbeProps) {
  useShortcutConsumption({
    db: props.db,
    isLockStateResolving: props.isLockStateResolving,
    isLocked: props.isLocked,
    onNewNote: props.onNewNote,
    onToday: props.onToday,
    onVoiceNote: props.onVoiceNote,
  });
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(ui: ReactElement): Promise<void> {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
  }
  if (!root) root = createRoot(container);
  const current = root;
  await act(async () => {
    current.render(ui);
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function trigger(url: string): Promise<void> {
  await act(async () => {
    processShortcutUrl(url);
  });
}

/* The slot dedupes on Date.now(); give every trigger a distinct id. */
let nowValue = 1_000_000;

beforeEach(() => {
  resetShortcutStateForTests();
  nowValue = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => (nowValue += 1000));
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => {
      current.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe("useShortcutConsumption — the gate", () => {
  it("holds a Today trigger behind App Lock, then fires it once on unlock", async () => {
    const fake = new FakeDb();
    const onNewNote = vi.fn();
    const onToday = vi.fn();
    const gate = { db: asDb(fake), onNewNote, onToday };

    await trigger("app.noma.notes://today");
    await render(<Probe {...gate} isLocked isLockStateResolving={false} />);
    await flush();
    expect(onToday).not.toHaveBeenCalled();

    await render(<Probe {...gate} isLocked={false} isLockStateResolving={false} />);
    await flush();
    expect(onToday).toHaveBeenCalledTimes(1);

    // Consume-once: further renders never refire the same trigger.
    await render(<Probe {...gate} isLocked={false} isLockStateResolving={false} />);
    await flush();
    expect(onToday).toHaveBeenCalledTimes(1);
    expect(onNewNote).not.toHaveBeenCalled();
  });

  it("waits for the database and for the lock state to resolve", async () => {
    const fake = new FakeDb();
    const onToday = vi.fn();
    const onNewNote = vi.fn();

    await trigger("app.noma.notes://today");
    await render(
      <Probe
        db={null}
        isLocked={false}
        isLockStateResolving={false}
        onNewNote={onNewNote}
        onToday={onToday}
      />,
    );
    await flush();
    expect(onToday).not.toHaveBeenCalled();

    await render(
      <Probe
        db={asDb(fake)}
        isLocked={false}
        isLockStateResolving
        onNewNote={onNewNote}
        onToday={onToday}
      />,
    );
    await flush();
    expect(onToday).not.toHaveBeenCalled();

    await render(
      <Probe
        db={asDb(fake)}
        isLocked={false}
        isLockStateResolving={false}
        onNewNote={onNewNote}
        onToday={onToday}
      />,
    );
    await flush();
    expect(onToday).toHaveBeenCalledTimes(1);
  });

  it("routes new-note to its own handler, unchanged", async () => {
    const fake = new FakeDb();
    const onNewNote = vi.fn();
    const onToday = vi.fn();

    await trigger("app.noma.notes://new-note");
    await render(
      <Probe
        db={asDb(fake)}
        isLocked={false}
        isLockStateResolving={false}
        onNewNote={onNewNote}
        onToday={onToday}
      />,
    );
    await flush();
    expect(onNewNote).toHaveBeenCalledTimes(1);
    expect(onToday).not.toHaveBeenCalled();
  });

  it("holds a Voice note trigger behind App Lock, then routes it once on unlock", async () => {
    const fake = new FakeDb();
    const onNewNote = vi.fn();
    const onToday = vi.fn();
    const onVoiceNote = vi.fn();
    const gate = { db: asDb(fake), onNewNote, onToday, onVoiceNote };

    await trigger("app.noma.notes://voice-note");
    await render(<Probe {...gate} isLocked isLockStateResolving={false} />);
    await flush();
    expect(onVoiceNote).not.toHaveBeenCalled();

    await render(<Probe {...gate} isLocked={false} isLockStateResolving={false} />);
    await flush();
    expect(onVoiceNote).toHaveBeenCalledTimes(1);
    expect(onNewNote).not.toHaveBeenCalled();
    expect(onToday).not.toHaveBeenCalled();

    await render(<Probe {...gate} isLocked={false} isLockStateResolving={false} />);
    await flush();
    expect(onVoiceNote).toHaveBeenCalledTimes(1);
  });
});

describe("useShortcutConsumption — Today end to end", () => {
  it("creates today's note once and opens the same note on a repeat trigger", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const opened: string[] = [];
    // Mirrors the workspace's openTodayNote: get-or-create, then open it.
    const onToday = async () => {
      const note = await getOrCreateDailyNote(db);
      opened.push(note.id);
    };
    const onNewNote = vi.fn();
    const gate = { db, isLocked: false, isLockStateResolving: false, onNewNote, onToday };

    await render(<Probe {...gate} />);
    await trigger("app.noma.notes://today");
    await flush();
    expect(opened).toHaveLength(1);
    expect(await fake.notes.count()).toBe(1);

    await trigger("app.noma.notes://today");
    await flush();
    expect(opened).toHaveLength(2);
    expect(opened[1]).toBe(opened[0]);
    expect(await fake.notes.count()).toBe(1);
  });
});

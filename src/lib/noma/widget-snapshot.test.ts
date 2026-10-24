import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Note, NoteLock } from "./types";

/* Native-feel #10: the widget snapshot builder and staging seam. The
 * seam keeps its change-detection key in module state, so the seam
 * tests load a fresh copy per test (vi.resetModules + dynamic import),
 * the shortcut.test.ts pattern. The builder tests use the top-level
 * import — the builder is pure. */

const mocks = vi.hoisted(() => ({
  native: true,
  platform: "android" as string,
  stageSnapshot: vi.fn(async (_options: { json: string }) => {}),
  clearSnapshot: vi.fn(async () => {}),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => mocks.native,
    getPlatform: () => mocks.platform,
  },
  registerPlugin: (name: string) =>
    name === "NomaWidget"
      ? { stageSnapshot: mocks.stageSnapshot, clearSnapshot: mocks.clearSnapshot }
      : {},
}));

import { buildWidgetSnapshot, widgetSnapshotKey, WIDGET_NOTES_LIMIT } from "./widget-snapshot";
import { localDateKey } from "./daily";

const NOW = new Date(2026, 9, 24, 10, 30, 0); // local time
const TODAY_KEY = localDateKey(NOW);

function makeNote(patch: Partial<Note> = {}): Note {
  return {
    id: "3f6b8f7e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    title: "A note",
    content: "",
    contentFormat: "tiptap-html",
    createdAt: 1,
    updatedAt: 1,
    folderId: null,
    tagIds: [],
    pinned: false,
    favorite: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    reminderAt: null,
    wordCount: 0,
    ...patch,
  };
}

const LOCK = { version: 1 } as unknown as NoteLock;

async function loadSeam() {
  return import("./widget-snapshot");
}

beforeEach(() => {
  vi.resetModules();
  mocks.native = true;
  mocks.platform = "android";
  mocks.stageSnapshot.mockClear();
  mocks.clearSnapshot.mockClear();
  mocks.stageSnapshot.mockImplementation(async () => {});
  mocks.clearSnapshot.mockImplementation(async () => {});
});

describe("buildWidgetSnapshot — content mode", () => {
  it("orders pinned first, then most recently updated, capped at the limit", () => {
    const notes = [
      makeNote({ id: "n1", title: "Old unpinned", updatedAt: 10 }),
      makeNote({ id: "n2", title: "Pinned older", pinned: true, updatedAt: 20 }),
      makeNote({ id: "n3", title: "Newest unpinned", updatedAt: 99 }),
      makeNote({ id: "n4", title: "Pinned newer", pinned: true, updatedAt: 30 }),
      makeNote({ id: "n5", title: "Middle unpinned", updatedAt: 50 }),
    ];
    const snapshot = buildWidgetSnapshot(notes, false, NOW);
    expect(snapshot.mode).toBe("content");
    expect(snapshot.v).toBe(1);
    expect(snapshot.stagedAt).toBe(NOW.getTime());
    expect(snapshot.notes.map((n) => n.id)).toEqual(["n4", "n2", "n3"]);
    expect(snapshot.notes).toHaveLength(WIDGET_NOTES_LIMIT);
  });

  it("trims titles and falls back to Untitled note", () => {
    const snapshot = buildWidgetSnapshot(
      [
        makeNote({ id: "n1", title: "  Spaced  ", updatedAt: 2 }),
        makeNote({ id: "n2", title: "   ", updatedAt: 1 }),
      ],
      false,
      NOW,
    );
    expect(snapshot.notes).toEqual([
      { id: "n1", title: "Spaced" },
      { id: "n2", title: "Untitled note" },
    ]);
  });

  it("excludes locked, trashed, archived, and template notes", () => {
    const notes = [
      makeNote({ id: "locked", title: "Secret", lock: LOCK, updatedAt: 100 }),
      makeNote({ id: "trashed", title: "Gone", deleted: true, deletedAt: 5, updatedAt: 99 }),
      makeNote({ id: "archived", title: "Put away", archived: true, updatedAt: 98 }),
      makeNote({ id: "template", title: "Starter", isTemplate: true, updatedAt: 97 }),
      makeNote({ id: "plain", title: "Ordinary", updatedAt: 1 }),
    ];
    const snapshot = buildWidgetSnapshot(notes, false, NOW);
    expect(snapshot.notes).toEqual([{ id: "plain", title: "Ordinary" }]);
  });

  it("carries no content — titles and ids only", () => {
    const snapshot = buildWidgetSnapshot(
      [makeNote({ id: "n1", title: "T", content: "the body text" })],
      false,
      NOW,
    );
    expect(JSON.stringify(snapshot)).not.toContain("the body text");
  });
});

describe("buildWidgetSnapshot — Today row", () => {
  it("surfaces the daily note for the local date", () => {
    const daily = makeNote({ id: "d1", title: "Friday, 24 October 2026", dailyDate: TODAY_KEY });
    const snapshot = buildWidgetSnapshot([daily], false, NOW);
    expect(snapshot.today).toEqual({ title: "Friday, 24 October 2026" });
  });

  it("is null when no daily note exists for today", () => {
    const otherDay = makeNote({ id: "d0", dailyDate: "2020-01-01" });
    expect(buildWidgetSnapshot([otherDay], false, NOW).today).toBeNull();
    expect(buildWidgetSnapshot([], false, NOW).today).toBeNull();
  });

  it("is null for a locked daily note — its title never stages", () => {
    const daily = makeNote({
      id: "d1",
      title: "Private journal",
      dailyDate: TODAY_KEY,
      lock: LOCK,
    });
    const snapshot = buildWidgetSnapshot([daily], false, NOW);
    expect(snapshot.today).toBeNull();
    expect(JSON.stringify(snapshot)).not.toContain("Private journal");
  });

  it("is null for a trashed daily note", () => {
    const daily = makeNote({ id: "d1", dailyDate: TODAY_KEY, deleted: true, deletedAt: 1 });
    expect(buildWidgetSnapshot([daily], false, NOW).today).toBeNull();
  });
});

describe("buildWidgetSnapshot — App Lock generic mode", () => {
  it("stages no note data at all when App Lock is enabled", () => {
    const notes = [
      makeNote({ id: "n1", title: "Visible?", updatedAt: 2 }),
      makeNote({ id: "d1", title: "Journal", dailyDate: TODAY_KEY }),
    ];
    const snapshot = buildWidgetSnapshot(notes, true, NOW);
    expect(snapshot.mode).toBe("generic");
    expect(snapshot.today).toBeNull();
    expect(snapshot.notes).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("Visible?");
    expect(JSON.stringify(snapshot)).not.toContain("Journal");
  });
});

describe("widgetSnapshotKey — change detection", () => {
  it("ignores stagedAt and tracks content", async () => {
    const notes = [makeNote({ id: "n1", title: "One" })];
    const a = buildWidgetSnapshot(notes, false, new Date(2026, 9, 24, 10, 0));
    const b = buildWidgetSnapshot(notes, false, new Date(2026, 9, 24, 11, 0));
    expect(widgetSnapshotKey(a)).toBe(widgetSnapshotKey(b));

    const c = buildWidgetSnapshot([makeNote({ id: "n1", title: "Two" })], false, NOW);
    expect(widgetSnapshotKey(c)).not.toBe(widgetSnapshotKey(a));
  });
});

describe("stageWidgetSnapshot — the native seam", () => {
  it("stages the snapshot JSON through the plugin on Android", async () => {
    const { stageWidgetSnapshot } = await loadSeam();
    const snapshot = buildWidgetSnapshot([makeNote({ id: "n1", title: "Hi" })], false, NOW);
    stageWidgetSnapshot(snapshot);
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(1);
    const firstCall = mocks.stageSnapshot.mock.calls[0];
    if (!firstCall) throw new Error("expected a stageSnapshot call");
    const arg = firstCall[0] as { json: string };
    expect(JSON.parse(arg.json)).toMatchObject({ v: 1, mode: "content" });
  });

  it("does not re-stage an unchanged snapshot (stagedAt aside)", async () => {
    const { stageWidgetSnapshot } = await loadSeam();
    const notes = [makeNote({ id: "n1", title: "Same" })];
    stageWidgetSnapshot(buildWidgetSnapshot(notes, false, new Date(2026, 9, 24, 10, 0)));
    stageWidgetSnapshot(buildWidgetSnapshot(notes, false, new Date(2026, 9, 24, 12, 0)));
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(1);

    stageWidgetSnapshot(
      buildWidgetSnapshot([makeNote({ id: "n1", title: "Changed" })], false, NOW),
    );
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(2);
  });

  it("is a no-op off Android native", async () => {
    const { stageWidgetSnapshot } = await loadSeam();
    const snapshot = buildWidgetSnapshot([], false, NOW);

    mocks.native = false;
    stageWidgetSnapshot(snapshot);
    mocks.native = true;
    mocks.platform = "ios";
    stageWidgetSnapshot(snapshot);
    mocks.platform = "web";
    stageWidgetSnapshot(snapshot);

    expect(mocks.stageSnapshot).not.toHaveBeenCalled();
  });

  it("swallows a rejecting plugin and retries on the next trigger", async () => {
    const { stageWidgetSnapshot } = await loadSeam();
    const snapshot = buildWidgetSnapshot([makeNote({ id: "n1", title: "Retry" })], false, NOW);

    mocks.stageSnapshot.mockRejectedValueOnce(new Error("bridge down"));
    expect(() => stageWidgetSnapshot(snapshot)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    stageWidgetSnapshot(snapshot);
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(2);
  });

  it("swallows a synchronously throwing plugin", async () => {
    const { stageWidgetSnapshot } = await loadSeam();
    const snapshot = buildWidgetSnapshot([], false, NOW);
    mocks.stageSnapshot.mockImplementationOnce(() => {
      throw new Error("no bridge");
    });
    expect(() => stageWidgetSnapshot(snapshot)).not.toThrow();
    stageWidgetSnapshot(snapshot);
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe("clearWidgetSnapshot", () => {
  it("clears through the plugin and resets change detection", async () => {
    const { stageWidgetSnapshot, clearWidgetSnapshot } = await loadSeam();
    const snapshot = buildWidgetSnapshot([makeNote({ id: "n1", title: "Bye" })], false, NOW);

    stageWidgetSnapshot(snapshot);
    clearWidgetSnapshot();
    expect(mocks.clearSnapshot).toHaveBeenCalledTimes(1);

    // After a clear, the same content stages again — it has to, the
    // file on disk is gone.
    stageWidgetSnapshot(snapshot);
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(2);
  });

  it("is a no-op off Android native but still failure-proof", async () => {
    const { clearWidgetSnapshot } = await loadSeam();
    mocks.native = false;
    expect(() => clearWidgetSnapshot()).not.toThrow();
    expect(mocks.clearSnapshot).not.toHaveBeenCalled();
  });
});

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "./types";

/* Native-feel #10: the workspace's widget-snapshot sync hook — debounce,
 * change detection through the real seam, the App Lock flip, the
 * visibility flush, and the account-switch clear — tested against a
 * fake NomaWidget plugin, the seam the workspace actually uses. */

const mocks = vi.hoisted(() => ({
  stageSnapshot: vi.fn(async (_options: { json: string }) => {}),
  clearSnapshot: vi.fn(async () => {}),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  },
  registerPlugin: (name: string) =>
    name === "NomaWidget"
      ? { stageSnapshot: mocks.stageSnapshot, clearSnapshot: mocks.clearSnapshot }
      : {},
}));

import {
  resetWidgetSnapshotStateForTests,
  useWidgetSnapshotSync,
  WIDGET_STAGE_DEBOUNCE_MS,
} from "./widget-snapshot";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let visibilityState = "visible";
Object.defineProperty(document, "visibilityState", {
  configurable: true,
  get: () => visibilityState,
});

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

interface ProbeProps {
  notes: Note[] | undefined;
  appLockEnabled: boolean;
  dbName: string | null;
}

function Probe({ notes, appLockEnabled, dbName }: ProbeProps) {
  useWidgetSnapshotSync({ notes, appLockEnabled, dbName });
  return null;
}

let container: HTMLDivElement;
let root: Root;

function render(props: ProbeProps) {
  act(() => {
    root.render(<Probe {...props} />);
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

function stagedPayloads(): Array<Record<string, unknown>> {
  return mocks.stageSnapshot.mock.calls.map(
    (call) => JSON.parse((call[0] as { json: string }).json) as Record<string, unknown>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  resetWidgetSnapshotStateForTests();
  mocks.stageSnapshot.mockClear();
  mocks.clearSnapshot.mockClear();
  visibilityState = "visible";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
});

describe("useWidgetSnapshotSync", () => {
  it("stages the built snapshot after the debounce on mount", async () => {
    render({
      notes: [makeNote({ id: "n1", title: "First" })],
      appLockEnabled: false,
      dbName: "noma_a",
    });
    expect(mocks.stageSnapshot).not.toHaveBeenCalled();

    await advance(WIDGET_STAGE_DEBOUNCE_MS);
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(1);
    expect(stagedPayloads()[0]).toMatchObject({
      mode: "content",
      notes: [{ id: "n1", title: "First" }],
    });
  });

  it("does not re-stage when a rebuild yields the same content", async () => {
    const notes = [makeNote({ id: "n1", title: "Same" })];
    render({ notes, appLockEnabled: false, dbName: "noma_a" });
    await advance(WIDGET_STAGE_DEBOUNCE_MS);
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(1);

    // A fresh array identity with identical content rebuilds an equal
    // snapshot; the seam's change detection keeps it off the plugin.
    render({ notes: [...notes], appLockEnabled: false, dbName: "noma_a" });
    await advance(WIDGET_STAGE_DEBOUNCE_MS * 2);
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(1);
  });

  it("stages the generic snapshot when App Lock turns on", async () => {
    const notes = [makeNote({ id: "n1", title: "Titled" })];
    render({ notes, appLockEnabled: false, dbName: "noma_a" });
    await advance(WIDGET_STAGE_DEBOUNCE_MS);

    render({ notes, appLockEnabled: true, dbName: "noma_a" });
    await advance(WIDGET_STAGE_DEBOUNCE_MS);
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(2);
    expect(stagedPayloads()[1]).toMatchObject({ mode: "generic", notes: [], today: null });
  });

  it("flushes the latest snapshot immediately when the app hides", async () => {
    render({
      notes: [makeNote({ id: "n1", title: "Before" })],
      appLockEnabled: false,
      dbName: "noma_a",
    });
    await advance(WIDGET_STAGE_DEBOUNCE_MS / 2);

    render({
      notes: [makeNote({ id: "n1", title: "After" })],
      appLockEnabled: false,
      dbName: "noma_a",
    });
    visibilityState = "hidden";
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // The hidden flush staged the latest content without waiting out
    // the second debounce; the pending timer then dedupes away.
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(1);
    expect(stagedPayloads()[0]).toMatchObject({ notes: [{ id: "n1", title: "After" }] });
    await advance(WIDGET_STAGE_DEBOUNCE_MS * 2);
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(1);
  });

  it("clears the previous account's snapshot on an account switch", async () => {
    render({
      notes: [makeNote({ id: "a1", title: "Account A note" })],
      appLockEnabled: false,
      dbName: "noma_a",
    });
    await advance(WIDGET_STAGE_DEBOUNCE_MS);
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.clearSnapshot).not.toHaveBeenCalled();

    render({
      notes: [makeNote({ id: "b1", title: "Account B note" })],
      appLockEnabled: false,
      dbName: "noma_b",
    });
    await advance(WIDGET_STAGE_DEBOUNCE_MS);
    expect(mocks.clearSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(2);
    expect(stagedPayloads()[1]).toMatchObject({
      notes: [{ id: "b1", title: "Account B note" }],
    });
  });

  it("stages nothing until the notes query resolves", async () => {
    render({ notes: undefined, appLockEnabled: false, dbName: "noma_a" });
    await advance(WIDGET_STAGE_DEBOUNCE_MS * 2);
    expect(mocks.stageSnapshot).not.toHaveBeenCalled();

    render({ notes: [], appLockEnabled: false, dbName: "noma_a" });
    await advance(WIDGET_STAGE_DEBOUNCE_MS);
    expect(mocks.stageSnapshot).toHaveBeenCalledTimes(1);
    expect(stagedPayloads()[0]).toMatchObject({ mode: "content", notes: [] });
  });
});

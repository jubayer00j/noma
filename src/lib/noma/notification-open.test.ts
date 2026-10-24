import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionPerformed } from "@capacitor/local-notifications";
import type { Note, NoteLock } from "./types";

const mocks = vi.hoisted(() => ({
  native: true,
  handlers: new Map<string, (event: ActionPerformed) => void>(),
  addListener: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
}));

vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: { addListener: mocks.addListener },
}));

import {
  consumeNoteOpen,
  findNoteToOpen,
  getPendingNoteOpen,
  handleNotificationActionPerformed,
  initNotificationOpenListener,
  noteIdFromNotificationAction,
  requestNoteOpen,
  resetNotificationOpenStateForTests,
} from "./notification-open";

function makeNote(patch: Partial<Note> = {}): Note {
  return {
    id: "note-1",
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

function makeAction(extra: unknown): ActionPerformed {
  return {
    actionId: "tap",
    notification: { id: 1, title: "t", body: "b", extra },
  } as unknown as ActionPerformed;
}

beforeEach(() => {
  resetNotificationOpenStateForTests();
  mocks.native = true;
  mocks.handlers.clear();
  mocks.addListener.mockReset();
  mocks.addListener.mockImplementation(
    async (event: string, fn: (event: ActionPerformed) => void) => {
      mocks.handlers.set(event, fn);
      return { remove: async () => {} };
    },
  );
});

describe("pending note-open slot", () => {
  it("holds a request until it is consumed, exactly once", () => {
    requestNoteOpen("note-1");
    const request = getPendingNoteOpen();
    expect(request?.noteId).toBe("note-1");

    // A mismatched id leaves the request untouched.
    consumeNoteOpen("someone-else");
    expect(getPendingNoteOpen()?.noteId).toBe("note-1");

    consumeNoteOpen(request!.id);
    expect(getPendingNoteOpen()).toBeNull();

    // Consuming again is a no-op, not an error.
    consumeNoteOpen(request!.id);
    expect(getPendingNoteOpen()).toBeNull();
  });

  it("lets the latest request win", () => {
    requestNoteOpen("note-1");
    requestNoteOpen("note-2");
    expect(getPendingNoteOpen()?.noteId).toBe("note-2");
  });

  it("ignores an empty note id", () => {
    requestNoteOpen("");
    expect(getPendingNoteOpen()).toBeNull();
  });
});

describe("findNoteToOpen", () => {
  const notes = [
    makeNote({ id: "plain" }),
    makeNote({ id: "locked", lock: {} as NoteLock }),
    makeNote({ id: "trashed", deleted: true, deletedAt: 5 }),
  ];

  it("returns a plain note", () => {
    expect(findNoteToOpen(notes, "plain")?.id).toBe("plain");
  });

  it("returns a per-note-locked note (it lands on its unlock gate)", () => {
    expect(findNoteToOpen(notes, "locked")?.id).toBe("locked");
  });

  it("returns null for a trashed note — the tap resolves to a plain app open", () => {
    expect(findNoteToOpen(notes, "trashed")).toBeNull();
  });

  it("returns null for a note that no longer exists", () => {
    expect(findNoteToOpen(notes, "gone")).toBeNull();
  });
});

describe("tap wiring", () => {
  it("extracts the note id from the action's extra payload", () => {
    expect(noteIdFromNotificationAction(makeAction({ noteId: "n-9", reminderId: "r-1" }))).toBe(
      "n-9",
    );
    expect(noteIdFromNotificationAction(makeAction({ reminderId: "r-1" }))).toBeNull();
    expect(noteIdFromNotificationAction(makeAction(undefined))).toBeNull();
    expect(noteIdFromNotificationAction(makeAction({ noteId: 42 }))).toBeNull();
  });

  it("turns a tap into a pending-open request", () => {
    handleNotificationActionPerformed(makeAction({ noteId: "n-9" }));
    expect(getPendingNoteOpen()?.noteId).toBe("n-9");
  });

  it("ignores an action with no note id", () => {
    handleNotificationActionPerformed(makeAction({}));
    expect(getPendingNoteOpen()).toBeNull();
  });

  it("registers the plugin listener exactly once, and only on native", () => {
    initNotificationOpenListener();
    initNotificationOpenListener();
    expect(mocks.addListener).toHaveBeenCalledTimes(1);
    expect(mocks.addListener).toHaveBeenCalledWith(
      "localNotificationActionPerformed",
      expect.any(Function),
    );

    // The registered handler feeds the same slot.
    const handler = mocks.handlers.get("localNotificationActionPerformed");
    expect(handler).toBeTypeOf("function");
    handler!(makeAction({ noteId: "from-listener" }));
    expect(getPendingNoteOpen()?.noteId).toBe("from-listener");
  });

  it("does not register anything on web", () => {
    mocks.native = false;
    initNotificationOpenListener();
    expect(mocks.addListener).not.toHaveBeenCalled();
  });
});

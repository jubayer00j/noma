import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NomaDatabase } from "./db";
import type { Note, NoteLock, Reminder } from "./types";

const mocks = vi.hoisted(() => ({
  native: true,
  granted: true,
  schedule: vi.fn(),
  cancel: vi.fn(),
  createChannel: vi.fn(),
  checkPermissions: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
}));

vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    checkPermissions: mocks.checkPermissions,
    requestPermissions: vi.fn(async () => ({ display: "granted" })),
    schedule: mocks.schedule,
    cancel: mocks.cancel,
    createChannel: mocks.createChannel,
    addListener: vi.fn(async () => ({ remove: async () => {} })),
  },
}));

import {
  REMINDERS_CHANNEL_ID,
  formatReminderTime,
  notificationSnapshotForNote,
  rehydrateReminders,
  reminderNotificationText,
  resetRemindersChannelForTests,
  scheduleNotification,
} from "./notifications";
import { getPendingNoteOpen, resetNotificationOpenStateForTests } from "./notification-open";

const GENERIC = { title: "Reminder from Noma", body: "You have a scheduled note reminder." };

function makeReminder(patch: Partial<Reminder> = {}): Reminder {
  return {
    id: "rem-1",
    noteId: "note-1",
    scheduledAt: Date.now() + 60_000,
    status: "pending",
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

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

beforeEach(() => {
  mocks.native = true;
  mocks.granted = true;
  mocks.schedule.mockReset().mockResolvedValue({ notifications: [] });
  mocks.cancel.mockReset().mockResolvedValue(undefined);
  mocks.createChannel.mockReset().mockResolvedValue(undefined);
  mocks.checkPermissions
    .mockReset()
    .mockImplementation(async () => ({ display: mocks.granted ? "granted" : "denied" }));
  resetRemindersChannelForTests();
  resetNotificationOpenStateForTests();
});

describe("reminderNotificationText", () => {
  const reminder = makeReminder({ scheduledAt: new Date(2026, 9, 24, 9, 30).getTime() });

  it("uses the note title and the reminder time for an unlocked note", () => {
    const text = reminderNotificationText({ title: "Groceries", locked: false }, reminder);
    expect(text.title).toBe("Groceries");
    expect(text.body).toBe(`Reminder · ${formatReminderTime(reminder.scheduledAt)}`);
  });

  it("falls back to 'Untitled note' for a blank title", () => {
    expect(reminderNotificationText({ title: "   ", locked: false }, reminder).title).toBe(
      "Untitled note",
    );
  });

  it("keeps the generic pair, verbatim, for a locked note", () => {
    expect(reminderNotificationText({ title: "Bank details", locked: true }, reminder)).toEqual(
      GENERIC,
    );
  });

  it("keeps the generic pair when there is no note", () => {
    expect(reminderNotificationText(undefined, reminder)).toEqual(GENERIC);
  });

  it("formats the time in device locale", () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(reminder.scheduledAt));
    expect(formatReminderTime(reminder.scheduledAt)).toBe(expected);
  });
});

describe("notificationSnapshotForNote", () => {
  it("is undefined without a note", () => {
    expect(notificationSnapshotForNote(undefined)).toBeUndefined();
    expect(notificationSnapshotForNote(null)).toBeUndefined();
  });

  it("mirrors the list UI's lock check: a lock record means locked", () => {
    expect(notificationSnapshotForNote(makeNote({ title: "T", lock: null }))).toEqual({
      title: "T",
      locked: false,
    });
    expect(
      notificationSnapshotForNote(makeNote({ title: "T", lock: {} as NoteLock }))?.locked,
    ).toBe(true);
  });
});

describe("scheduleNotification (native)", () => {
  it("posts the built text on the reminders channel, extra intact", async () => {
    const reminder = makeReminder();
    await scheduleNotification(reminder, { title: "Groceries", locked: false });

    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    const posted = mocks.schedule.mock.calls[0]![0].notifications[0];
    expect(posted.title).toBe("Groceries");
    expect(posted.body).toBe(`Reminder · ${formatReminderTime(reminder.scheduledAt)}`);
    expect(posted.channelId).toBe(REMINDERS_CHANNEL_ID);
    expect(posted.extra).toEqual({ noteId: "note-1", reminderId: "rem-1" });
  });

  it("posts the generic text for a locked note", async () => {
    await scheduleNotification(makeReminder(), { title: "Bank details", locked: true });
    const posted = mocks.schedule.mock.calls[0]![0].notifications[0];
    expect(posted.title).toBe(GENERIC.title);
    expect(posted.body).toBe(GENERIC.body);
    expect(posted.channelId).toBe(REMINDERS_CHANNEL_ID);
  });

  it("creates the channel once per session, with importance high", async () => {
    await scheduleNotification(makeReminder({ id: "rem-a" }), undefined);
    await scheduleNotification(makeReminder({ id: "rem-b" }), undefined);
    expect(mocks.createChannel).toHaveBeenCalledTimes(1);
    expect(mocks.createChannel).toHaveBeenCalledWith({
      id: "noma-reminders",
      name: "Note reminders",
      description: "Reminders you set on notes",
      importance: 4,
    });
  });

  it("schedules nothing when permission is not granted", async () => {
    mocks.granted = false;
    await scheduleNotification(makeReminder(), { title: "Groceries", locked: false });
    expect(mocks.schedule).not.toHaveBeenCalled();
    expect(mocks.createChannel).not.toHaveBeenCalled();
  });
});

describe("rehydrateReminders (native)", () => {
  function makeDb(notes: Note[], reminders: Reminder[]): NomaDatabase {
    return {
      reminders: {
        filter: (fn: (r: Reminder) => boolean) => ({
          toArray: async () => reminders.filter(fn),
        }),
      },
      notes: {
        bulkGet: async (ids: string[]) => ids.map((id) => notes.find((n) => n.id === id)),
      },
    } as unknown as NomaDatabase;
  }

  it("re-posts every pending reminder with its note's text on the channel", async () => {
    const notes = [
      makeNote({ id: "n-open", title: "Groceries" }),
      makeNote({ id: "n-locked", title: "Bank details", lock: {} as NoteLock }),
    ];
    const reminders = [
      makeReminder({ id: "r-open", noteId: "n-open" }),
      makeReminder({ id: "r-locked", noteId: "n-locked" }),
      makeReminder({ id: "r-orphan", noteId: "n-gone" }),
      // Excluded by the rehydrate filter itself:
      makeReminder({ id: "r-alarm", noteId: "n-open", alertType: "phone-alarm" }),
      makeReminder({ id: "r-done", noteId: "n-open", status: "completed" }),
    ];

    await rehydrateReminders(makeDb(notes, reminders));

    expect(mocks.schedule).toHaveBeenCalledTimes(3);
    const byReminder = new Map(
      mocks.schedule.mock.calls.map((call) => {
        const posted = call[0].notifications[0];
        return [posted.extra.reminderId as string, posted];
      }),
    );
    expect(byReminder.get("r-open")?.title).toBe("Groceries");
    expect(byReminder.get("r-locked")?.title).toBe(GENERIC.title);
    expect(byReminder.get("r-orphan")?.title).toBe(GENERIC.title);
    for (const posted of byReminder.values()) {
      expect(posted.channelId).toBe(REMINDERS_CHANNEL_ID);
    }
    expect(mocks.createChannel).toHaveBeenCalledTimes(1);
  });
});

describe("web timer path", () => {
  class FakeNotification {
    static permission: NotificationPermission = "granted";
    static instances: FakeNotification[] = [];
    onclick: (() => void) | null = null;
    closed = false;
    constructor(
      public title: string,
      public options?: NotificationOptions,
    ) {
      FakeNotification.instances.push(this);
    }
    close() {
      this.closed = true;
    }
  }

  const focusSpy = vi.fn();

  beforeEach(() => {
    mocks.native = false;
    FakeNotification.instances = [];
    focusSpy.mockClear();
    const g = globalThis as Record<string, unknown>;
    g["window"] = { Notification: FakeNotification, focus: focusSpy };
    g["Notification"] = FakeNotification;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    const g = globalThis as Record<string, unknown>;
    delete g["window"];
    delete g["Notification"];
  });

  it("fires with the built text and its click feeds the pending-open slot", async () => {
    const reminder = makeReminder({ scheduledAt: Date.now() + 1_000 });
    await scheduleNotification(reminder, { title: "Groceries", locked: false });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeNotification.instances).toHaveLength(1);
    const fired = FakeNotification.instances[0]!;
    expect(fired.title).toBe("Groceries");
    expect(fired.options?.body).toBe(`Reminder · ${formatReminderTime(reminder.scheduledAt)}`);

    fired.onclick?.();
    expect(focusSpy).toHaveBeenCalled();
    expect(getPendingNoteOpen()?.noteId).toBe("note-1");
    expect(fired.closed).toBe(true);
  });
});

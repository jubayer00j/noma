import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { NomaDatabase } from "./db";
import { requestNoteOpen } from "./notification-open";
import type { Note, Reminder } from "./types";

export interface NotificationCapability {
  supported: boolean;
  canScheduleBackground: boolean;
  permissionGranted: boolean;
  permissionState: "granted" | "denied" | "prompt" | "unsupported";
  reason?: string;
}

export async function checkNotificationCapability(): Promise<NotificationCapability> {
  const isNative = Capacitor.isNativePlatform();

  if (isNative) {
    try {
      const status = await LocalNotifications.checkPermissions();
      const granted = status.display === "granted";
      return {
        supported: true,
        canScheduleBackground: true,
        permissionGranted: granted,
        permissionState: granted ? "granted" : status.display === "denied" ? "denied" : "prompt",
      };
    } catch {
      return {
        supported: false,
        canScheduleBackground: false,
        permissionGranted: false,
        permissionState: "unsupported",
        reason: "Local notifications plugin unavailable.",
      };
    }
  }

  // Web / PWA Environment
  if (typeof window === "undefined" || !("Notification" in window)) {
    return {
      supported: false,
      canScheduleBackground: false,
      permissionGranted: false,
      permissionState: "unsupported",
      reason: "Browser notifications are not supported on this device/browser.",
    };
  }

  const permission = Notification.permission;
  const granted = permission === "granted";
  const permissionState = permission === "default" ? "prompt" : permission;

  return {
    supported: true,
    // Web notifications only guarantee background delivery if supported by Service Worker / Notification API while browser context is active.
    canScheduleBackground: false,
    permissionGranted: granted,
    permissionState: permissionState,
    reason:
      "Web notifications fire while Noma is open or active in browser. Scheduled background delivery requires full PWA/browser support.",
  };
}

export async function requestNotificationPermission(): Promise<boolean> {
  const isNative = Capacitor.isNativePlatform();

  if (isNative) {
    try {
      const result = await LocalNotifications.requestPermissions();
      return result.display === "granted";
    } catch {
      return false;
    }
  }

  if (typeof window !== "undefined" && "Notification" in window) {
    try {
      const permission = await Notification.requestPermission();
      return permission === "granted";
    } catch {
      return false;
    }
  }

  return false;
}

/* ---------------- Notification text (native-feel #8) ---------------- */

export const REMINDERS_CHANNEL_ID = "noma-reminders";

const GENERIC_NOTIFICATION_TITLE = "Reminder from Noma";
const GENERIC_NOTIFICATION_BODY = "You have a scheduled note reminder.";

/**
 * The minimum note data notification text is allowed to see: a title and
 * whether the note is per-note locked. Never the body — see the privacy
 * requirement on reminderNotificationText.
 */
export interface NoteNotificationSnapshot {
  title: string;
  locked: boolean;
}

/**
 * Builds the snapshot for a note (undefined when there is no note). The
 * lock flag is the note list UI's own check — note-list.tsx treats a note
 * as locked iff it carries a lock record — and there is deliberately no
 * second definition of "locked" here.
 */
export function notificationSnapshotForNote(
  note: Note | null | undefined,
): NoteNotificationSnapshot | undefined {
  if (!note) return undefined;
  return { title: note.title, locked: Boolean(note.lock) };
}

const reminderTimeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * The reminder time in device locale, e.g. "Fri, 24 Oct, 9:30 AM".
 * (The reminder dialog has no importable formatter — it works with date
 * inputs — so this follows daily.ts / version-history-dialog's
 * Intl.DateTimeFormat precedent instead.)
 */
export function formatReminderTime(scheduledAt: number): string {
  return reminderTimeFormat.format(new Date(scheduledAt));
}

/**
 * PRIVACY REQUIREMENT (unchanged in substance from the original generic
 * text): note CONTENT never appears in notification text. Native-feel #8
 * refines only which metadata may show:
 * - Unlocked note → its title (metadata the app itself shows in lists)
 *   plus the reminder time.
 * - Locked note, or no note at all → the original generic pair, verbatim:
 *   a locked note's title never reaches the phone's lock screen.
 */
export function reminderNotificationText(
  note: NoteNotificationSnapshot | undefined,
  reminder: Reminder,
): { title: string; body: string } {
  if (note && !note.locked) {
    const title = note.title.trim() || "Untitled note";
    return { title, body: `Reminder · ${formatReminderTime(reminder.scheduledAt)}` };
  }
  return { title: GENERIC_NOTIFICATION_TITLE, body: GENERIC_NOTIFICATION_BODY };
}

/* ---------------- Reminders channel (native-feel #8) ---------------- */

let remindersChannelEnsured = false;

/**
 * Creates the "Note reminders" channel, at most once per app session.
 * (Android also treats re-creating an existing channel as a no-op, but
 * there is no reason to pay the bridge call on every reminder.) A failure
 * is swallowed: reminders still post — to the plugin's default channel
 * rather than not at all.
 */
export async function ensureRemindersChannel(): Promise<void> {
  if (remindersChannelEnsured) return;
  remindersChannelEnsured = true;
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.createChannel({
      id: REMINDERS_CHANNEL_ID,
      name: "Note reminders",
      description: "Reminders you set on notes",
      // Importance high: heads-up + sound. A reminder that whispers is a
      // reminder missed. Android locks importance after creation, so
      // this is chosen deliberately; the user can turn it down in the
      // system channel settings at any time.
      importance: 4,
    });
  } catch (e) {
    console.warn("Failed to create the reminders notification channel:", e);
  }
}

/** Test-only: forget that the channel was ensured this session. */
export function resetRemindersChannelForTests(): void {
  remindersChannelEnsured = false;
}

// In-memory web timer store for active session scheduling on web
const webTimers = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_TIMEOUT_MS = 2147483647; // 2^31 - 1 max 32-bit signed int for setTimeout

/**
 * Generates a numeric 32-bit positive integer ID for Capacitor Local Notifications from a string UUID.
 */
function hashNotificationId(reminderId: string): number {
  let hash = 5381;
  for (let i = 0; i < reminderId.length; i++) {
    hash = (hash * 33) ^ reminderId.charCodeAt(i);
  }
  return (hash >>> 0) % 2147483647 || 1;
}

function scheduleWebTimer(reminder: Reminder, note?: NoteNotificationSnapshot) {
  if (webTimers.has(reminder.id)) {
    clearTimeout(webTimers.get(reminder.id));
    webTimers.delete(reminder.id);
  }

  const delay = reminder.scheduledAt - Date.now();
  if (delay <= 0) return;

  const currentDelay = Math.min(delay, MAX_TIMEOUT_MS);

  const timer = setTimeout(() => {
    webTimers.delete(reminder.id);
    const remaining = reminder.scheduledAt - Date.now();
    if (remaining > 1000) {
      scheduleWebTimer(reminder, note);
    } else {
      if (
        typeof window !== "undefined" &&
        "Notification" in window &&
        Notification.permission === "granted"
      ) {
        const text = reminderNotificationText(note, reminder);
        try {
          const notification = new Notification(text.title, {
            body: text.body,
            icon: "/noma-icon-192.png",
            tag: reminder.id,
          });
          // A click lands on the same pending-open path a native tap feeds.
          notification.onclick = () => {
            try {
              window.focus();
            } catch {
              /* focus is best-effort */
            }
            requestNoteOpen(reminder.noteId);
            notification.close();
          };
        } catch (e) {
          console.warn("Failed to deliver Web Notification:", e);
        }
      }
    }
  }, currentDelay);

  webTimers.set(reminder.id, timer);
}

export async function scheduleNotification(
  reminder: Reminder,
  note?: NoteNotificationSnapshot,
): Promise<number | undefined> {
  const isNative = Capacitor.isNativePlatform();
  const notifId = reminder.notificationId ?? hashNotificationId(reminder.id);

  const capability = await checkNotificationCapability();
  if (!capability.permissionGranted) {
    return notifId;
  }

  const scheduledDate = new Date(reminder.scheduledAt);
  const text = reminderNotificationText(note, reminder);

  if (isNative) {
    try {
      await ensureRemindersChannel();
      // Cancel any prior notification with same ID first
      await LocalNotifications.cancel({ notifications: [{ id: notifId }] }).catch(() => {});

      if (reminder.scheduledAt > Date.now()) {
        await LocalNotifications.schedule({
          notifications: [
            {
              id: notifId,
              title: text.title,
              body: text.body,
              channelId: REMINDERS_CHANNEL_ID,
              schedule: { at: scheduledDate },
              extra: { noteId: reminder.noteId, reminderId: reminder.id },
            },
          ],
        });
      }
    } catch (e) {
      console.warn("Failed to schedule local notification on Android:", e);
    }
    return notifId;
  }

  // Web/PWA Implementation
  scheduleWebTimer(reminder, note);

  return notifId;
}

export async function rehydrateReminders(db: NomaDatabase): Promise<void> {
  const isNative = Capacitor.isNativePlatform();
  const capability = await checkNotificationCapability();

  if (!capability.permissionGranted) {
    return;
  }

  const now = Date.now();
  try {
    // Phone-alarm reminders are intentionally excluded: their alerts live in
    // the external Clock app and cannot be recreated silently by Noma.
    const pendingReminders = await db.reminders
      .filter((r) => r.status === "pending" && r.scheduledAt > now && r.alertType !== "phone-alarm")
      .toArray();

    // One bulk fetch for every referenced note: the text builder needs each
    // note's title + lock state, never its content.
    const noteIds = [...new Set(pendingReminders.map((r) => r.noteId))];
    const fetchedNotes = noteIds.length ? await db.notes.bulkGet(noteIds) : [];
    const snapshots = new Map<string, NoteNotificationSnapshot | undefined>();
    noteIds.forEach((noteId, index) => {
      snapshots.set(noteId, notificationSnapshotForNote(fetchedNotes[index]));
    });

    if (isNative) {
      await ensureRemindersChannel();
      for (const reminder of pendingReminders) {
        const notifId = reminder.notificationId ?? hashNotificationId(reminder.id);
        const scheduledDate = new Date(reminder.scheduledAt);
        const text = reminderNotificationText(snapshots.get(reminder.noteId), reminder);
        await LocalNotifications.cancel({ notifications: [{ id: notifId }] }).catch(() => {});
        await LocalNotifications.schedule({
          notifications: [
            {
              id: notifId,
              title: text.title,
              body: text.body,
              channelId: REMINDERS_CHANNEL_ID,
              schedule: { at: scheduledDate },
              extra: { noteId: reminder.noteId, reminderId: reminder.id },
            },
          ],
        }).catch((e) => console.warn("Failed rehydrating native notification:", e));
      }
    } else {
      for (const reminder of pendingReminders) {
        scheduleWebTimer(reminder, snapshots.get(reminder.noteId));
      }
    }
  } catch (e) {
    console.warn("Failed to rehydrate reminders:", e);
  }
}

export async function cancelNotification(
  reminderId: string,
  notificationId?: number,
): Promise<void> {
  const isNative = Capacitor.isNativePlatform();

  if (isNative) {
    const notifId = notificationId ?? hashNotificationId(reminderId);
    try {
      await LocalNotifications.cancel({ notifications: [{ id: notifId }] });
    } catch (e) {
      console.warn("Failed to cancel local notification:", e);
    }
  }

  if (webTimers.has(reminderId)) {
    clearTimeout(webTimers.get(reminderId));
    webTimers.delete(reminderId);
  }
}

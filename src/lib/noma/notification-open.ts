import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications, type ActionPerformed } from "@capacitor/local-notifications";
import type { Note } from "./types";

/**
 * The one pending "open this note" slot that notification taps feed
 * (native-feel #8). Modelled on capture.ts: a tap is normalised into a
 * request, held in memory, and consumed by the workspace only when the
 * database is ready and the App Lock is unlocked — so a tap can never
 * bypass the App Lock or land before there's anything to open.
 *
 * Unlike captures, a tap is singular: there is exactly one note the user
 * most recently asked to see, so a newer request replaces an older one.
 * Consuming is by id and happens exactly once.
 */

export interface NoteOpenRequest {
  id: string;
  noteId: string;
}

let idCounter = 0;
let pendingRequest: NoteOpenRequest | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((listener) => listener());
}

/** Records a request to open a note. The latest request wins. */
export function requestNoteOpen(noteId: string): void {
  if (!noteId) return;
  idCounter += 1;
  pendingRequest = {
    id: `note-open-${Date.now().toString(36)}-${idCounter.toString(36)}`,
    noteId,
  };
  notifyListeners();
}

/** The unconsumed request, or null when there is none. */
export function getPendingNoteOpen(): NoteOpenRequest | null {
  return pendingRequest;
}

/** Removes the request with this id; any other id leaves it untouched. */
export function consumeNoteOpen(id: string): void {
  if (!pendingRequest || pendingRequest.id !== id) return;
  pendingRequest = null;
  notifyListeners();
}

/** Hook form of the slot: re-renders whenever the pending request changes. */
export function usePendingNoteOpen() {
  const [, setTick] = useState(0);

  useEffect(() => {
    const onChange = () => setTick((t) => t + 1);
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  return { request: getPendingNoteOpen(), consume: consumeNoteOpen };
}

/**
 * The note a request should land on, or null when it no longer exists or
 * sits in Trash — the request then resolves to a plain app open, silently.
 * A per-note-locked note IS returned: opening it lands on its unlock gate,
 * via the workspace's normal open path.
 */
export function findNoteToOpen(notes: readonly Note[], noteId: string): Note | null {
  const note = notes.find((candidate) => candidate.id === noteId);
  if (!note || note.deleted) return null;
  return note;
}

/* ---------------- Tap wiring ---------------- */

/** The note id a performed notification action points at, if any. */
export function noteIdFromNotificationAction(action: ActionPerformed): string | null {
  const extra = action?.notification?.extra as { noteId?: unknown } | undefined;
  return typeof extra?.noteId === "string" && extra.noteId ? extra.noteId : null;
}

/** Turns a notification tap into a pending-open request. */
export function handleNotificationActionPerformed(action: ActionPerformed): void {
  const noteId = noteIdFromNotificationAction(action);
  if (noteId) requestNoteOpen(noteId);
}

let listenerRegistered = false;

/**
 * Registers the one app-wide notification-tap listener. Called once from
 * the app shell (AppGate); later calls are no-ops.
 *
 * Cold-start taps are covered by the bridge, not by a delivered-scan:
 * BridgeActivity forwards the launching intent to every plugin during
 * onCreate, the LocalNotifications plugin answers it with
 * notifyListeners(..., retainUntilConsumed = true), and Capacitor core
 * replays retained events to the first listener that registers — which
 * is this one, on every start. (Verified against the installed
 * @capacitor/local-notifications 7.0.7 + @capacitor/android sources.)
 */
export function initNotificationOpenListener(): void {
  if (listenerRegistered) return;
  if (!Capacitor.isNativePlatform()) return;
  listenerRegistered = true;
  void LocalNotifications.addListener(
    "localNotificationActionPerformed",
    handleNotificationActionPerformed,
  ).catch(() => {
    // Allow a later init attempt to retry a failed registration.
    listenerRegistered = false;
  });
}

/** Test-only: clears the pending request and the registration flag. */
export function resetNotificationOpenStateForTests(): void {
  pendingRequest = null;
  listenerRegistered = false;
  notifyListeners();
}

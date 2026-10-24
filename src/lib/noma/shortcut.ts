import { useEffect, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp, type URLOpenListenerEvent } from "@capacitor/app";

/** The only launcher-shortcut actions Noma answers to. */
export type ShortcutAction = "new-note" | "today";

const SHORTCUT_ACTIONS: readonly ShortcutAction[] = ["new-note", "today"];

let pendingShortcut: { id: number; action: ShortcutAction } | null = null;
let lastProcessedId = 0;
let isInitialized = false;
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((listener) => listener());
}

function setPendingShortcut(action: ShortcutAction) {
  const id = Date.now();
  if (id === lastProcessedId) return;
  pendingShortcut = { id, action };
  notifyListeners();
}

/**
 * Strict validation for Noma launcher deep link URLs.
 * Accepts only `app.noma.notes://<action>` or `app.noma.notes://<action>/`
 * where <action> is on the allowlist ("new-note", "today").
 * Rejects any arbitrary string, unknown scheme, host, path, or query parameter.
 */
export function parseShortcutAction(urlString: string): ShortcutAction | null {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== "app.noma.notes:") return null;
    if (!SHORTCUT_ACTIONS.includes(parsed.host as ShortcutAction)) return null;
    if (parsed.pathname !== "" && parsed.pathname !== "/") return null;
    if (parsed.search !== "" || parsed.hash !== "") return null;
    return parsed.host as ShortcutAction;
  } catch {
    return null;
  }
}

/**
 * The original single-action check, kept for compatibility: true only for
 * the "new-note" deep link. New code should use parseShortcutAction.
 */
export function isValidNewNoteUrl(urlString: string): boolean {
  return parseShortcutAction(urlString) === "new-note";
}

export function processShortcutUrl(url: string | undefined) {
  if (!url) return;
  const action = parseShortcutAction(url);
  if (action) setPendingShortcut(action);
}

/** The action waiting to be consumed, if any. */
export function getPendingShortcutAction(): ShortcutAction | null {
  return pendingShortcut?.action ?? null;
}

export function initShortcutListener() {
  if (isInitialized || !Capacitor.isNativePlatform()) return;
  isInitialized = true;

  // Cold launch URL check
  void CapacitorApp.getLaunchUrl().then((launchUrl) => {
    if (launchUrl?.url) {
      processShortcutUrl(launchUrl.url);
    }
  });

  // Warm / background launch URL check
  void CapacitorApp.addListener("appUrlOpen", (event: URLOpenListenerEvent) => {
    processShortcutUrl(event.url);
  });
}

/**
 * Boot check for the PWA manifest shortcuts that use the `?shortcut=`
 * param (the "Today" entry → /?shortcut=today). The value must name an
 * allowlisted shortcut action exactly — anything else is ignored. The
 * action lands in the same pending slot the native deep links feed, so
 * the workspace consumes it under the same DB-ready + unlocked gate; the
 * param is stripped so a reload doesn't fire twice. Returns true when it
 * fired. (The older "New note" PWA entry keeps its `?capture=new-note`
 * route into the capture queue — see share-target.ts.)
 */
export function checkWebShortcutParam(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get("shortcut");
    if (!value || !SHORTCUT_ACTIONS.includes(value as ShortcutAction)) return false;
    params.delete("shortcut");
    const query = params.toString();
    const cleanUrl = window.location.pathname + (query ? `?${query}` : "") + window.location.hash;
    window.history.replaceState(window.history.state, "", cleanUrl);
    setPendingShortcut(value as ShortcutAction);
    return true;
  } catch {
    return false;
  }
}

/**
 * Component mounted high in the root provider tree to ensure native launch URL
 * events are captured regardless of App Lock state or current route.
 */
export function ShortcutListener({ children }: { children?: ReactNode }) {
  useEffect(() => {
    initShortcutListener();
  }, []);

  return children;
}

/**
 * Hook to consume any pending launcher shortcut actions.
 * Returns the active action (e.g., 'new-note') if one is pending, and a function to clear it.
 */
export function usePendingShortcut() {
  const [, setTick] = useState(0);

  useEffect(() => {
    initShortcutListener();

    const onChange = () => setTick((t) => t + 1);
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  const action = pendingShortcut?.action ?? null;

  const consumeShortcut = () => {
    if (pendingShortcut) {
      lastProcessedId = pendingShortcut.id;
      pendingShortcut = null;
      notifyListeners();
    }
  };

  return { action, consumeShortcut, isValidNewNoteUrl };
}

/**
 * Consumes pending launcher-shortcut actions under the workspace gate:
 * nothing runs until the database exists and the App Lock state has
 * resolved to unlocked — a shortcut tap behind the lock waits, exactly
 * like quick capture. Each trigger is consumed exactly once, before its
 * handler runs, so a re-render can never fire it twice.
 */
export function useShortcutConsumption<Db>(options: {
  db: Db | null | undefined;
  isLockStateResolving: boolean;
  isLocked: boolean;
  onNewNote: () => void | Promise<void>;
  onToday: () => void | Promise<void>;
}): void {
  const { action, consumeShortcut } = usePendingShortcut();
  const { db, isLockStateResolving, isLocked, onNewNote, onToday } = options;

  useEffect(() => {
    if (!db || isLockStateResolving || isLocked) return;
    if (action === "new-note") {
      consumeShortcut();
      void onNewNote();
    } else if (action === "today") {
      consumeShortcut();
      void onToday();
    }
  }, [action, db, isLockStateResolving, isLocked, consumeShortcut, onNewNote, onToday]);
}

/** Test seam, mirroring capture.ts: clears the pending slot and dedupe id. */
export function resetShortcutStateForTests(): void {
  pendingShortcut = null;
  lastProcessedId = 0;
  notifyListeners();
}

import { useEffect, useRef } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { localDateKey } from "./daily";
import type { Note } from "./types";

/**
 * Home-screen widget v2 (native-feel #10): a staged snapshot.
 *
 * Widgets can't read the WebView's IndexedDB (that's why v1 was only a
 * branded tap target), so the web layer — which owns the data — stages a
 * small JSON snapshot into the app's private storage through the
 * NomaWidget plugin, and NomaWidgetProvider renders from that file with
 * no WebView alive. The shape mirrors the staged-backup discipline
 * (PR #60): web builds, native stores, neither side reaches into the
 * other's world.
 *
 * The snapshot is a privacy surface — the most exposed one Noma has,
 * since it sits on the home screen all day — so the builder below is the
 * ONE place the policy lives:
 *
 *   - App Lock enabled → a "generic" snapshot: no note data at all, and
 *     the widget keeps the v1 branded look. App Lock's promise is that
 *     content waits behind the gate; a persistent title list would
 *     quietly break it. (Turning App Lock off re-stages content on the
 *     next trigger.)
 *   - Per-note-locked notes contribute nothing in either mode — not a
 *     title, not a placeholder (the reminder rule, PR #78, applied to a
 *     surface that never disappears). A locked daily note nulls the
 *     Today row rather than leaking its title.
 *   - Only titles ever stage. Note content has no path into this file.
 *
 * Which notes: the ordinary list precedent (view.ts) — templates are
 * partitioned out of every ordinary view, trashed and archived notes are
 * put away, so none of them surface here. Order is the list's own
 * default: pinned first, then most recently updated.
 */

export interface WidgetSnapshotNote {
  id: string;
  title: string;
}

export interface WidgetSnapshot {
  v: 1;
  stagedAt: number;
  mode: "content" | "generic";
  today: { title: string } | null;
  notes: WidgetSnapshotNote[];
}

/** The widget shows at most this many note rows. */
export const WIDGET_NOTES_LIMIT = 3;

function widgetTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed === "" ? "Untitled note" : trimmed;
}

/** Notes the widget may list, in list order: pinned first, then newest. */
function widgetNotes(notes: readonly Note[]): WidgetSnapshotNote[] {
  return notes
    .filter((note) => !note.deleted && !note.isTemplate && !note.archived && !note.lock)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, WIDGET_NOTES_LIMIT)
    .map((note) => ({ id: note.id, title: widgetTitle(note.title) }));
}

/**
 * Today's row: the daily note for the LOCAL date, when one exists and is
 * not per-note locked. A locked daily note returns null — the row then
 * shows its invitation text, never the locked title.
 */
function widgetToday(notes: readonly Note[], now: Date): { title: string } | null {
  const key = localDateKey(now);
  const daily = notes.find((note) => note.dailyDate === key && !note.deleted && !note.isTemplate);
  if (!daily || daily.lock) return null;
  return { title: widgetTitle(daily.title) };
}

/**
 * Builds the snapshot for the current library state. Pure: same inputs,
 * same snapshot (stagedAt aside). App Lock wins over everything — a
 * generic snapshot is staged, so even the file on disk holds no titles.
 */
export function buildWidgetSnapshot(
  notes: readonly Note[],
  appLockEnabled: boolean,
  now: Date = new Date(),
): WidgetSnapshot {
  if (appLockEnabled) {
    return { v: 1, stagedAt: now.getTime(), mode: "generic", today: null, notes: [] };
  }
  return {
    v: 1,
    stagedAt: now.getTime(),
    mode: "content",
    today: widgetToday(notes, now),
    notes: widgetNotes(notes),
  };
}

/**
 * The change-detection key: everything EXCEPT stagedAt. Two snapshots
 * with the same content are the same snapshot, however often they're
 * rebuilt — staging is a plugin call plus a file write, and it only
 * happens when this key moves.
 */
export function widgetSnapshotKey(snapshot: WidgetSnapshot): string {
  return JSON.stringify({
    v: snapshot.v,
    mode: snapshot.mode,
    today: snapshot.today,
    notes: snapshot.notes,
  });
}

/* ---------------- Native staging seam ---------------- */

interface NomaWidgetPlugin {
  stageSnapshot(options: { json: string }): Promise<void>;
  clearSnapshot(): Promise<void>;
}

const NativeWidget = registerPlugin<NomaWidgetPlugin>("NomaWidget");

function isAndroidNative(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

let lastStagedKey: string | null = null;

/**
 * Stages a snapshot natively. Fire-and-forget and failure-proof (the
 * system-bars / haptics discipline): off Android it's a no-op, an
 * unchanged snapshot never reaches the plugin twice, and a failed stage
 * forgets its key so the next trigger retries instead of believing the
 * widget is current.
 */
export function stageWidgetSnapshot(snapshot: WidgetSnapshot): void {
  if (!isAndroidNative()) return;
  const key = widgetSnapshotKey(snapshot);
  if (key === lastStagedKey) return;
  lastStagedKey = key;
  try {
    void NativeWidget.stageSnapshot({ json: JSON.stringify(snapshot) }).catch(() => {
      if (lastStagedKey === key) lastStagedKey = null;
    });
  } catch {
    if (lastStagedKey === key) lastStagedKey = null;
  }
}

/**
 * Deletes the staged snapshot (sign-out, account switch). The widget
 * falls back to its v1 branded look until the next account stages its
 * own. Same fire-and-forget discipline as staging.
 */
export function clearWidgetSnapshot(): void {
  lastStagedKey = null;
  if (!isAndroidNative()) return;
  try {
    void NativeWidget.clearSnapshot().catch(() => {
      /* Clearing is best-effort; the next stage overwrites regardless. */
    });
  } catch {
    /* Plugin unavailable — nothing staged to clear. */
  }
}

/** Test seam: forgets the change-detection key so tests start clean. */
export function resetWidgetSnapshotStateForTests(): void {
  lastStagedKey = null;
}

/* ---------------- Workspace sync ---------------- */

/** Notes changes settle briefly before staging rebuilds the snapshot. */
export const WIDGET_STAGE_DEBOUNCE_MS = 500;

/**
 * Keeps the staged snapshot in step with the library:
 *
 *   - stages on mount and whenever the notes / App Lock inputs change
 *     (debounced; the seam's change detection drops no-op rebuilds),
 *   - flushes immediately when the app hides, catching the last edit,
 *   - and on an account switch (db name change) clears the previous
 *     account's snapshot BEFORE the new one lands — a snapshot must
 *     never outlive the account that staged it. Sign-out clears through
 *     auth.tsx as well; the new account stages its own on entry.
 *
 * `notes` is the workspace's live query: undefined until it resolves,
 * and nothing stages before then.
 */
export function useWidgetSnapshotSync(options: {
  notes: readonly Note[] | undefined;
  appLockEnabled: boolean;
  dbName: string | null | undefined;
}): void {
  const { notes, appLockEnabled, dbName } = options;
  const latestRef = useRef({ notes, appLockEnabled });
  latestRef.current = { notes, appLockEnabled };
  const lastDbNameRef = useRef<string | null>(null);

  useEffect(() => {
    if (!dbName || !notes) return;
    if (lastDbNameRef.current !== dbName) {
      if (lastDbNameRef.current !== null) clearWidgetSnapshot();
      lastDbNameRef.current = dbName;
    }
    const timer = setTimeout(() => {
      const latest = latestRef.current;
      if (!latest.notes) return;
      stageWidgetSnapshot(buildWidgetSnapshot(latest.notes, latest.appLockEnabled));
    }, WIDGET_STAGE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [notes, appLockEnabled, dbName]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      if (!lastDbNameRef.current) return;
      const latest = latestRef.current;
      if (!latest.notes) return;
      stageWidgetSnapshot(buildWidgetSnapshot(latest.notes, latest.appLockEnabled));
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);
}

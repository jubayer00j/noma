import { backupNow, getConnection, hasUnbackedChanges } from "./drive";
import type { NomaDatabase } from "./db";
import type { BackupMode } from "./types";

/**
 * The app-level automatic backup engine.
 *
 * This replaces the old Settings-card timer, which only ran while the
 * Settings screen was open — the reason "auto backup" appeared to do
 * nothing. The engine is mounted once in the app shell and lives for the
 * whole session:
 *
 * - "sync" mode: any write to the backed-up tables marks the library
 *   dirty; after a short quiet period the current snapshot is uploaded.
 *   Offline changes stay pending and flush on reconnect / foreground.
 * - "scheduled" mode (WhatsApp-style): a backup runs when the chosen
 *   interval has elapsed since the last successful one — checked at
 *   start, on foreground, on reconnect, and on a slow tick. Overdue
 *   backups therefore land at the next app open.
 *
 * Backups only ever upload when the library signature actually changed
 * (`hasUnbackedChanges`), so an idle app never spams Drive.
 */

export interface BackupIntervalPreset {
  label: string;
  minutes: number;
}

export const BACKUP_INTERVAL_PRESETS: BackupIntervalPreset[] = [
  { label: "Every 6 hours", minutes: 360 },
  { label: "Every 12 hours", minutes: 720 },
  { label: "Daily", minutes: 1440 },
  { label: "Every 2 days", minutes: 2880 },
  { label: "Weekly", minutes: 10080 },
];

/** Custom intervals are clamped to between one hour and thirty days. */
export const MIN_BACKUP_INTERVAL_MINUTES = 60;
export const MAX_BACKUP_INTERVAL_MINUTES = 43_200;

export function clampBackupIntervalMinutes(value: number): number {
  if (!Number.isFinite(value)) return 1440;
  return Math.min(
    MAX_BACKUP_INTERVAL_MINUTES,
    Math.max(MIN_BACKUP_INTERVAL_MINUTES, Math.round(value)),
  );
}

/** Human label for an interval: "Daily", "Every 6 hours", "Every 3 days". */
export function formatBackupInterval(minutes: number): string {
  const clamped = clampBackupIntervalMinutes(minutes);
  if (clamped % 1440 === 0) {
    const days = clamped / 1440;
    return days === 1 ? "Daily" : `Every ${days} days`;
  }
  if (clamped % 60 === 0) {
    const hours = clamped / 60;
    return hours === 24 ? "Daily" : `Every ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `Every ${clamped} minutes`;
}

export function isScheduledBackupDue(
  lastBackupAt: number | null,
  intervalMinutes: number,
  now: number,
): boolean {
  if (!lastBackupAt) return true;
  return now - lastBackupAt >= clampBackupIntervalMinutes(intervalMinutes) * 60_000;
}

export function nextScheduledBackupAt(
  lastBackupAt: number | null,
  intervalMinutes: number,
): number | null {
  if (!lastBackupAt) return null;
  return lastBackupAt + clampBackupIntervalMinutes(intervalMinutes) * 60_000;
}

export interface BackupSchedulerState {
  mode: BackupMode;
  /** True when local changes exist that Drive doesn't have yet. */
  pendingChanges: boolean;
  lastBackupAt: number | null;
  /** Scheduled mode only: when the next backup becomes due (null = due now / never backed up). */
  nextDueAt: number | null;
}

export interface BackupSchedulerConfig {
  mode: BackupMode;
  intervalMinutes: number;
}

export interface BackupSchedulerDeps {
  db: NomaDatabase;
  ownerId: string | null;
  getConfig: () => BackupSchedulerConfig;
  onStateChange?: (state: BackupSchedulerState) => void;
}

/** Quiet period after the last edit before a sync-mode upload (batches typing bursts). */
export const SYNC_DEBOUNCE_MS = 15_000;
/** How often scheduled mode re-checks due-ness while the app stays open. */
export const SCHEDULE_TICK_MS = 5 * 60_000;

export function startBackupScheduler(deps: BackupSchedulerDeps): () => void {
  const { db, ownerId } = deps;
  let stopped = false;
  let running = false;
  let dirty = false;
  let pending = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastReported = "";

  const report = () => {
    if (!deps.onStateChange) return;
    const { mode, intervalMinutes } = deps.getConfig();
    const connection = getConnection(ownerId);
    const state: BackupSchedulerState = {
      mode,
      pendingChanges: pending,
      lastBackupAt: connection?.lastBackupAt ?? null,
      nextDueAt:
        mode === "scheduled"
          ? nextScheduledBackupAt(connection?.lastBackupAt ?? null, intervalMinutes)
          : null,
    };
    const key = JSON.stringify(state);
    if (key !== lastReported) {
      lastReported = key;
      deps.onStateChange(state);
    }
  };

  const attempt = async (): Promise<void> => {
    if (stopped || running) return;
    const { mode, intervalMinutes } = deps.getConfig();
    if (mode === "off") return;
    if (!getConnection(ownerId)) {
      pending = false;
      report();
      return;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      pending = dirty || pending;
      report();
      return;
    }
    running = true;
    try {
      if (!(await hasUnbackedChanges(db, ownerId))) {
        dirty = false;
        pending = false;
        return;
      }
      if (
        mode === "scheduled" &&
        !isScheduledBackupDue(getConnection(ownerId)?.lastBackupAt ?? null, intervalMinutes, Date.now())
      ) {
        pending = true;
        return;
      }
      await backupNow(db, ownerId);
      dirty = false;
      pending = false;
    } catch {
      // Uploads fail quietly by design: the changes stay pending and the
      // next trigger (edit, reconnect, foreground, tick) retries.
      pending = true;
    } finally {
      running = false;
      report();
    }
  };

  const markDirty = () => {
    if (stopped) return;
    dirty = true;
    pending = true;
    report();
    if (deps.getConfig().mode === "sync") {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void attempt(), SYNC_DEBOUNCE_MS);
    }
  };

  // Dirty tracking: every write to a backed-up table counts. Restore/import
  // writes count too — uploading the just-restored state back is correct.
  const tables = [db.notes, db.folders, db.tags, db.attachments, db.reminders];
  for (const table of tables) {
    table.hook("creating", markDirty);
    table.hook("updating", markDirty);
    table.hook("deleting", markDirty);
  }

  const onOnline = () => void attempt();
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      void attempt();
    } else if (deps.getConfig().mode === "sync" && dirty) {
      // Best-effort flush as the app goes to the background.
      if (debounceTimer) clearTimeout(debounceTimer);
      void attempt();
    }
  };
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibility);
  const tick = setInterval(() => void attempt(), SCHEDULE_TICK_MS);
  const startTimer = setTimeout(() => {
    report();
    void attempt();
  }, 2_000);
  report();

  return () => {
    stopped = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    clearTimeout(startTimer);
    clearInterval(tick);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibility);
    for (const table of tables) {
      table.hook.creating.unsubscribe(markDirty);
      table.hook.updating.unsubscribe(markDirty);
      table.hook.deleting.unsubscribe(markDirty);
    }
  };
}

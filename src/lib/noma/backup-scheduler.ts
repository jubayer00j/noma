import { getConnection, hasUnbackedChanges } from "./drive";
import { syncNow, type SyncReason } from "./sync";
import type { NomaDatabase } from "./db";
import type { BackupMode } from "./types";

/**
 * The app-level sync & backup engine.
 *
 * This replaces the old Settings-card timer, which only ran while the
 * Settings screen was open — the reason "auto backup" appeared to do
 * nothing. The engine is mounted once in the app shell and lives for the
 * whole session, driving `syncNow` (see sync.ts) — every run is a
 * pull-merge-push cycle over the canonical Drive snapshot:
 *
 * - "sync" mode: any write to the backed-up tables marks the library
 *   dirty; after a short quiet period a full cycle runs, so changes from
 *   other devices are merged in before ours go up. Offline changes stay
 *   pending and flush on reconnect / foreground. Start, foreground,
 *   reconnect and a slow tick also run cycles — the remote check inside
 *   a cycle is a single metadata read, so an idle app stays quiet.
 * - "scheduled" mode (WhatsApp-style): when the chosen interval has
 *   elapsed since the last successful backup — checked at start, on
 *   foreground, on reconnect, and on a slow tick — a full cycle runs
 *   instead of a bare upload. Overdue cycles therefore land at the next
 *   app open, and other devices' changes arrive with them.
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
  /**
   * Android scheduled mode only: build + stage the backup ZIP natively so
   * the background worker can upload it while the app is closed. Called
   * when changes settle, as the app backgrounds, and once at start. The
   * implementation skips work when the staged copy is already current.
   */
  stageSnapshot?: () => Promise<void>;
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
  let stageTimer: ReturnType<typeof setTimeout> | null = null;
  let lastReported = "";

  const stage = () => {
    if (!deps.stageSnapshot || deps.getConfig().mode !== "scheduled") return;
    void (async () => {
      // Pull-merge first (when online and connected) so the staged
      // snapshot is never staler than the last known remote state. The
      // cycle is pull-only here — the push is the worker's job, on
      // schedule. Staging proceeds with local state even if this fails.
      try {
        if (getConnection(ownerId) && (typeof navigator === "undefined" || navigator.onLine)) {
          await syncNow(db, ownerId, "stage", { pullOnly: true });
        }
      } catch {
        /* staging proceeds with local state */
      }
      await deps.stageSnapshot?.();
    })();
  };

  const scheduleStage = () => {
    if (!deps.stageSnapshot || deps.getConfig().mode !== "scheduled") return;
    if (stageTimer) clearTimeout(stageTimer);
    stageTimer = setTimeout(stage, SYNC_DEBOUNCE_MS);
  };

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

  const attempt = async (reason: SyncReason = "tick"): Promise<void> => {
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
      if (mode === "scheduled") {
        const due = isScheduledBackupDue(
          getConnection(ownerId)?.lastBackupAt ?? null,
          intervalMinutes,
          Date.now(),
        );
        if (!due) {
          // Between backups the scheduler only tracks whether uploads
          // are waiting; the pull half of the cycle runs with the backup.
          pending = await hasUnbackedChanges(db, ownerId);
          return;
        }
        const result = await syncNow(db, ownerId, reason);
        dirty = false;
        pending = result.status === "failed";
        return;
      }
      // Sync mode: a full pull-merge-push cycle. Merge-applied writes
      // re-fire the dirty hooks, but the cycle's single-flight guard and
      // signature comparison keep that from looping into another upload.
      const result = await syncNow(db, ownerId, reason);
      if (result.status === "synced") {
        dirty = false;
        pending = false;
      } else if (result.status === "failed") {
        // Failures stay pending and the next trigger retries.
        pending = true;
      } else {
        pending = dirty;
      }
    } catch {
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
      debounceTimer = setTimeout(() => void attempt("edit"), SYNC_DEBOUNCE_MS);
    }
    scheduleStage();
  };

  // Dirty tracking: every write to a backed-up table counts. Restore/import
  // and merge-applied writes count too — the cycle decides by signature
  // whether anything actually needs to move.
  const tables = [db.notes, db.folders, db.tags, db.attachments, db.reminders, db.tombstones];
  for (const table of tables) {
    table.hook("creating", markDirty);
    table.hook("updating", markDirty);
    table.hook("deleting", markDirty);
  }

  const onOnline = () => void attempt("reconnect");
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      void attempt("foreground");
    } else {
      if (deps.getConfig().mode === "sync" && dirty) {
        // Best-effort flush as the app goes to the background.
        if (debounceTimer) clearTimeout(debounceTimer);
        void attempt("edit");
      }
      if (dirty) {
        // Keep the staged snapshot fresh for the background worker — this
        // is the last reliable moment before the app may be killed.
        if (stageTimer) clearTimeout(stageTimer);
        stage();
      }
    }
  };
  const onSyncCompleted = () => report();
  window.addEventListener("online", onOnline);
  window.addEventListener("noma:sync-completed", onSyncCompleted);
  document.addEventListener("visibilitychange", onVisibility);
  const tick = setInterval(() => void attempt("tick"), SCHEDULE_TICK_MS);
  const startTimer = setTimeout(() => {
    report();
    void attempt("start");
    stage();
  }, 2_000);
  report();

  return () => {
    stopped = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (stageTimer) clearTimeout(stageTimer);
    clearTimeout(startTimer);
    clearInterval(tick);
    window.removeEventListener("online", onOnline);
    window.removeEventListener("noma:sync-completed", onSyncCompleted);
    document.removeEventListener("visibilitychange", onVisibility);
    for (const table of tables) {
      table.hook.creating.unsubscribe(markDirty);
      table.hook.updating.unsubscribe(markDirty);
      table.hook.deleting.unsubscribe(markDirty);
    }
  };
}

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { BackupSchedulerState } from "./backup-scheduler";
import type { BackupMode } from "./types";

/**
 * Android bridge for the scheduled-backup safety net. The web scheduler
 * does the actual backing up whenever Noma runs; the native side only
 * registers the user's schedule with WorkManager so that, if a backup is
 * overdue while the app is closed, Android can surface a gentle reminder
 * to open Noma and let it finish. All calls are no-ops off Android.
 */
interface NomaBackgroundBackupPlugin {
  setSchedule(options: { intervalMinutes: number }): Promise<void>;
  cancelSchedule(): Promise<void>;
  reportState(options: {
    pendingChanges: boolean;
    lastBackupAt: number;
    nextDueAt: number;
  }): Promise<void>;
}

const NativeBackgroundBackup = registerPlugin<NomaBackgroundBackupPlugin>("NomaBackgroundBackup");

function isAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

export async function syncNativeBackupSchedule(
  mode: BackupMode,
  intervalMinutes: number,
): Promise<void> {
  if (!isAndroid()) return;
  try {
    if (mode === "scheduled") await NativeBackgroundBackup.setSchedule({ intervalMinutes });
    else await NativeBackgroundBackup.cancelSchedule();
  } catch {
    /* native scheduling is a safety net — the in-app engine still runs */
  }
}

export async function reportNativeBackupState(state: BackupSchedulerState): Promise<void> {
  if (!isAndroid()) return;
  try {
    await NativeBackgroundBackup.reportState({
      pendingChanges: state.pendingChanges,
      lastBackupAt: state.lastBackupAt ?? 0,
      nextDueAt: state.nextDueAt ?? 0,
    });
  } catch {
    /* see above */
  }
}

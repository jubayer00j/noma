import { useEffect, useRef } from "react";
import { useSettings } from "@/hooks/use-noma";
import { useAuth } from "@/lib/noma/auth";
import {
  reconcileNativeBackupStatus,
  reportNativeBackupState,
  stageCurrentSnapshot,
  syncNativeBackupSchedule,
} from "@/lib/noma/background-backup";
import { startBackupScheduler } from "@/lib/noma/backup-scheduler";
import { useDatabase } from "@/lib/noma/DatabaseContext";

/**
 * Mounts the app-level backup scheduler for the whole session (see
 * backup-scheduler.ts for why this must not live in the Settings card)
 * and keeps the Android WorkManager schedule in step with the settings.
 * Rendered inside the app gate so backups also run behind the lock screen.
 */
export function BackupSchedulerMount() {
  const { db } = useDatabase();
  const auth = useAuth();
  const { settings, ready } = useSettings();
  const ownerId = auth.user?.uid ?? null;
  const configRef = useRef({
    mode: settings.backupMode,
    intervalMinutes: settings.backupIntervalMinutes,
  });
  configRef.current = {
    mode: settings.backupMode,
    intervalMinutes: settings.backupIntervalMinutes,
  };

  useEffect(() => {
    if (!db || !ready) return;
    // Adopt any backup the Android worker uploaded while the app was away
    // before the engine starts judging what is still unbacked.
    void reconcileNativeBackupStatus(db, ownerId);
    return startBackupScheduler({
      db,
      ownerId,
      getConfig: () => configRef.current,
      onStateChange: (state) => void reportNativeBackupState(state, ownerId),
      stageSnapshot: () => stageCurrentSnapshot(db, ownerId),
    });
  }, [db, ownerId, ready]);

  useEffect(() => {
    if (!ready) return;
    void syncNativeBackupSchedule(settings.backupMode, settings.backupIntervalMinutes);
  }, [ready, settings.backupMode, settings.backupIntervalMinutes]);

  return null;
}

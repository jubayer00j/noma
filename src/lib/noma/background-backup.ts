import { Capacitor, registerPlugin } from "@capacitor/core";
import { buildBackupZip } from "./backup";
import type { NomaDatabase } from "./db";
import { getConnection, librarySignature, reconcileNativeBackup } from "./drive";
import type { BackupSchedulerState } from "./backup-scheduler";
import type { BackupMode } from "./types";

/**
 * Android bridge for staged background backups.
 *
 * The web layer owns the data, so it builds each scheduled backup ZIP and
 * stages it into the app's private storage via this plugin, together with
 * the library signature it represents and the Drive folder/file IDs. The
 * native WorkManager job (BackupDueWorker) then uploads that file silently
 * at the scheduled time — no WebView or IndexedDB access needed natively.
 * After a silent upload, `reconcileNativeBackupStatus` folds the result
 * back into the web connection record so the UI stays truthful.
 *
 * Everything here is a no-op off Android.
 */
interface NomaBackgroundBackupPlugin {
  setSchedule(options: { intervalMinutes: number }): Promise<void>;
  cancelSchedule(): Promise<void>;
  reportState(options: {
    pendingChanges: boolean;
    lastBackupAt: number;
    nextDueAt: number;
    folderId?: string | null;
    backupFileId?: string | null;
  }): Promise<void>;
  beginStage(options: {
    signature: string;
    folderId?: string | null;
    backupFileId?: string | null;
  }): Promise<{ sessionId: string }>;
  appendStageChunk(options: { sessionId: string; chunkBase64: string }): Promise<void>;
  finishStage(options: { sessionId: string }): Promise<{ staged: boolean; size: number }>;
  cancelStage(options: { sessionId: string }): Promise<void>;
  getStatus(): Promise<{
    lastBackupAt: number;
    lastUploadedSignature: string;
    stagedSignature: string;
    stagedAt: number;
  }>;
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

export async function reportNativeBackupState(
  state: BackupSchedulerState,
  ownerId: string | null,
): Promise<void> {
  if (!isAndroid()) return;
  try {
    // The Drive folder/file IDs the worker needs ride along with each
    // report, read fresh from the connection record.
    const connection = getConnection(ownerId);
    await NativeBackgroundBackup.reportState({
      pendingChanges: state.pendingChanges,
      lastBackupAt: state.lastBackupAt ?? 0,
      nextDueAt: state.nextDueAt ?? 0,
      folderId: connection?.folderId ?? null,
      backupFileId: connection?.backupFileId ?? null,
    });
  } catch {
    /* see above */
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(binary);
}

let stagingInFlight: Promise<void> | null = null;

/**
 * Builds the current backup ZIP and stages it natively for the background
 * worker. Skips the work when the staged copy already represents exactly
 * this library state. Concurrent calls share one run.
 */
export function stageCurrentSnapshot(db: NomaDatabase, ownerId: string | null): Promise<void> {
  if (!isAndroid()) return Promise.resolve();
  if (stagingInFlight) return stagingInFlight;
  stagingInFlight = (async () => {
    try {
      const connection = getConnection(ownerId);
      if (!connection) return;
      const signature = await librarySignature(db);
      const status = await NativeBackgroundBackup.getStatus().catch(() => null);
      if (status && status.stagedSignature === signature) return;

      const { blob } = await buildBackupZip(db, ownerId);
      const { sessionId } = await NativeBackgroundBackup.beginStage({
        signature,
        folderId: connection.folderId,
        backupFileId: connection.backupFileId,
      });
      try {
        const CHUNK = 512 * 1024;
        for (let offset = 0; offset < blob.size; offset += CHUNK) {
          const buffer = await blob.slice(offset, offset + CHUNK).arrayBuffer();
          await NativeBackgroundBackup.appendStageChunk({
            sessionId,
            chunkBase64: arrayBufferToBase64(buffer),
          });
        }
        await NativeBackgroundBackup.finishStage({ sessionId });
      } catch (error) {
        await NativeBackgroundBackup.cancelStage({ sessionId }).catch(() => undefined);
        throw error;
      }
    } catch {
      /* staging is best-effort — the in-app engine remains the fallback */
    } finally {
      stagingInFlight = null;
    }
  })();
  return stagingInFlight;
}

/** Folds a silent native upload back into the web connection record. */
export async function reconcileNativeBackupStatus(
  db: NomaDatabase,
  ownerId: string | null,
): Promise<void> {
  if (!isAndroid()) return;
  try {
    const status = await NativeBackgroundBackup.getStatus();
    if (!status.lastUploadedSignature) return;
    await reconcileNativeBackup(db, ownerId, {
      lastBackupAt: status.lastBackupAt,
      signature: status.lastUploadedSignature,
    });
  } catch {
    /* best-effort */
  }
}

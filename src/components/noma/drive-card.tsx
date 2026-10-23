import { Capacitor } from "@capacitor/core";
import {
  AlertTriangle,
  Check,
  CloudUpload,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { applyBackup, type BackupPayload, recordBackup } from "@/lib/noma/backup";
import { resetNativeBackupState } from "@/lib/noma/background-backup";
import {
  BACKUP_INTERVAL_PRESETS,
  clampBackupIntervalMinutes,
  nextScheduledBackupAt,
} from "@/lib/noma/backup-scheduler";
import { useAuth } from "@/lib/noma/auth";
import { useDatabase } from "@/lib/noma/DatabaseContext";
import { getSyncState, syncNow } from "@/lib/noma/sync";
import {
  backupNow,
  CANONICAL_BACKUP_NAME,
  connectDrive,
  disconnectDrive,
  fetchDriveBackup,
  getConnection,
  librarySignature,
  listDriveBackups,
  type DriveBackupFile,
  type DriveConnection,
  isDriveConfigured,
} from "@/lib/noma/drive";
import type { BackupMode } from "@/lib/noma/types";

type Status =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "success"; label: string; detail?: string }
  | { kind: "failed"; label: string };

function relative(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(timestamp).toLocaleString();
}

function formatSize(bytes: number | null): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function nextDueLabel(lastBackupAt: number | null, intervalMinutes: number): string {
  if (!lastBackupAt) return "First backup due now";
  const next = nextScheduledBackupAt(lastBackupAt, intervalMinutes);
  if (!next || next <= Date.now()) return "Backup due now";
  const minutes = Math.round((next - Date.now()) / 60_000);
  if (minutes < 60) return `Next backup in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Next backup in ${hours} hour${hours === 1 ? "" : "s"}`;
  return `Next backup ${new Date(next).toLocaleDateString()}`;
}

const MODE_OPTIONS: Array<{ value: BackupMode; title: string; description: string }> = [
  {
    value: "off",
    title: "Off",
    description: "Backups only happen when you tap Backup now.",
  },
  {
    value: "sync",
    title: "Sync",
    description: "Keep this device and your other devices up to date through Drive.",
  },
  {
    value: "scheduled",
    title: "Scheduled",
    description:
      "Backs up on a timer you choose — and pulls changes from your other devices when each backup runs.",
  },
];

const fade = "animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none";
const tap =
  "transition-transform active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100";

export function DriveCard({
  backupMode,
  backupIntervalMinutes,
  onBackupModeChange,
  onBackupIntervalChange,
  onRestored,
}: {
  backupMode: BackupMode;
  backupIntervalMinutes: number;
  onBackupModeChange: (mode: BackupMode) => void;
  onBackupIntervalChange: (minutes: number) => void;
  onRestored?: () => void;
}) {
  const auth = useAuth();
  const { db } = useDatabase();
  const [connection, setConnection] = useState<DriveConnection | null>(() =>
    typeof window === "undefined" ? null : getConnection(auth.user?.uid ?? null),
  );

  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [needsReconnect, setNeedsReconnect] = useState(false);

  useEffect(() => {
    setConnection(getConnection(auth.user?.uid ?? null));
  }, [auth.user?.uid]);

  const [justConnected, setJustConnected] = useState(false);
  const [syncInfo, setSyncInfo] = useState<{ lastSyncAt: number | null; failed: boolean }>({
    lastSyncAt: null,
    failed: false,
  });
  const [syncing, setSyncing] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreFiles, setRestoreFiles] = useState<DriveBackupFile[] | null>(null);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [preview, setPreview] = useState<{ file: DriveBackupFile; payload: BackupPayload } | null>(
    null,
  );
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [customOpen, setCustomOpen] = useState(
    () => !BACKUP_INTERVAL_PRESETS.some((preset) => preset.minutes === backupIntervalMinutes),
  );
  const [customValue, setCustomValue] = useState(() =>
    backupIntervalMinutes % 1440 === 0
      ? String(backupIntervalMinutes / 1440)
      : String(Math.max(1, Math.round(backupIntervalMinutes / 60))),
  );
  const [customUnit, setCustomUnit] = useState<"hours" | "days">(() =>
    backupIntervalMinutes % 1440 === 0 ? "days" : "hours",
  );

  // Whoever ran a backup (this card, the scheduler), show its result here.
  useEffect(() => {
    const refresh = () => setConnection(getConnection(auth.user?.uid ?? null));
    window.addEventListener("noma:backup-completed", refresh);
    return () => window.removeEventListener("noma:backup-completed", refresh);
  }, [auth.user?.uid]);

  const refreshSyncInfo = useCallback(
    async (failed?: boolean) => {
      if (!db) return;
      const state = await getSyncState(db);
      setSyncInfo((prev) => ({
        lastSyncAt: state.lastSyncAt,
        failed: failed ?? prev.failed,
      }));
    },
    [db],
  );

  useEffect(() => {
    void refreshSyncInfo();
  }, [refreshSyncInfo, connection]);

  useEffect(() => {
    const onSyncCompleted = (event: Event) => {
      const detail = (event as CustomEvent<{ status?: string }>).detail;
      void refreshSyncInfo(detail?.status === "failed");
    };
    window.addEventListener("noma:sync-completed", onSyncCompleted);
    return () => window.removeEventListener("noma:sync-completed", onSyncCompleted);
  }, [refreshSyncInfo]);

  const runSync = useCallback(async () => {
    if (!db) return;
    setSyncing(true);
    try {
      const result = await syncNow(db, auth.user?.uid ?? null, "manual");
      if (result.status === "failed") {
        toast.error(result.reason ?? "Sync failed — will retry.");
      } else if (result.status === "skipped") {
        toast.message(result.reason ?? "Sync skipped.");
      } else {
        const counts = result.counts;
        const parts: string[] = [];
        if (counts) {
          if (counts.added) parts.push(`${counts.added} added`);
          if (counts.updated) parts.push(`${counts.updated} updated`);
          if (counts.deleted) parts.push(`${counts.deleted} deleted`);
          if (counts.conflicts) {
            parts.push(
              `${counts.conflicts} conflict ${counts.conflicts === 1 ? "copy" : "copies"} saved`,
            );
          }
        }
        toast.success(
          parts.length ? `Sync complete — ${parts.join(", ")}` : "Everything is in sync",
        );
      }
      await refreshSyncInfo(result.status === "failed");
    } finally {
      setSyncing(false);
    }
  }, [db, auth.user?.uid, refreshSyncInfo]);

  const handleFailure = useCallback((error: unknown, label: string) => {
    const message = error instanceof Error ? error.message : label;
    if (error && typeof error === "object" && "needsReconnect" in error && error.needsReconnect) {
      setNeedsReconnect(true);
    }
    setStatus({ kind: "failed", label: message });
  }, []);

  const runBackup = useCallback(
    async (silent = false) => {
      if (!db) return;
      setStatus({ kind: "working", label: silent ? "Backing up…" : "Preparing backup…" });
      try {
        const { connection: next, manifest } = await backupNow(db!, auth.user?.uid ?? null);
        setConnection(next);
        setNeedsReconnect(false);
        setStatus({
          kind: "success",
          label: "Backup completed",
          detail: `${manifest.noteCount} note${manifest.noteCount === 1 ? "" : "s"} backed up just now.`,
        });
      } catch (error) {
        handleFailure(error, "Backup couldn't be completed.");
      }
    },
    [handleFailure, db, auth.user?.uid],
  );

  async function handleConnect() {
    setConnecting(true);
    setConnectError(null);
    setStatus({ kind: "idle" });
    try {
      setConnection(await connectDrive(auth.user?.uid ?? null));
      setNeedsReconnect(false);
      setJustConnected(true);
      setTimeout(() => setJustConnected(false), 2500);
      toast.success("Google Drive connected ✓");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Google Drive authorization wasn't completed.";
      setConnectError(message);
      toast.error(message);
    } finally {
      setConnecting(false);
    }
  }

  async function openRestore() {
    setRestoreOpen(true);
    setPreview(null);
    setRestoreFiles(null);
    setRestoreLoading(true);
    try {
      setRestoreFiles(await listDriveBackups(auth.user?.uid ?? null));
    } catch (error) {
      setRestoreOpen(false);
      handleFailure(error, "Couldn't list your Drive backups.");
    } finally {
      setRestoreLoading(false);
    }
  }

  async function loadPreview(file: DriveBackupFile) {
    setRestoreLoading(true);
    try {
      const payload = await fetchDriveBackup(file.id, auth.user?.uid ?? null);
      setPreview({ file, payload });
    } catch (error) {
      handleFailure(error, "That backup couldn't be read.");
      toast.error(error instanceof Error ? error.message : "That backup couldn't be read.");
    } finally {
      setRestoreLoading(false);
    }
  }

  async function runRestore(mode: "merge" | "replace") {
    if (!preview) return;
    setRestoring(true);
    try {
      await applyBackup(db!, preview.payload, mode);
      setRestoreOpen(false);
      setPreview(null);
      setConfirmReplace(false);
      toast.success(
        mode === "merge" ? "Backup merged into your library" : "Library replaced from backup",
      );
      onRestored?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Restore failed");
    } finally {
      setRestoring(false);
    }
  }

  if (!isDriveConfigured) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="font-serif text-base font-medium">Google Drive — Sync & Backup</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Optional. Add <code className="text-xs">googleDriveClientId</code> (a Google Cloud OAuth
          2.0 <em>Web</em> client ID) in{" "}
          <code className="text-xs">src/config/firebaseConfig.ts</code> to enable Drive sync and
          backups. It is separate from Firebase Google Sign-In.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-serif text-base font-medium">Google Drive — Sync & Backup</h3>
          {connection ? (
            <p className={`mt-1 flex items-center gap-1.5 text-sm ${justConnected ? fade : ""}`}>
              <Check className="size-4 text-emerald-600" aria-hidden="true" />
              <span className="font-medium">Connected</span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">Not connected</p>
          )}
        </div>
        <ShieldCheck className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </div>

      <p className="mt-3 text-sm text-muted-foreground">
        {connection
          ? "Your notes sync and back up to your own Google Drive, in a folder called “Noma Backups”."
          : "Keep your notes in sync across your devices and backed up in your own Google Drive. Noma asks only for permission to manage the files it creates — never your whole Drive."}
      </p>

      {connection?.email && (
        <p className="mt-2 text-sm text-muted-foreground">
          Account: <span className="text-foreground">{connection.email}</span>
        </p>
      )}

      {connection && (
        <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">
          {status.kind === "working" ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> {status.label}
            </span>
          ) : status.kind === "failed" ? (
            <span className="inline-flex items-center gap-1.5 text-destructive">
              <AlertTriangle className="size-3.5" aria-hidden="true" /> {status.label}
            </span>
          ) : status.kind === "success" ? (
            <span className={`inline-flex items-center gap-1.5 text-emerald-600 ${fade}`}>
              <Check className="size-3.5" aria-hidden="true" /> {status.label}
              {status.detail ? ` — ${status.detail}` : ""}
            </span>
          ) : connection.lastBackupAt ? (
            `Last backup: ${relative(connection.lastBackupAt)}`
          ) : (
            "No backup yet"
          )}
        </p>
      )}

      {connection && backupMode !== "off" && (
        <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">
          {syncing ? (
            "Syncing…"
          ) : syncInfo.failed ? (
            <span className="text-destructive">Sync failed — will retry</span>
          ) : syncInfo.lastSyncAt ? (
            `Synced · ${relative(syncInfo.lastSyncAt)}`
          ) : (
            "Not synced yet"
          )}
        </p>
      )}

      {connection && backupMode !== "off" && syncInfo.lastSyncAt === null && !syncInfo.failed && (
        <p className="mt-2 text-xs text-muted-foreground">
          On the first sync, notes from this device and your other devices are combined — nothing is
          deleted except items you deleted forever on a device. If a device stays offline for more
          than 90 days, something deleted forever elsewhere can reappear from it.
        </p>
      )}

      {needsReconnect && (
        <p className={`mt-3 rounded-lg border border-border bg-muted/40 p-3 text-sm ${fade}`}>
          Google Drive needs to be connected again.
        </p>
      )}

      {connecting && !connection && (
        <p className={`mt-3 text-sm text-muted-foreground ${fade}`}>Connecting to Google Drive…</p>
      )}

      {connectError && !connecting && (
        <p
          className={`mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive ${fade}`}
          role="alert"
        >
          {connectError}
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {!connection || needsReconnect ? (
          <Button
            className={`h-11 gap-2 ${tap}`}
            disabled={connecting}
            onClick={() => void handleConnect()}
          >
            {connecting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <CloudUpload className="size-4" aria-hidden="true" />
            )}
            {connecting
              ? "Connecting…"
              : connectError
                ? "Try again"
                : needsReconnect
                  ? "Reconnect Google Drive"
                  : "Connect Google Drive"}
          </Button>
        ) : null}

        {connection && !needsReconnect && (
          <>
            <Button
              className={`h-11 gap-2 ${tap}`}
              disabled={status.kind === "working"}
              onClick={() => void runBackup()}
            >
              <CloudUpload className="size-4" aria-hidden="true" /> Backup now
            </Button>
            {backupMode !== "off" && (
              <Button
                variant="outline"
                className={`h-11 gap-2 ${tap}`}
                disabled={syncing || status.kind === "working"}
                onClick={() => void runSync()}
              >
                {syncing ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="size-4" aria-hidden="true" />
                )}{" "}
                Sync now
              </Button>
            )}
            <Button
              variant="outline"
              className={`h-11 gap-2 ${tap}`}
              onClick={() => void openRestore()}
            >
              <HardDriveDownload className="size-4" aria-hidden="true" /> Restore backup
            </Button>
          </>
        )}

        {status.kind === "failed" && connection && !needsReconnect && (
          <Button
            variant="outline"
            className={`h-11 gap-2 ${tap}`}
            onClick={() => void runBackup()}
          >
            <RefreshCw className="size-4" aria-hidden="true" /> Try again
          </Button>
        )}

        {connection && (
          <Button variant="ghost" className="h-11" onClick={() => setConfirmDisconnect(true)}>
            Disconnect
          </Button>
        )}
      </div>

      {connection && !needsReconnect && (
        <div className={`mt-5 border-t border-border pt-4 ${fade}`}>
          <div className="flex items-baseline justify-between gap-4">
            <Label>Automatic backup</Label>
            {backupMode === "scheduled" && (
              <span className="text-xs text-muted-foreground">
                {nextDueLabel(connection.lastBackupAt, backupIntervalMinutes)}
              </span>
            )}
          </div>

          <div className="mt-3 grid gap-2" role="radiogroup" aria-label="Automatic backup mode">
            {MODE_OPTIONS.map((option) => {
              const active = backupMode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onBackupModeChange(option.value)}
                  className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors ${tap} ${
                    active ? "border-primary/50 bg-primary/5" : "border-border hover:bg-accent/50"
                  }`}
                >
                  <span
                    className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border ${
                      active ? "border-primary" : "border-muted-foreground/40"
                    }`}
                    aria-hidden="true"
                  >
                    {active && <span className="size-2 rounded-full bg-primary" />}
                  </span>
                  <span>
                    <span className="block text-sm font-medium">{option.title}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {backupMode === "scheduled" && (
            <div className="animate-in fade-in duration-200 motion-reduce:animate-none">
              <div className="mt-3 flex flex-wrap gap-1.5">
                {BACKUP_INTERVAL_PRESETS.map((preset) => {
                  const active = !customOpen && backupIntervalMinutes === preset.minutes;
                  return (
                    <button
                      key={preset.minutes}
                      type="button"
                      onClick={() => {
                        setCustomOpen(false);
                        onBackupIntervalChange(preset.minutes);
                      }}
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${tap} ${
                        active
                          ? "border-primary/50 bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-accent/50"
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => {
                    setCustomUnit(backupIntervalMinutes % 1440 === 0 ? "days" : "hours");
                    setCustomValue(
                      backupIntervalMinutes % 1440 === 0
                        ? String(backupIntervalMinutes / 1440)
                        : String(Math.max(1, Math.round(backupIntervalMinutes / 60))),
                    );
                    setCustomOpen(true);
                  }}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${tap} ${
                    customOpen
                      ? "border-primary/50 bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent/50"
                  }`}
                >
                  Custom
                </button>
              </div>

              {customOpen && (
                <div className="mt-3 animate-in fade-in duration-200 motion-reduce:animate-none">
                  <div className="flex items-end gap-2">
                    <div className="w-24">
                      <Label htmlFor="noma-custom-backup-value" className="text-xs">
                        Every
                      </Label>
                      <Input
                        id="noma-custom-backup-value"
                        type="number"
                        min={1}
                        max={720}
                        value={customValue}
                        onChange={(event) => setCustomValue(event.target.value)}
                        className="mt-1 h-9"
                      />
                    </div>
                    <select
                      aria-label="Custom backup interval unit"
                      value={customUnit}
                      onChange={(event) => setCustomUnit(event.target.value as "hours" | "days")}
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                    >
                      <option value="hours">hours</option>
                      <option value="days">days</option>
                    </select>
                    <Button
                      type="button"
                      size="sm"
                      className="h-9"
                      onClick={() => {
                        const parsed = Number.parseInt(customValue, 10);
                        if (!Number.isFinite(parsed) || parsed < 1) return;
                        onBackupIntervalChange(
                          clampBackupIntervalMinutes(parsed * (customUnit === "days" ? 1440 : 60)),
                        );
                      }}
                    >
                      Set
                    </Button>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Between 1 hour and 30 days.
                  </p>
                </div>
              )}
            </div>
          )}

          {backupMode === "sync" && (
            <p className="mt-3 text-xs text-muted-foreground">
              Changes upload about 15 seconds after you stop editing, and changes from your other
              devices are pulled in when you open Noma or bring it to the front. Anything pending
              uploads as soon as you're back online — and only when something actually changed.
            </p>
          )}
          {backupMode === "scheduled" && (
            <p className="mt-3 text-xs text-muted-foreground">
              {Capacitor.isNativePlatform()
                ? "On Android, scheduled backups upload in the background at the scheduled time — even while Noma is closed. Noma stages each backup ahead of time so Android can send it without opening the app; if a run ever can't complete, you'll get a gentle reminder instead."
                : "Backups run while Noma is open; anything overdue runs as soon as you open it."}
            </p>
          )}
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Your notes are stored locally on this device. Google Drive is optional — when connected,
        Noma syncs and backs up your data to your own Google Drive, and Noma never stores it
        anywhere else.
      </p>

      {/* Restore flow */}
      <Dialog
        open={restoreOpen}
        onOpenChange={(open) => !open && (setRestoreOpen(false), setPreview(null))}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif">
              {preview ? "Restore preview" : "Restore from Google Drive"}
            </DialogTitle>
            <DialogDescription>
              {preview
                ? "Choose how this backup should meet your local notes."
                : "Only Noma backups from your “Noma Backups” folder are listed."}
            </DialogDescription>
          </DialogHeader>

          {restoreLoading && (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading…
            </p>
          )}

          {!restoreLoading &&
            !preview &&
            (() => {
              const files = restoreFiles ?? [];
              const canonicalFile = files.find((f) => f.name === CANONICAL_BACKUP_NAME);
              const legacyFiles = files.filter((f) => f.name !== CANONICAL_BACKUP_NAME);

              if (files.length === 0) {
                return (
                  <p className="py-4 text-sm text-muted-foreground">
                    No Noma backups found in your Drive yet.
                  </p>
                );
              }

              return (
                <div className="max-h-72 space-y-4 overflow-y-auto pr-1">
                  {canonicalFile && (
                    <div>
                      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Active Backup
                      </h4>
                      <button
                        type="button"
                        onClick={() => void loadPreview(canonicalFile)}
                        className={`w-full rounded-lg border border-primary/40 bg-accent/30 p-3.5 text-left transition-colors hover:bg-accent/60 ${tap}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-foreground">Noma Backup</span>
                          {formatSize(canonicalFile.size) && (
                            <span className="text-xs text-muted-foreground">
                              {formatSize(canonicalFile.size)}
                            </span>
                          )}
                        </div>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          Last updated {new Date(canonicalFile.modifiedTime).toLocaleString()}
                        </span>
                      </button>
                    </div>
                  )}

                  {legacyFiles.length > 0 && (
                    <div>
                      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Older Backups
                      </h4>
                      <ul className="space-y-2">
                        {legacyFiles.map((file) => (
                          <li key={file.id}>
                            <button
                              type="button"
                              onClick={() => void loadPreview(file)}
                              className={`w-full rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted/50 ${tap}`}
                            >
                              <span className="block text-sm font-medium">
                                {new Date(file.modifiedTime).toLocaleString()}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {file.name}
                                {formatSize(file.size) ? ` · ${formatSize(file.size)}` : ""}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              );
            })()}

          {!restoreLoading && preview && (
            <div className={`space-y-1 text-sm text-muted-foreground ${fade}`}>
              <p className="text-foreground">
                {new Date(preview.payload.manifest.createdAt).toLocaleString()}
              </p>
              <p>Notes: {preview.payload.manifest.noteCount}</p>
              <p>Folders: {preview.payload.manifest.folderCount}</p>
              <p>Tags: {preview.payload.manifest.tagCount}</p>
              <p>Attachments: {preview.payload.manifest.attachmentCount}</p>
              <p className="pt-2 text-xs">
                Backup format v{preview.payload.manifest.backupFormatVersion} · Noma{" "}
                {preview.payload.manifest.nomaVersion}
              </p>
            </div>
          )}

          {preview && (
            <DialogFooter className="gap-2 sm:justify-between">
              <Button variant="ghost" onClick={() => setPreview(null)}>
                Back
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={restoring}
                  onClick={() => void runRestore("merge")}
                >
                  {restoring && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{" "}
                  Merge
                </Button>
                <Button
                  variant="destructive"
                  disabled={restoring}
                  onClick={() => setConfirmReplace(true)}
                >
                  Replace
                </Button>
              </div>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmReplace} onOpenChange={setConfirmReplace}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif">Replace local notes?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything currently on this device will be replaced by this backup. This can't be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void runRestore("replace")}>
              Replace library
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif">Disconnect Google Drive?</AlertDialogTitle>
            <AlertDialogDescription>
              Your local Noma notes will remain on this device, and your existing Drive backups are
              kept. Disconnecting only stops Noma from accessing your Drive for backups.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                await disconnectDrive(auth.user?.uid ?? null);
                // The background worker must never upload to a disconnected
                // account: wipe its staged archive and deactivate it.
                await resetNativeBackupState();
                setConnection(null);
                setNeedsReconnect(false);
                setStatus({ kind: "idle" });
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

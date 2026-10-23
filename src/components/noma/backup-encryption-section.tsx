import { Loader2, Lock, LockOpen } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { BackupUnlockDialog } from "@/components/noma/backup-unlock-dialog";
import { PasswordInput } from "@/components/noma/password-input";
import {
  BackupUnlockError,
  clearBackupEncryptionRecord,
  createEncryptionRecord,
  getBackupEncryptionRecord,
  rewrapRecord,
  saveBackupEncryptionRecord,
  unlockWithPassphrase,
  type BackupEncryptionRecord,
} from "@/lib/noma/backup-crypto";
import { base64ToBytes, bytesToBase64 } from "@/lib/noma/note-lock-crypto";

const tap =
  "transition-transform active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100";

/** Announce a record change so other Settings surfaces can refresh. */
function emitEncryptionChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("noma:encryption-changed"));
  }
}

/**
 * Backup encryption controls (Settings, Drive area). Whole-archive
 * encryption: the backup ZIP is sealed with a passphrase-derived key
 * before it leaves the device, for Drive backups, sync and manual
 * exports alike. See backup-crypto.ts for the key hierarchy.
 */
export function BackupEncryptionSection({
  ownerId,
  onEncryptionEnabled,
}: {
  ownerId: string | null;
  /** Fired right after setup so the parent can seal the current Drive backup immediately. */
  onEncryptionEnabled?: () => void;
}) {
  const [record, setRecord] = useState<BackupEncryptionRecord | null>(() =>
    getBackupEncryptionRecord(ownerId),
  );
  const refresh = useCallback(() => {
    setRecord(getBackupEncryptionRecord(ownerId));
  }, [ownerId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    window.addEventListener("noma:encryption-changed", refresh);
    return () => window.removeEventListener("noma:encryption-changed", refresh);
  }, [refresh]);

  const [setupOpen, setSetupOpen] = useState(false);
  const [setupPassphrase, setSetupPassphrase] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [setupAck, setSetupAck] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const [changeOpen, setChangeOpen] = useState(false);
  const [changeCurrent, setChangeCurrent] = useState("");
  const [changeNext, setChangeNext] = useState("");
  const [changeConfirm, setChangeConfirm] = useState("");
  const [changeBusy, setChangeBusy] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);

  const [turnOffOpen, setTurnOffOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);

  const hasDeviceKey = !!record?.deviceKey;

  function resetSetup() {
    setSetupPassphrase("");
    setSetupConfirm("");
    setSetupAck(false);
    setSetupError(null);
    setSetupBusy(false);
  }

  function resetChange() {
    setChangeCurrent("");
    setChangeNext("");
    setChangeConfirm("");
    setChangeError(null);
    setChangeBusy(false);
  }

  async function submitSetup() {
    if (setupBusy) return;
    if (setupPassphrase.length < 8) {
      setSetupError("Use at least 8 characters — longer is stronger.");
      return;
    }
    if (setupPassphrase !== setupConfirm) {
      setSetupError("The passphrases don't match.");
      return;
    }
    if (!setupAck) {
      setSetupError("Please confirm you understand there's no recovery.");
      return;
    }
    setSetupBusy(true);
    setSetupError(null);
    try {
      const { record: created } = await createEncryptionRecord(setupPassphrase);
      saveBackupEncryptionRecord(ownerId, created);
      emitEncryptionChanged();
      refresh();
      setSetupOpen(false);
      resetSetup();
      toast.success("Backup encryption is on");
      onEncryptionEnabled?.();
    } catch {
      setSetupError("Encryption couldn't be set up. Try again.");
      setSetupBusy(false);
    }
  }

  async function submitChange() {
    if (!record || changeBusy) return;
    if (changeNext.length < 8) {
      setChangeError("Use at least 8 characters — longer is stronger.");
      return;
    }
    if (changeNext !== changeConfirm) {
      setChangeError("The new passphrases don't match.");
      return;
    }
    setChangeBusy(true);
    setChangeError(null);
    try {
      // With the device key held, no current passphrase is needed. Without
      // it, the current passphrase must unwrap the master key first — a
      // wrong one fails cleanly and nothing is stored.
      const keyBytes = hasDeviceKey
        ? base64ToBytes(record.deviceKey!)
        : await unlockWithPassphrase(record, changeCurrent);
      const header = await rewrapRecord(keyBytes, changeNext);
      saveBackupEncryptionRecord(ownerId, { ...header, deviceKey: bytesToBase64(keyBytes) });
      emitEncryptionChanged();
      refresh();
      setChangeOpen(false);
      resetChange();
      toast.success("Backup passphrase changed — older backups still open with it");
    } catch (error) {
      setChangeError(
        error instanceof BackupUnlockError
          ? "Incorrect passphrase"
          : "The passphrase couldn't be changed. Try again.",
      );
      setChangeBusy(false);
    }
  }

  function removeDeviceKey() {
    if (!record) return;
    saveBackupEncryptionRecord(ownerId, {
      salt: record.salt,
      iterations: record.iterations,
      wrappedKey: record.wrappedKey,
    });
    emitEncryptionChanged();
    refresh();
    toast.message(
      "Key removed from this device — automatic backups and sync pause until you unlock with your passphrase.",
    );
  }

  function turnOff() {
    clearBackupEncryptionRecord(ownerId);
    emitEncryptionChanged();
    refresh();
    setTurnOffOpen(false);
    toast.success("Backup encryption turned off");
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        {record ? (
          <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
        ) : (
          <LockOpen className="size-4 text-muted-foreground" aria-hidden="true" />
        )}
        <Label>Backup encryption</Label>
      </div>

      {!record && (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            Seal each backup archive with a passphrase only you know, so the copy in Google Drive is
            encrypted end-to-end — anyone who obtains the file sees only scrambled data. Manual
            exports are encrypted too.
          </p>
          <Button
            variant="outline"
            className={`mt-3 h-11 gap-2 ${tap}`}
            onClick={() => {
              resetSetup();
              setSetupOpen(true);
            }}
          >
            <Lock className="size-4" aria-hidden="true" /> Set up backup encryption
          </Button>
        </>
      )}

      {record && hasDeviceKey && (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            Backups are encrypted. This device holds the key, so automatic backups and sync run as
            usual.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              className={`h-11 ${tap}`}
              onClick={() => {
                resetChange();
                setChangeOpen(true);
              }}
            >
              Change passphrase
            </Button>
            <Button variant="outline" className={`h-11 ${tap}`} onClick={removeDeviceKey}>
              Remove key from this device
            </Button>
            <Button
              variant="ghost"
              className="h-11 text-destructive hover:text-destructive"
              onClick={() => setTurnOffOpen(true)}
            >
              Turn off encryption
            </Button>
          </div>
        </>
      )}

      {record && !hasDeviceKey && (
        <>
          <p className="mt-2 text-sm text-muted-foreground">
            Backups are encrypted. This device doesn't hold the key, so automatic backups and sync
            are paused until you unlock.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button className={`h-11 gap-2 ${tap}`} onClick={() => setUnlockOpen(true)}>
              <Lock className="size-4" aria-hidden="true" /> Unlock backups
            </Button>
            <Button
              variant="outline"
              className={`h-11 ${tap}`}
              onClick={() => {
                resetChange();
                setChangeOpen(true);
              }}
            >
              Change passphrase
            </Button>
            <Button
              variant="ghost"
              className="h-11 text-destructive hover:text-destructive"
              onClick={() => setTurnOffOpen(true)}
            >
              Turn off encryption
            </Button>
          </div>
        </>
      )}

      {record && (
        <p className="mt-3 text-xs text-muted-foreground">
          Backups are encrypted with your passphrase — it can't be recovered if forgotten.
        </p>
      )}

      {/* Setup */}
      <Dialog
        open={setupOpen}
        onOpenChange={(open) => {
          setSetupOpen(open);
          if (!open) resetSetup();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif">Set up backup encryption</DialogTitle>
            <DialogDescription>
              Choose a passphrase for your backups. You'll enter it once on each device.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitSetup();
            }}
          >
            <div>
              <Label htmlFor="noma-enc-setup-passphrase">Backup passphrase</Label>
              <PasswordInput
                id="noma-enc-setup-passphrase"
                className="mt-1.5"
                value={setupPassphrase}
                onChange={(event) => setSetupPassphrase(event.target.value)}
                autoComplete="new-password"
                autoFocus
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                At least 8 characters — longer is stronger. A phrase you can remember but others
                can't guess works well.
              </p>
            </div>
            <div className="mt-4">
              <Label htmlFor="noma-enc-setup-confirm">Confirm passphrase</Label>
              <PasswordInput
                id="noma-enc-setup-confirm"
                className="mt-1.5"
                value={setupConfirm}
                onChange={(event) => setSetupConfirm(event.target.value)}
                autoComplete="new-password"
              />
            </div>
            <p className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
              This device keeps the key so backups can run automatically. The copy in Google Drive
              is always encrypted. Anyone with full access to this unlocked device could extract
              the key.
            </p>
            <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm">
              <Checkbox
                checked={setupAck}
                onCheckedChange={(checked) => setSetupAck(checked === true)}
                className="mt-0.5"
              />
              <span>
                A forgotten passphrase means encrypted archives cannot be opened, by anyone,
                including for sync on a new device.
              </span>
            </label>
            {setupError && (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {setupError}
              </p>
            )}
            <DialogFooter className="mt-5 gap-2">
              <Button type="button" variant="ghost" onClick={() => setSetupOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  setupBusy ||
                  setupPassphrase.length < 8 ||
                  setupConfirm.length === 0 ||
                  !setupAck
                }
              >
                {setupBusy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />} Turn
                on encryption
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Change passphrase */}
      <Dialog
        open={changeOpen}
        onOpenChange={(open) => {
          setChangeOpen(open);
          if (!open) resetChange();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-serif">Change backup passphrase</DialogTitle>
            <DialogDescription>
              Older backups stay openable — the new passphrase protects the same master key.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitChange();
            }}
          >
            {!hasDeviceKey && (
              <div>
                <Label htmlFor="noma-enc-change-current">Current passphrase</Label>
                <PasswordInput
                  id="noma-enc-change-current"
                  className="mt-1.5"
                  value={changeCurrent}
                  onChange={(event) => setChangeCurrent(event.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </div>
            )}
            <div className={hasDeviceKey ? "" : "mt-4"}>
              <Label htmlFor="noma-enc-change-next">New passphrase</Label>
              <PasswordInput
                id="noma-enc-change-next"
                className="mt-1.5"
                value={changeNext}
                onChange={(event) => setChangeNext(event.target.value)}
                autoComplete="new-password"
                autoFocus={hasDeviceKey}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                At least 8 characters — longer is stronger.
              </p>
            </div>
            <div className="mt-4">
              <Label htmlFor="noma-enc-change-confirm">Confirm new passphrase</Label>
              <PasswordInput
                id="noma-enc-change-confirm"
                className="mt-1.5"
                value={changeConfirm}
                onChange={(event) => setChangeConfirm(event.target.value)}
                autoComplete="new-password"
              />
            </div>
            {changeError && (
              <p className="mt-3 text-sm text-destructive" role="alert">
                {changeError}
              </p>
            )}
            <DialogFooter className="mt-5 gap-2">
              <Button type="button" variant="ghost" onClick={() => setChangeOpen(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  changeBusy ||
                  changeNext.length < 8 ||
                  changeConfirm.length === 0 ||
                  (!hasDeviceKey && changeCurrent.length === 0)
                }
              >
                {changeBusy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{" "}
                Change passphrase
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Turn off */}
      <AlertDialog open={turnOffOpen} onOpenChange={setTurnOffOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif">Turn off backup encryption?</AlertDialogTitle>
            <AlertDialogDescription>
              The next backup from any device will be unencrypted, and encryption will switch off
              on your other devices when they next sync. Older encrypted copies may remain in
              Google Drive's version history or trash.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep encryption</AlertDialogCancel>
            <AlertDialogAction onClick={turnOff}>Turn off encryption</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <BackupUnlockDialog
        open={unlockOpen}
        onOpenChange={setUnlockOpen}
        ownerId={ownerId}
        onUnlocked={() => {
          emitEncryptionChanged();
          refresh();
          toast.success("Backups unlocked on this device");
        }}
      />
    </div>
  );
}

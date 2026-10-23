import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/noma/password-input";
import {
  BackupUnlockError,
  getBackupEncryptionRecord,
  saveBackupEncryptionRecord,
  unlockWithPassphrase,
  type BackupEncryptionHeader,
} from "@/lib/noma/backup-crypto";
import { getCanonicalEncryptionHeader } from "@/lib/noma/drive";
import { bytesToBase64 } from "@/lib/noma/note-lock-crypto";

/**
 * The one passphrase prompt for encrypted backups. Used by Settings
 * (Unlock backups), the sync-paused state, manual Backup now / Sync now
 * with no key on this device, and restore/import of an encrypted
 * archive. On success the unwrapped master key is stored as this
 * device's key copy and `onUnlocked` fires so the interrupted action
 * can continue.
 */
export function BackupUnlockDialog({
  open,
  onOpenChange,
  ownerId,
  title = "Unlock backups",
  description = "This backup is encrypted. Enter your backup passphrase to continue.",
  onUnlocked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ownerId: string | null;
  title?: string;
  description?: string;
  onUnlocked?: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const sourceRef = useRef<BackupEncryptionHeader | null>(null);

  useEffect(() => {
    if (!open) {
      setPassphrase("");
      setError(null);
      setBusy(false);
      return;
    }
    setUnavailable(false);
    // Wrap parameters come from the local record when there is one.
    // A device with no record yet (a second device joining an encrypted
    // fleet) reads them from the canonical archive's header instead.
    const record = getBackupEncryptionRecord(ownerId);
    if (record) {
      sourceRef.current = record;
      return;
    }
    sourceRef.current = null;
    setPreparing(true);
    getCanonicalEncryptionHeader(ownerId)
      .then((header) => {
        sourceRef.current = header;
        if (!header) setUnavailable(true);
      })
      .catch(() => setUnavailable(true))
      .finally(() => setPreparing(false));
  }, [open, ownerId]);

  async function submit() {
    const source = sourceRef.current;
    if (!source || busy) return;
    setBusy(true);
    setError(null);
    try {
      const keyBytes = await unlockWithPassphrase(source, passphrase);
      // Only reached with a verified key: store this device's copy
      // alongside the wrap parameters it was unwrapped from.
      saveBackupEncryptionRecord(ownerId, {
        salt: source.salt,
        iterations: source.iterations,
        wrappedKey: source.wrappedKey,
        deviceKey: bytesToBase64(keyBytes),
      });
      onOpenChange(false);
      onUnlocked?.();
    } catch (unlockError) {
      setError(
        unlockError instanceof BackupUnlockError
          ? "Incorrect passphrase"
          : "Backups couldn't be unlocked. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {preparing ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Looking for your
            encrypted backup…
          </p>
        ) : unavailable ? (
          <p className="py-4 text-sm text-muted-foreground">
            No encrypted backup was found to unlock against. Connect Google Drive first, or open
            the encrypted backup file again.
          </p>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div>
              <Label htmlFor="noma-backup-unlock-passphrase">Backup passphrase</Label>
              <PasswordInput
                id="noma-backup-unlock-passphrase"
                enterKeyHint="done"
                className="mt-1.5"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                autoComplete="current-password"
                autoFocus
              />
            </div>
            {error && (
              <p className="mt-2 text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <DialogFooter className="mt-5 gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || passphrase.length === 0}>
                {busy && <Loader2 className="size-4 animate-spin" aria-hidden="true" />} Unlock
              </Button>
            </DialogFooter>
          </form>
        )}

        <p className="text-xs text-muted-foreground">
          Backups are encrypted with your passphrase — it can't be recovered if forgotten.
        </p>
      </DialogContent>
    </Dialog>
  );
}

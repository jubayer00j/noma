import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CredentialPrompt } from "@/components/noma/credential-prompt";
import { useDatabase } from "@/lib/noma/DatabaseContext";
import { useAppLock } from "@/lib/noma/AppLockContext";
import {
  decryptNoteData,
  noteLockoutSeconds,
  unlockNoteWithBiometricCopy,
  verifyNoteCredential,
  type UnlockedNoteData,
} from "@/lib/noma/note-lock";
import { hasBiometricCopy } from "@/lib/noma/note-lock-crypto";
import { hapticUnlockFailure, hapticUnlockSuccess } from "@/lib/noma/haptics";
import { noteTitle } from "@/lib/noma/notes";
import type { Note, NoteLockMethod } from "@/lib/noma/types";

interface NoteLockGateProps {
  note: Note;
  onUnlocked: (nek: Uint8Array, data: UnlockedNoteData) => void;
}

/**
 * Shown in place of the read view / editor for a locked note. Verifies the
 * note's own credential (or fingerprint, gated by the native prompt), then
 * hands the decrypted session data to the workspace.
 */
export function NoteLockGate({ note, onUnlocked }: NoteLockGateProps) {
  const { db } = useDatabase();
  const { biometricAvailable, authenticateForSettingsChange } = useAppLock();
  const lock = note.lock;

  // Tick once a second while a lockout is running so the countdown is live.
  const [now, setNow] = useState(() => Date.now());
  const lockoutSeconds = lock ? noteLockoutSeconds(lock, now) : 0;
  useEffect(() => {
    if (lockoutSeconds <= 0) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [lockoutSeconds]);

  const biometricCopyPresent = useMemo(
    () => (lock?.biometric ? hasBiometricCopy(note.id) : false),
    [lock?.biometric, note.id],
  );

  if (!lock || !db) return null;

  // Unlock haptics (native-feel #4) fire here, once per attempt
  // outcome: success on either path, failure on a rejected credential
  // or an unusable biometric copy. A dismissed OS biometric prompt is
  // a cancel, not a wrong credential, and stays silent.
  const handleVerify = async (method: NoteLockMethod, secret: string | number[]) => {
    const result = await verifyNoteCredential(db, note, method, secret);
    if (!result.ok) {
      hapticUnlockFailure();
      return { success: false, error: result.error };
    }
    const data = await decryptNoteData(db, note, result.nek);
    hapticUnlockSuccess();
    onUnlocked(result.nek, data);
    return { success: true };
  };

  const handleBiometric = async (): Promise<boolean> => {
    const auth = await authenticateForSettingsChange();
    if (!auth.success) {
      if (!auth.cancelled && auth.error) toast.error(auth.error);
      return false;
    }
    const result = await unlockNoteWithBiometricCopy(db, note);
    if (!result.ok) {
      hapticUnlockFailure();
      toast.error(result.error);
      return false;
    }
    const data = await decryptNoteData(db, note, result.nek);
    hapticUnlockSuccess();
    onUnlocked(result.nek, data);
    return true;
  };

  return (
    <div className="noma-leaf-watermark flex flex-1 flex-col items-center justify-center px-4 py-10">
      <CredentialPrompt
        heading="Locked note"
        subheading={`“${noteTitle(note)}” is encrypted. Unlock it with its own credential.`}
        methods={{
          biometric: Boolean(lock.biometric && biometricCopyPresent),
          pattern: Boolean(lock.slots.pattern),
          pin: Boolean(lock.slots.pin),
          password: Boolean(lock.slots.password),
        }}
        biometricAvailable={biometricAvailable}
        lockoutSeconds={lockoutSeconds}
        onBiometric={handleBiometric}
        onVerify={handleVerify}
        autoBiometric
      />
      <p className="mt-8 max-w-sm text-center text-xs text-muted-foreground">
        The note re-locks when you leave it. If the credential is forgotten, this note cannot be
        recovered.
      </p>
    </div>
  );
}

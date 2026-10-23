import { useState } from "react";
import {
  ArrowLeft,
  Fingerprint,
  Grid,
  Hash,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/noma/password-input";
import { PatternLock } from "@/components/noma/pattern-lock";
import { PinPad, PIN_MIN_LENGTH } from "@/components/noma/pin-pad";
import { useDatabase } from "@/lib/noma/DatabaseContext";
import { useAppLock } from "@/lib/noma/AppLockContext";
import {
  lockNote,
  removeNoteLock,
  removeNoteLockSlot,
  setNoteLockBiometric,
  setNoteLockSlot,
} from "@/lib/noma/note-lock";
import { canonicalNoteSecret, hasBiometricCopy } from "@/lib/noma/note-lock-crypto";
import { noteTitle } from "@/lib/noma/notes";
import type { Note, NoteLockMethod } from "@/lib/noma/types";
import { cn } from "@/lib/utils";

const METHOD_META: Record<
  NoteLockMethod,
  { label: string; icon: typeof Grid; blurb: string }
> = {
  pattern: { label: "Pattern", icon: Grid, blurb: "Draw a shape on a 3×3 grid" },
  pin: { label: "PIN", icon: Hash, blurb: "A 4–6 digit numeric code" },
  password: { label: "Password", icon: KeyRound, blurb: "At least 8 characters — strongest option" },
};

const METHODS: NoteLockMethod[] = ["pattern", "pin", "password"];

/* ---------------- Credential setter (set + confirm) ---------------- */

function CredentialSetter({
  method,
  doneLabel,
  onDone,
}: {
  method: NoteLockMethod;
  doneLabel: string;
  onDone: (secret: string | number[]) => Promise<void>;
}) {
  const [phase, setPhase] = useState<"set" | "confirm">("set");
  const [first, setFirst] = useState<string | number[] | null>(null);
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const restart = (message: string) => {
    setError(message);
    setFirst(null);
    setPhase("set");
    setPin("");
    setPassword("");
  };

  const accept = async (secret: string | number[]) => {
    if (phase === "set") {
      setFirst(secret);
      setPhase("confirm");
      setPin("");
      setPassword("");
      setError(null);
      return;
    }
    if (first === null || canonicalNoteSecret(method, first) !== canonicalNoteSecret(method, secret)) {
      restart("Those don't match. Start over.");
      return;
    }
    setBusy(true);
    try {
      await onDone(first);
    } catch (err) {
      restart(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-center text-sm text-muted-foreground">
        {phase === "set"
          ? `Set your ${METHOD_META[method].label.toLowerCase()}`
          : `Draw it again to confirm`}
        {method !== "pattern" && phase === "confirm" ? " — enter it again to confirm" : ""}
      </p>

      {method === "pattern" && (
        <div className="flex justify-center">
          <PatternLock
            key={phase}
            size={240}
            disabled={busy}
            onComplete={(points) => {
              if (points.length === 0) return;
              if (points.length < 4) {
                setError("Pattern must connect at least 4 dots.");
                return;
              }
              void accept(points);
            }}
            onChange={() => setError(null)}
          />
        </div>
      )}

      {method === "pin" && (
        <PinPad
          value={pin}
          onChange={(next) => {
            setPin(next);
            setError(null);
          }}
          onSubmit={() => {
            if (pin.length >= PIN_MIN_LENGTH) void accept(pin);
          }}
          disabled={busy}
          error={Boolean(error)}
        />
      )}

      {method === "password" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password.length < 8) {
              setError("Password must be at least 8 characters.");
              return;
            }
            void accept(password);
          }}
          className="space-y-3"
        >
          <PasswordInput
            placeholder={phase === "set" ? "New password (8+ characters)" : "Repeat the password"}
            value={password}
            disabled={busy}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            autoComplete="new-password"
          />
          <Button type="submit" className="w-full" disabled={password.length < 8 || busy}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
            {phase === "set" ? "Continue" : doneLabel}
          </Button>
        </form>
      )}

      {method !== "password" && phase === "confirm" && (
        <p className="text-center text-xs text-muted-foreground">
          Confirm to finish — this step makes sure you can repeat it exactly.
        </p>
      )}
      {error && (
        <p className="text-center text-sm font-medium text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/* ---------------- Dialog ---------------- */

export interface NoteLockDialogProps {
  note: Note | null;
  mode: "setup" | "manage";
  /** Session key for the open note — required in manage mode. */
  nek?: Uint8Array | null;
  onClose: () => void;
  onLocked?: () => void;
  onLockRemoved?: () => void;
}

export function NoteLockDialog({ note, mode, nek, onClose, onLocked, onLockRemoved }: NoteLockDialogProps) {
  const { db } = useDatabase();
  const { biometricAvailable, authenticateForSettingsChange } = useAppLock();
  const [method, setMethod] = useState<NoteLockMethod>("pattern");
  const [step, setStep] = useState<"choose" | "set">("choose");
  const [useBiometric, setUseBiometric] = useState(false);
  const [editingMethod, setEditingMethod] = useState<NoteLockMethod | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  const open = Boolean(note);
  const lock = note?.lock ?? null;
  const biometricCopyHere = note ? hasBiometricCopy(note.id) : false;
  const slotCount = lock ? Object.keys(lock.slots).length : 0;

  const close = () => {
    setStep("choose");
    setEditingMethod(null);
    setConfirmRemove(false);
    setUseBiometric(false);
    onClose();
  };

  if (!note) return null;

  const handleSetupDone = async (secret: string | number[]) => {
    if (!db) return;
    await lockNote(db, note.id, method, secret, { biometric: useBiometric });
    toast.success("Note locked — only its title is visible now.");
    onLocked?.();
    close();
  };

  const handleSlotDone = async (secret: string | number[]) => {
    if (!db || !nek || !editingMethod) return;
    await setNoteLockSlot(db, note, nek, editingMethod, secret);
    toast.success(`${METHOD_META[editingMethod].label} updated for this note.`);
    setEditingMethod(null);
  };

  const toggleBiometric = async (enabled: boolean) => {
    if (!db || !nek) return;
    if (enabled) {
      const auth = await authenticateForSettingsChange();
      if (!auth.success) {
        if (!auth.cancelled) toast.error(auth.error ?? "Fingerprint verification failed.");
        return;
      }
    }
    setBusy(true);
    try {
      const done = await setNoteLockBiometric(db, note, nek, enabled);
      if (done) {
        toast.success(enabled ? "Fingerprint unlock enabled for this note." : "Fingerprint unlock removed.");
      } else {
        toast.error("Couldn't store the fingerprint key copy on this device.");
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveLock = async () => {
    if (!db || !nek) return;
    setBusy(true);
    try {
      await removeNoteLock(db, note.id, nek);
      toast.success("Lock removed. This note is no longer encrypted.");
      onLockRemoved?.();
      close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif">
            <Lock className="size-5 text-primary" />
            {mode === "setup" ? "Lock this note" : "Note lock"}
          </DialogTitle>
          <DialogDescription className="truncate">“{noteTitle(note)}”</DialogDescription>
        </DialogHeader>

        {mode === "setup" && step === "choose" && (
          <div className="space-y-4">
            <div className="space-y-2">
              {METHODS.map((m) => {
                const Meta = METHOD_META[m];
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMethod(m)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                      method === m
                        ? "border-primary/50 bg-primary/5 ring-1 ring-primary/30"
                        : "border-border hover:bg-accent/40",
                    )}
                    aria-pressed={method === m}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Meta.icon className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{Meta.label}</span>
                      <span className="block text-xs text-muted-foreground">{Meta.blurb}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            {biometricAvailable && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
                <span className="flex items-start gap-3">
                  <Fingerprint className="mt-0.5 size-5 shrink-0 text-primary" />
                  <span>
                    <span className="block text-sm font-medium">Also unlock with fingerprint</span>
                    <span className="block text-xs text-muted-foreground">
                      A convenience for this device — your {METHOD_META[method].label.toLowerCase()}{" "}
                      stays as the backup and is still required on a new device or if fingerprint
                      fails.
                    </span>
                  </span>
                </span>
                <Switch checked={useBiometric} onCheckedChange={setUseBiometric} />
              </div>
            )}

            <div className="flex gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-amber-900 dark:text-amber-200">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <p className="text-xs leading-relaxed">
                <strong>No recovery.</strong> This note will be encrypted for real. If you forget
                this credential, the note can <strong>never</strong> be opened again — there is no
                reset. Backups keep it locked with the same credential. Locking clears this
                note&apos;s version history.
              </p>
            </div>

            <Button className="w-full" onClick={() => setStep("set")}>
              Continue
            </Button>
          </div>
        )}

        {mode === "setup" && step === "set" && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setStep("choose")}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" /> Choose a different method
            </button>
            <CredentialSetter method={method} doneLabel="Lock this note" onDone={handleSetupDone} />
          </div>
        )}

        {mode === "manage" && lock && !editingMethod && (
          <div className="space-y-4">
            <div className="space-y-2">
              {METHODS.map((m) => {
                const Meta = METHOD_META[m];
                const isSet = Boolean(lock.slots[m]);
                return (
                  <div
                    key={m}
                    className="flex items-center gap-3 rounded-xl border border-border p-3"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Meta.icon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{Meta.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {isSet ? "Set — can unlock this note" : "Not set"}
                      </span>
                    </span>
                    {isSet ? (
                      <>
                        <Button variant="outline" size="sm" onClick={() => setEditingMethod(m)}>
                          Change
                        </Button>
                        {slotCount > 1 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={async () => {
                              if (!db) return;
                              const removed = await removeNoteLockSlot(db, note, m);
                              if (removed) toast.success(`${Meta.label} removed from this note.`);
                            }}
                          >
                            Remove
                          </Button>
                        )}
                      </>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => setEditingMethod(m)}>
                        Add
                      </Button>
                    )}
                  </div>
                );
              })}

              <div className="flex items-center gap-3 rounded-xl border border-border p-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Fingerprint className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Fingerprint</span>
                  <span className="block text-xs text-muted-foreground">
                    {lock.biometric
                      ? biometricCopyHere
                        ? "Enabled on this device"
                        : "Enabled, but not set up on this device"
                      : "Off — a backup credential above always stays required"}
                  </span>
                </span>
                <Switch
                  checked={Boolean(lock.biometric && biometricCopyHere)}
                  disabled={busy || !biometricAvailable}
                  onCheckedChange={(checked) => void toggleBiometric(checked)}
                />
              </div>
              {!biometricAvailable && (
                <p className="text-xs text-muted-foreground">
                  Fingerprint is only available in the Android app on a device with a sensor.
                </p>
              )}
            </div>

            <div className="border-t border-border pt-4">
              {confirmRemove ? (
                <div className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                  <p className="text-sm">
                    Remove the lock? The note and its images will be stored unencrypted again.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy}
                      onClick={() => void handleRemoveLock()}
                    >
                      {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                      Yes, remove lock
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setConfirmRemove(false)}>
                      Keep lock
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="w-full gap-2 text-destructive hover:text-destructive"
                  onClick={() => setConfirmRemove(true)}
                >
                  <LockOpen className="size-4" /> Remove lock from this note
                </Button>
              )}
            </div>
          </div>
        )}

        {mode === "manage" && editingMethod && (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setEditingMethod(null)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" /> Back to lock settings
            </button>
            <CredentialSetter
              method={editingMethod}
              doneLabel="Save credential"
              onDone={handleSlotDone}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

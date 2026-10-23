import { useEffect, useRef, useState } from "react";
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
import { CredentialPrompt } from "@/components/noma/credential-prompt";
import { useSettings } from "@/hooks/use-noma";
import { useAppLock } from "@/lib/noma/AppLockContext";

export function LockScreen() {
  const { settings } = useSettings();
  const {
    isAppActive,
    biometricAvailable,
    lockoutRemainingSeconds,
    unlockWithBiometric,
    unlockWithPassword,
    unlockWithPattern,
    wipeLocalDataAndSecurity,
  } = useAppLock();

  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);

  const availableMethods = settings.unlockMethods;

  // Usable unlock method verification
  const isBiometricUsable = Boolean(availableMethods.biometric && biometricAvailable);
  const isPatternUsable = Boolean(
    availableMethods.pattern && settings.patternHash && settings.patternSalt,
  );
  const isPasswordUsable = Boolean(
    availableMethods.password && settings.passwordHash && settings.passwordSalt,
  );

  const hasUsableMethod = isBiometricUsable || isPatternUsable || isPasswordUsable;
  const hasAutoTriggeredBiometric = useRef(false);
  const wasAppInactive = useRef(false);

  // Auto-trigger native biometric prompt ONCE per real background-to-foreground return
  useEffect(() => {
    if (!isAppActive) {
      wasAppInactive.current = true;
      return;
    }

    const isRealReturn = wasAppInactive.current;
    if (isRealReturn) {
      hasAutoTriggeredBiometric.current = false;
      wasAppInactive.current = false;
    }

    if (
      availableMethods.biometric &&
      biometricAvailable &&
      lockoutRemainingSeconds === 0 &&
      !hasAutoTriggeredBiometric.current
    ) {
      hasAutoTriggeredBiometric.current = true;
      void unlockWithBiometric();
    }
  }, [
    isAppActive,
    availableMethods.biometric,
    biometricAvailable,
    lockoutRemainingSeconds,
    unlockWithBiometric,
  ]);

  return (
    <div className="noma-leaf-watermark flex min-h-dvh flex-col items-center justify-center bg-background px-4 pt-safe pb-safe">
      <CredentialPrompt
        heading="Noma Locked"
        subheading="Enter your credentials to access your local notes library"
        methods={{
          biometric: availableMethods.biometric,
          pattern: availableMethods.pattern,
          pin: false,
          password: availableMethods.password,
        }}
        biometricAvailable={biometricAvailable}
        lockoutSeconds={lockoutRemainingSeconds}
        onBiometric={unlockWithBiometric}
        onVerify={async (method, secret) => {
          if (method === "password") return unlockWithPassword(secret as string);
          if (method === "pattern") return unlockWithPattern(secret as number[]);
          return { success: false, error: "That method isn't available for the app lock." };
        }}
        footer={
          <div className="mt-8 border-t border-border pt-4">
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
              onClick={() => setShowRecoveryDialog(true)}
            >
              Forgotten Noma credentials?
            </button>
          </div>
        }
      />

      <AlertDialog open={showRecoveryDialog} onOpenChange={setShowRecoveryDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif">
              Forgotten Credentials Recovery
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              {hasUsableMethod ? (
                <span>
                  If you have forgotten one of your credentials, you can authenticate using any
                  other configured unlock method to unlock Noma and update your security settings.
                </span>
              ) : (
                <>
                  <span className="block">
                    Noma App Lock has no unauthenticated backdoor. Because no other configured
                    unlock method is usable, forgotten credentials can only be reset by performing
                    an explicit local database wipe.
                  </span>
                  <span className="block text-destructive font-semibold">
                    Warning: Wiping local database will permanently delete all local notes,
                    attachments, and settings stored on this device.
                  </span>
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-wrap gap-2 sm:justify-end">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {hasUsableMethod ? (
              <>
                {isBiometricUsable && (
                  <AlertDialogAction
                    onClick={() => {
                      setShowRecoveryDialog(false);
                      void unlockWithBiometric();
                    }}
                  >
                    Authenticate Biometric
                  </AlertDialogAction>
                )}
                {isPatternUsable && (
                  <AlertDialogAction
                    onClick={() => {
                      setShowRecoveryDialog(false);
                    }}
                  >
                    Use Noma Pattern
                  </AlertDialogAction>
                )}
                {isPasswordUsable && (
                  <AlertDialogAction
                    onClick={() => {
                      setShowRecoveryDialog(false);
                    }}
                  >
                    Use Noma Password
                  </AlertDialogAction>
                )}
              </>
            ) : (
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={async () => {
                  await wipeLocalDataAndSecurity();
                }}
              >
                Wipe Local Database & Reset
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

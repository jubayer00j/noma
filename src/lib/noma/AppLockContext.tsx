import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  useCallback,
} from "react";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { useSettings } from "@/hooks/use-noma";
import { useDatabase } from "./DatabaseContext";
import {
  NomaBiometric,
  canonicalizePattern,
  deriveKeyHash,
  generateSalt,
  getLockoutDurationMs,
  verifySecret,
  type BiometricCheckResult,
} from "./app-lock-crypto";
import { hapticUnlockFailure, hapticUnlockSuccess } from "./haptics";

export interface AppLockContextValue {
  isLocked: boolean;
  isLockStateResolving: boolean;
  isAppActive: boolean;
  biometricAvailable: boolean;
  biometricStatus: BiometricCheckResult | null;
  lockoutRemainingSeconds: number;
  unlockWithBiometric: () => Promise<boolean>;
  /**
   * Shows the OS biometric prompt to authorize a security-setting change
   * (e.g. toggling Biometric Unlock). Reuses the existing native
   * NomaBiometric.authenticate flow — Noma only receives the result, never
   * any biometric data. Guards against concurrent prompts.
   */
  authenticateForSettingsChange: () => Promise<SettingsAuthResult>;
  unlockWithPassword: (password: string) => Promise<{ success: boolean; error?: string }>;
  unlockWithPattern: (points: number[]) => Promise<{ success: boolean; error?: string }>;
  setPassword: (password: string) => Promise<void>;
  setPattern: (points: number[]) => Promise<void>;
  verifyCurrentCredential: (
    type: "biometric" | "password" | "pattern",
    payload?: string | number[],
  ) => Promise<{ success: boolean; error?: string }>;
  lock: () => void;
  wipeLocalDataAndSecurity: () => Promise<void>;
}

export interface SettingsAuthResult {
  success: boolean;
  /** True when the user cancelled/dismissed the OS prompt. */
  cancelled?: boolean;
  error?: string;
}

const AppLockContext = createContext<AppLockContextValue | null>(null);

export function useAppLock(): AppLockContextValue {
  const context = useContext(AppLockContext);
  if (!context) {
    throw new Error("useAppLock must be used inside AppLockProvider");
  }
  return context;
}

export function AppLockProvider({ children }: { children: ReactNode }) {
  const { db } = useDatabase();
  const { settings, update, ready } = useSettings();

  // In-memory unlock state initializes to FALSE on reload/restart
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [isAppActive, setIsAppActive] = useState(true);
  const [biometricStatus, setBiometricStatus] = useState<BiometricCheckResult | null>(null);
  const [lockoutRemainingSeconds, setLockoutRemainingSeconds] = useState(0);

  const lastBackgroundTimestamp = useRef<number | null>(null);
  const isBiometricPromptActive = useRef(false);

  const activeDbName = db?.name;

  // Reset unlock state whenever active account database (e.g. noma_guest <-> noma_<uid>) changes
  useEffect(() => {
    setIsUnlocked(false);
  }, [activeDbName]);

  // Check native biometric availability on mount
  useEffect(() => {
    let active = true;
    async function checkBiometric() {
      if (Capacitor.isNativePlatform()) {
        try {
          const res = await NomaBiometric.checkBiometricSupport();
          if (active) setBiometricStatus(res);
        } catch {
          if (active)
            setBiometricStatus({
              available: false,
              code: "ERROR",
              message: "Failed to check biometric",
            });
        }
      } else {
        if (active)
          setBiometricStatus({
            available: false,
            code: "WEB",
            message: "Biometrics unavailable on web",
          });
      }
    }
    void checkBiometric();
    return () => {
      active = false;
    };
  }, []);

  // Handle persistent lockout timer countdown
  useEffect(() => {
    if (!ready || !settings.lockoutUntil) {
      setLockoutRemainingSeconds(0);
      return;
    }

    const updateCountdown = () => {
      const now = Date.now();
      if (settings.lockoutUntil && settings.lockoutUntil > now) {
        setLockoutRemainingSeconds(Math.ceil((settings.lockoutUntil - now) / 1000));
      } else {
        setLockoutRemainingSeconds(0);
        if (settings.lockoutUntil) {
          void update({ lockoutUntil: null });
        }
      }
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);
    return () => clearInterval(interval);
  }, [ready, settings.lockoutUntil, update]);

  // Handle background / foreground lifecycle lock timeouts
  useEffect(() => {
    if (!ready || !settings.appLockEnabled) return;

    const onAppHide = () => {
      // Don't trigger background lock timer or flip isAppActive if native biometric prompt is active
      if (isBiometricPromptActive.current) return;
      setIsAppActive(false);
      lastBackgroundTimestamp.current = Date.now();
      if (settings.lockTimeout === 0) {
        setIsUnlocked(false);
      }
    };

    const onAppShow = () => {
      setIsAppActive(true);
      if (isBiometricPromptActive.current) return;
      if (lastBackgroundTimestamp.current !== null) {
        const elapsed = (Date.now() - lastBackgroundTimestamp.current) / 1000;
        lastBackgroundTimestamp.current = null;

        // Bypass lock if elapsed time is negligible (< 300ms, like configuration change / rotation)
        if (elapsed > 0.3 && elapsed >= settings.lockTimeout) {
          setIsUnlocked(false);
        }
      }
    };

    let appStateListener: PluginListenerHandle | null = null;

    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (!isActive) {
          onAppHide();
        } else {
          onAppShow();
        }
      }).then((listener) => {
        appStateListener = listener;
      });
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        onAppHide();
      } else if (document.visibilityState === "visible") {
        onAppShow();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", onAppHide);
    window.addEventListener("focus", onAppShow);

    return () => {
      if (appStateListener) void appStateListener.remove();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", onAppHide);
      window.removeEventListener("focus", onAppShow);
    };
  }, [ready, settings.appLockEnabled, settings.lockTimeout]);

  // Every credential path funnels through these two functions —
  // password, pattern, biometric unlock, and settings-change
  // verification — so the unlock haptics (native-feel #4) wired here
  // fire exactly once per attempt outcome, biometric included. A
  // lockout-blocked attempt returns before reaching either funnel and
  // stays silent, as does a dismissed biometric prompt.
  const handleFailedAttempt = useCallback(async () => {
    hapticUnlockFailure();
    const nextAttempts = (settings.failedAttempts || 0) + 1;
    const durationMs = getLockoutDurationMs(nextAttempts);
    const lockoutUntil = durationMs > 0 ? Date.now() + durationMs : null;

    await update({
      failedAttempts: nextAttempts,
      lockoutUntil,
    });
  }, [settings.failedAttempts, update]);

  const handleSuccessfulAttempt = useCallback(async () => {
    hapticUnlockSuccess();
    if (settings.failedAttempts > 0 || settings.lockoutUntil !== null) {
      await update({
        failedAttempts: 0,
        lockoutUntil: null,
      });
    }
  }, [settings.failedAttempts, settings.lockoutUntil, update]);

  const unlockWithBiometric = useCallback(async (): Promise<boolean> => {
    if (!settings.unlockMethods.biometric) return false;
    if (!Capacitor.isNativePlatform() || !biometricStatus?.available) return false;

    isBiometricPromptActive.current = true;
    try {
      const res = await NomaBiometric.authenticate({
        title: "Unlock Noma",
        subtitle: "Confirm your biometric to proceed",
        cancelTitle: "Use Noma Credentials",
      });
      isBiometricPromptActive.current = false;

      if (res.success) {
        await handleSuccessfulAttempt();
        setIsUnlocked(true);
        return true;
      }
      return false;
    } catch {
      isBiometricPromptActive.current = false;
      return false;
    }
  }, [settings.unlockMethods.biometric, biometricStatus?.available, handleSuccessfulAttempt]);

  /**
   * Guards a security-setting change (e.g. toggling Biometric Unlock) behind
   * the OS biometric prompt. Uses the existing NomaBiometric.authenticate
   * native flow — the OS owns enrollment and verification; Noma only learns
   * the result. Never resolves success without the OS confirming it, so
   * callers can safely persist only on `success`.
   */
  const authenticateForSettingsChange = useCallback(async (): Promise<SettingsAuthResult> => {
    if (!Capacitor.isNativePlatform()) {
      return { success: false, error: "Biometric verification is only available on Android." };
    }
    if (!biometricStatus?.available) {
      return {
        success: false,
        error: biometricStatus?.message ?? "Biometric authentication is unavailable.",
      };
    }
    if (isBiometricPromptActive.current) {
      return { success: false, error: "Verification already in progress." };
    }

    isBiometricPromptActive.current = true;
    try {
      const res = await NomaBiometric.authenticate({
        title: "Verify it's you",
        subtitle: "Confirm your biometric to change this setting",
        cancelTitle: "Cancel",
      });
      isBiometricPromptActive.current = false;

      if (res.success) return { success: true };
      // ERROR_USER_CANCELED (3) / ERROR_NEGATIVE_BUTTON (13): dismissed, not failed.
      const cancelled = res.errorCode === 3 || res.errorCode === 13;
      return {
        success: false,
        cancelled,
        error: res.errorMessage ?? "Biometric verification failed.",
      };
    } catch {
      isBiometricPromptActive.current = false;
      return { success: false, error: "Biometric authentication error." };
    }
  }, [biometricStatus]);

  const unlockWithPassword = useCallback(
    async (password: string): Promise<{ success: boolean; error?: string }> => {
      if (lockoutRemainingSeconds > 0) {
        return {
          success: false,
          error: `Too many attempts. Try again in ${lockoutRemainingSeconds}s.`,
        };
      }
      if (!settings.passwordHash || !settings.passwordSalt) {
        return { success: false, error: "Noma Password is not configured." };
      }

      const match = await verifySecret(
        password,
        settings.passwordSalt,
        settings.passwordHash,
        600000,
      );
      if (match) {
        await handleSuccessfulAttempt();
        setIsUnlocked(true);
        return { success: true };
      } else {
        await handleFailedAttempt();
        return { success: false, error: "Incorrect password." };
      }
    },
    [
      lockoutRemainingSeconds,
      settings.passwordHash,
      settings.passwordSalt,
      handleSuccessfulAttempt,
      handleFailedAttempt,
    ],
  );

  const unlockWithPattern = useCallback(
    async (points: number[]): Promise<{ success: boolean; error?: string }> => {
      if (lockoutRemainingSeconds > 0) {
        return {
          success: false,
          error: `Too many attempts. Try again in ${lockoutRemainingSeconds}s.`,
        };
      }
      if (!settings.patternHash || !settings.patternSalt) {
        return { success: false, error: "Noma Pattern is not configured." };
      }

      const canonical = canonicalizePattern(points);
      const match = await verifySecret(
        canonical,
        settings.patternSalt,
        settings.patternHash,
        100000,
      );

      if (match) {
        await handleSuccessfulAttempt();
        setIsUnlocked(true);
        return { success: true };
      } else {
        await handleFailedAttempt();
        return { success: false, error: "Incorrect pattern." };
      }
    },
    [
      lockoutRemainingSeconds,
      settings.patternHash,
      settings.patternSalt,
      handleSuccessfulAttempt,
      handleFailedAttempt,
    ],
  );

  const setPassword = useCallback(
    async (password: string) => {
      const salt = generateSalt();
      const hash = await deriveKeyHash(password, salt, 600000);
      await update({
        passwordSalt: salt,
        passwordHash: hash,
        unlockMethods: { ...settings.unlockMethods, password: true },
      });
    },
    [settings.unlockMethods, update],
  );

  const setPattern = useCallback(
    async (points: number[]) => {
      const canonical = canonicalizePattern(points);
      const salt = generateSalt();
      const hash = await deriveKeyHash(canonical, salt, 100000);
      await update({
        patternSalt: salt,
        patternHash: hash,
        unlockMethods: { ...settings.unlockMethods, pattern: true },
      });
    },
    [settings.unlockMethods, update],
  );

  const verifyCurrentCredential = useCallback(
    async (
      type: "biometric" | "password" | "pattern",
      payload?: string | number[],
    ): Promise<{ success: boolean; error?: string }> => {
      if (lockoutRemainingSeconds > 0) {
        return {
          success: false,
          error: `Too many attempts. Lockout active for ${lockoutRemainingSeconds}s.`,
        };
      }

      if (type === "biometric") {
        if (!settings.unlockMethods.biometric) {
          return { success: false, error: "Biometric unlock is not enabled." };
        }
        if (!Capacitor.isNativePlatform() || !biometricStatus?.available) {
          return { success: false, error: "Biometric sensor unavailable." };
        }
        isBiometricPromptActive.current = true;
        try {
          const res = await NomaBiometric.authenticate({
            title: "Authorize Security Change",
            subtitle: "Confirm biometric to modify security settings",
            cancelTitle: "Cancel",
          });
          isBiometricPromptActive.current = false;
          if (res.success) {
            await handleSuccessfulAttempt();
            return { success: true };
          }
          return { success: false, error: "Biometric authorization failed." };
        } catch {
          isBiometricPromptActive.current = false;
          return { success: false, error: "Biometric authentication error." };
        }
      }

      if (type === "password" && typeof payload === "string") {
        if (!settings.passwordHash || !settings.passwordSalt) {
          return { success: false, error: "Noma Password is not configured." };
        }
        const match = await verifySecret(
          payload,
          settings.passwordSalt,
          settings.passwordHash,
          600000,
        );
        if (match) {
          await handleSuccessfulAttempt();
          return { success: true };
        } else {
          await handleFailedAttempt();
          return { success: false, error: "Incorrect password." };
        }
      }

      if (type === "pattern" && Array.isArray(payload)) {
        if (!settings.patternHash || !settings.patternSalt) {
          return { success: false, error: "Noma Pattern is not configured." };
        }
        const canonical = canonicalizePattern(payload);
        const match = await verifySecret(
          canonical,
          settings.patternSalt,
          settings.patternHash,
          100000,
        );
        if (match) {
          await handleSuccessfulAttempt();
          return { success: true };
        } else {
          await handleFailedAttempt();
          return { success: false, error: "Incorrect pattern." };
        }
      }

      return { success: false, error: "Invalid credential verification payload." };
    },
    [
      lockoutRemainingSeconds,
      biometricStatus?.available,
      settings.passwordHash,
      settings.passwordSalt,
      settings.patternHash,
      settings.patternSalt,
      handleSuccessfulAttempt,
      handleFailedAttempt,
    ],
  );

  const lock = useCallback(() => {
    setIsUnlocked(false);
  }, []);

  const wipeLocalDataAndSecurity = useCallback(async () => {
    if (typeof window !== "undefined" && "indexedDB" in window) {
      try {
        const dbName = activeDbName || "noma_guest";
        if (db) db.close();
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = () => {
          window.location.reload();
        };
        req.onerror = () => {
          window.location.reload();
        };
        req.onblocked = () => {
          window.location.reload();
        };
      } catch {
        window.location.reload();
      }
    }
  }, [activeDbName, db]);

  const effectiveIsLocked = !ready ? true : settings.appLockEnabled && !isUnlocked;

  return (
    <AppLockContext.Provider
      value={{
        isLocked: effectiveIsLocked,
        isLockStateResolving: !ready,
        isAppActive,
        biometricAvailable: Boolean(biometricStatus?.available),
        biometricStatus,
        lockoutRemainingSeconds,
        unlockWithBiometric,
        authenticateForSettingsChange,
        unlockWithPassword,
        unlockWithPattern,
        setPassword,
        setPattern,
        verifyCurrentCredential,
        lock,
        wipeLocalDataAndSecurity,
      }}
    >
      {children}
    </AppLockContext.Provider>
  );
}

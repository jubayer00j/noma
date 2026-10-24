import { useEffect, type ReactNode } from "react";
import { BackupSchedulerMount } from "./backup-scheduler-mount";
import { BootScreen } from "./boot-screen";
import { VerifyEmail } from "./verify-email";
import { Welcome } from "./welcome";
import { useSettings } from "@/hooks/use-noma";
import { useAuth } from "@/lib/noma/auth";
import { applyTheme } from "@/lib/noma/theme";
import { syncSystemBarsToTheme } from "@/lib/noma/system-bars";
import { syncDynamicColor } from "@/lib/noma/dynamic-color";
import { setHapticsEnabled } from "@/lib/noma/haptics";
import { signalSplashReady } from "@/lib/noma/splash-handoff";
import { initNotificationOpenListener } from "@/lib/noma/notification-open";
import { useAppLock } from "@/lib/noma/AppLockContext";
import { LockScreen } from "./lock-screen";

/**
 * Applies the stored theme and, for signed-in accounts only, handles email
 * verification and the first-run welcome. Signing in is optional: without an
 * account Noma runs in Local Mode straight into the workspace.
 */
export function AppGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const { settings, update, ready } = useSettings();

  // Light = light, Dark = dark, System follows the OS and reacts to changes live.
  // The system-bar icon contrast rides the same signal (native only), and
  // so does Material You dynamic colour (native-feel #7): when its toggle
  // is on, the accent family follows the wallpaper palette for whichever
  // mode the choice resolves to.
  useEffect(() => {
    if (!ready) return;
    const choice = settings.theme;
    applyTheme(choice);
    syncSystemBarsToTheme(choice);
    syncDynamicColor(choice, settings.dynamicColorEnabled);
    if (choice !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      applyTheme("system");
      syncSystemBarsToTheme("system");
      syncDynamicColor("system", settings.dynamicColorEnabled);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [settings.theme, settings.dynamicColorEnabled, ready]);

  // Material You (native-feel #7): a wallpaper change while Noma sits in
  // the background lands on return — re-pull the palette whenever the
  // app becomes visible again, but only while the toggle is on.
  useEffect(() => {
    if (!ready || !settings.dynamicColorEnabled) return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        syncDynamicColor(settings.theme, true);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [settings.theme, settings.dynamicColorEnabled, ready]);

  // Haptic feedback follows the stored preference (native-feel #4): the
  // haptics bridge is gated on a module-level mirror, so the Settings
  // toggle takes effect immediately, with no reload.
  useEffect(() => {
    if (!ready) return;
    setHapticsEnabled(settings.hapticsEnabled);
  }, [settings.hapticsEnabled, ready]);

  // Splash handoff (native-feel #5): AppGate is the first shell to mount
  // on every cold start — it renders BootScreen while auth/lock/db
  // resolve. Once its first frame has painted (double rAF ≈ React
  // committed + browser painted), tell the native splash overlay it can
  // dismiss on readiness instead of waiting out its fallback timer.
  // Native-only and single-fire inside the bridge; a no-op on web.
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => signalSplashReady());
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  // Reminder deep links (native-feel #8): register the one app-shell
  // notification-tap listener. A tap becomes a pending note-open request
  // that the workspace consumes once the DB is ready and the App Lock is
  // open. Cold-start taps are retained by the bridge and replayed to this
  // registration, so registering here — AppGate mounts on every start —
  // covers them. Native-only and register-once inside the module.
  useEffect(() => {
    initNotificationOpenListener();
  }, []);

  if (auth.configured && auth.loading) {
    return <BootScreen />;
  }

  if (auth.configured && auth.user && auth.needsEmailVerification) return <VerifyEmail />;

  if (auth.configured && auth.user && ready && settings.onboardedFor !== auth.user.uid) {
    const uid = auth.user.uid;
    return (
      <div className="animate-in fade-in duration-300 motion-reduce:animate-none">
        <Welcome email={auth.email} onStart={() => void update({ onboardedFor: uid })} />
      </div>
    );
  }

  return <AppGateContent>{children}</AppGateContent>;
}

function AppGateContent({ children }: { children: ReactNode }) {
  const { isLocked, isLockStateResolving } = useAppLock();

  if (isLockStateResolving) {
    return <BootScreen />;
  }

  if (isLocked) {
    return (
      <>
        <BackupSchedulerMount />
        <LockScreen />
      </>
    );
  }

  return (
    <>
      <BackupSchedulerMount />
      <div className="animate-in fade-in duration-200 motion-reduce:animate-none">{children}</div>
    </>
  );
}

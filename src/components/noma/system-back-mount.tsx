import { useEffect, useRef } from "react";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useAppLock } from "@/lib/noma/AppLockContext";
import { dismissTopOverlay, hasOpenOverlay } from "@/lib/noma/overlay-registry";
import { handleSystemBackPress, hasSettingsSubScreen } from "@/lib/noma/system-back";

/**
 * Installs the single app-wide Android `backButton` listener (see
 * system-back.ts for the priority chain it drives).
 *
 * It mounts in the root route beside ShortcutListener — the one place
 * that stays alive across every route and across the App Lock gate.
 * AppGate cannot host it: it is rendered per route (and not at all on
 * /share-target), so a listener installed there would be torn down and
 * recreated on every navigation.
 *
 * On web nothing is installed; browser back keeps working through the
 * router as before.
 */
export function SystemBackMount() {
  const { isLocked, isLockStateResolving } = useAppLock();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // The native listener is registered once; it reads live values from
  // refs so it never needs re-registering as state changes. While the
  // lock state is still resolving, the boot surface is up — treat it
  // like the lock screen (back minimizes, never reveals).
  const liveRef = useRef({ locked: true, pathname: "/" });
  liveRef.current = { locked: isLocked || isLockStateResolving, pathname };
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let handle: PluginListenerHandle | undefined;
    void CapacitorApp.addListener("backButton", () => {
      handleSystemBackPress(
        {
          overlayOpen: hasOpenOverlay(),
          locked: liveRef.current.locked,
          pathname: liveRef.current.pathname,
          settingsSubScreenOpen: hasSettingsSubScreen(),
        },
        {
          dismissOverlay: () => {
            dismissTopOverlay();
          },
          minimizeApp: () => void CapacitorApp.minimizeApp(),
          navigateToWorkspace: () => void routerRef.current.navigate({ to: "/" }),
        },
      );
    }).then((listener) => {
      if (cancelled) void listener.remove();
      else handle = listener;
    });
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, []);

  return null;
}

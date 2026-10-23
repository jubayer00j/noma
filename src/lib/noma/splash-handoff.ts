import { Capacitor } from "@capacitor/core";

/**
 * Splash handoff bridge (native-feel #5).
 *
 * The native splash overlay in MainActivity used to dismiss on a fixed
 * 1-second timer — a guess that meant dead time on fast devices (app
 * painted, waiting behind the artwork) and a blank-WebView flash on
 * slow ones (overlay gone before the first paint). The overlay now
 * dismisses when the web layer signals that its first frame has
 * painted, with a native minimum display and a hard fallback timer as
 * guardrails (see MainActivity). This module is the web half of that
 * signal: AppGate calls it once on first mount, after a double
 * requestAnimationFrame — "React committed and the browser painted",
 * claimed honestly as *first frame painted*, not *data ready* (data
 * readiness is BootScreen's own job to cover, and it does).
 *
 * Native side: MainActivity registers a minimal @JavascriptInterface
 * object on the Capacitor WebView — window.NomaSplash.ready() — which
 * marshals to the UI thread and runs the dismiss policy there.
 *
 * Like system-bars.ts (#71) and haptics.ts (#74) this bridge is
 * native-only and fire-and-forget: a missing bridge object (older APK,
 * an interface that never registered) or a throwing one is swallowed —
 * the native fallback timer dismisses the splash regardless.
 */

interface NomaSplashBridge {
  ready: () => void;
}

declare global {
  interface Window {
    NomaSplash?: NomaSplashBridge;
  }
}

let splashSignalled = false;

function nomaSplashBridge(): NomaSplashBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.NomaSplash;
}

/**
 * Tells the native splash overlay that the web layer has painted its
 * first frame. Fires at most once per page load; a no-op on web.
 */
export function signalSplashReady(): void {
  if (splashSignalled) return;
  if (!Capacitor.isNativePlatform()) return;
  // Mark before calling: a throwing bridge must not be retried on some
  // later mount — the native fallback timer is the safety net, not a
  // second attempt.
  splashSignalled = true;
  try {
    nomaSplashBridge()?.ready();
  } catch {
    /* Splash dismissal has a native fallback; never surface this. */
  }
}

import { Capacitor } from "@capacitor/core";
import { StatusBar, Style } from "@capacitor/status-bar";
import { resolveTheme, type ThemeChoice } from "./theme";

/**
 * System-bar appearance bridge (native-feel #2: edge-to-edge).
 *
 * The native window is permanently edge-to-edge (see MainActivity): the
 * app's surfaces paint behind the transparent status/navigation bars,
 * CSS safe-area utilities (styles.css `*-safe`) keep content out of the
 * bar/cutout zones, and this module keeps the bar *icons* legible by
 * following the in-app theme — a light surface needs dark icons, a dark
 * surface needs light icons.
 *
 * Why the official @capacitor/status-bar plugin composes safely here
 * (verified against its 7.0.6 Android source): its setStyle() drives the
 * same WindowInsetsControllerCompat.setAppearanceLightStatusBars that
 * MainActivity uses for show/hide — appearance flags are orthogonal to
 * the visibility flags the splash sequence owns. Its only load-time
 * side effects (a default black background colour and legacy
 * systemUiVisibility layout flags via overlaysWebView) are pinned off
 * in capacitor.config.ts, and this module only ever calls setStyle —
 * never hide/show/setBackgroundColor/setOverlaysWebView.
 */

/**
 * Plugin style for a resolved theme. (Capacitor's naming describes the
 * bar *content*: Style.Light = dark text/icons for light backgrounds,
 * Style.Dark = light text/icons for dark backgrounds.)
 */
export function statusBarStyleFor(resolved: "light" | "dark"): Style {
  return resolved === "dark" ? Style.Dark : Style.Light;
}

/**
 * Points the system-bar icons at the given theme choice. Fire-and-forget:
 * called from AppGate beside applyTheme — on first load, on every theme
 * change, and on OS theme changes while the choice is "system". A
 * no-op everywhere except the native app.
 */
export function syncSystemBarsToTheme(choice: ThemeChoice): void {
  if (!Capacitor.isNativePlatform()) return;
  const style = statusBarStyleFor(resolveTheme(choice));
  void StatusBar.setStyle({ style }).catch(() => {
    /* Bar appearance is cosmetic; never let it surface as an app error. */
  });
}

/**
 * System-bar insets (status-bar overlap fix).
 *
 * The edge-to-edge design above relies on CSS env(safe-area-inset-*)
 * to keep shell content out of the bar zones — but inside the Android
 * WebView env() reports only the display-cutout inset, not the
 * status-bar height, so on a device whose cutout inset is zero the
 * app header slid underneath the status bar. Native apps pad by the
 * real WindowInsets and never see this. MainActivity therefore
 * forwards the real system-bar insets through the same seam as the
 * IME height (PR #83): a `noma:system-insets` window event in CSS px
 * plus a synchronous `window.NomaSystemInsets` getter for the values
 * dispatched before this listener registered (the shell dispatches
 * from onCreate, long before the bundle boots). This module keeps
 * them as the --noma-inset-top / --noma-inset-bottom custom
 * properties on <html>; the *-safe utilities in styles.css pad by the
 * larger of env() and these vars, so web/PWA rendering — where the
 * vars are never set — is exactly as before.
 */

/** Window event the native shell dispatches with the system-bar insets in CSS px. */
export const NATIVE_SYSTEM_INSETS_EVENT = "noma:system-insets";

/** System-bar insets in CSS px: status bar on top, navigation bar at the bottom. */
export interface SystemBarInsets {
  top: number;
  bottom: number;
}

/** Native bridge the installed app registers (absent on web). */
export interface NomaSystemInsetsBridgeLike {
  getTopCssPx: () => number;
  getBottomCssPx: () => number;
}

declare global {
  interface Window {
    NomaSystemInsets?: NomaSystemInsetsBridgeLike;
  }
}

const SYSTEM_INSET_VAR_NAMES = ["--noma-inset-top", "--noma-inset-bottom"] as const;

function isValidInset(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Validates an event payload into insets. Anything malformed is
 * null — the caller then keeps the previous values, because a bad
 * reading must never collapse the shell's padding.
 */
export function parseSystemInsets(detail: unknown): SystemBarInsets | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as Record<string, unknown>;
  if (!isValidInset(d["top"]) || !isValidInset(d["bottom"])) return null;
  return { top: Math.round(d["top"]), bottom: Math.round(d["bottom"]) };
}

/** Writes the insets as CSS px custom properties on <html>. */
export function applySystemInsets(insets: SystemBarInsets): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement?.style;
  if (!style) return;
  style.setProperty(SYSTEM_INSET_VAR_NAMES[0], `${insets.top}px`);
  style.setProperty(SYSTEM_INSET_VAR_NAMES[1], `${insets.bottom}px`);
}

function readBridgeInsets(): SystemBarInsets | null {
  if (typeof window === "undefined") return null;
  try {
    const bridge = window.NomaSystemInsets;
    if (!bridge) return null;
    return parseSystemInsets({ top: bridge.getTopCssPx(), bottom: bridge.getBottomCssPx() });
  } catch {
    return null;
  }
}

let systemInsetsListening = false;

/**
 * The AppGate entry point: register-once, native-only. Reads the
 * bridge's last values first (the mount case above), then keeps the
 * vars current on every `noma:system-insets` event. A no-op on web,
 * where env() is the only inset source and stays authoritative.
 */
export function initSystemInsetsListener(): void {
  if (systemInsetsListening) return;
  if (!Capacitor.isNativePlatform()) return;
  if (typeof window === "undefined") return;
  systemInsetsListening = true;
  const initial = readBridgeInsets();
  if (initial) applySystemInsets(initial);
  window.addEventListener(NATIVE_SYSTEM_INSETS_EVENT, (event) => {
    const insets = parseSystemInsets((event as CustomEvent<unknown>).detail);
    if (insets) applySystemInsets(insets);
  });
}

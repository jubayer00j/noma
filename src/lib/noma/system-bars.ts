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

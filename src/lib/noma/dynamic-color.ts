import { Capacitor } from "@capacitor/core";
import { DYNAMIC_COLOR_STORAGE_KEY, resolveTheme, type ThemeChoice } from "./theme";

/**
 * Material You dynamic colour bridge (native-feel #7).
 *
 * An opt-in Appearance toggle ("Wallpaper colours (Material You)") that
 * retints only the accent family — --primary, --primary-foreground,
 * --ring, --accent, --accent-foreground — from the Android 12+ system
 * dynamic palette. Backgrounds, surfaces, borders and text keep the
 * chosen theme's hand-tuned values: Nature stays warm, AMOLED stays
 * pure black, only the accent follows the wallpaper. That is the scope
 * most Material You apps actually ship, and the honest one for a
 * WebView app whose themes are 780 lines of tuned oklch.
 *
 * Native side: MainActivity registers a minimal @JavascriptInterface
 * object on the Capacitor WebView — window.NomaDynamicColor
 * .getPaletteJson() — which reads four framework colours
 * (system_accent1_600 / _200 for the light / dark primary,
 * system_accent2_100 / _700 for the light / dark accent surface: the
 * framework index steps for Material's tone 40 / 80 primaries and
 * tone 90 / 30 accent surfaces) and returns them as a JSON string.
 * Synchronous by design: the web layer reads the palette in the same
 * effect that applies the theme — no async gap, no flash machinery
 * beyond the bootstrap cache below. No Material library, no new
 * dependency, no permission.
 *
 * The palette's var values are applied as hex inline properties on
 * <html>, overriding the stylesheet blocks. Hex is safe here (verified
 * against styles.css): no rule performs oklch-specific math on these
 * five vars — @theme inline maps them straight through as var(--…),
 * and Tailwind v4's opacity modifiers go through color-mix, which
 * accepts any colour format.
 *
 * First paint: the render-blocking bootstrap (theme.ts) runs before
 * any bridge call can happen, so every successful pull also caches
 * both modes' var maps in one localStorage record
 * (DYNAMIC_COLOR_STORAGE_KEY) and the bootstrap applies the cached map
 * pre-paint when the record says enabled — the same flash-free
 * standard as #58/#75. Turning the toggle off clears the record.
 *
 * Like system-bars.ts (#71) and haptics.ts (#74) this bridge is
 * native-only and failure-proof: a missing or throwing bridge, an
 * unavailable palette (Android < 12), or a malformed response all
 * resolve to "clear the inline vars, stay silent" — Noma's own
 * palette is always the fallback.
 */

interface NomaDynamicColorBridge {
  getPaletteJson: () => string;
}

declare global {
  interface Window {
    NomaDynamicColor?: NomaDynamicColorBridge;
  }
}

/** The four palette colours the native bridge reports, as #RRGGBB strings. */
export interface DynamicPalette {
  lightPrimary: string;
  darkPrimary: string;
  lightAccent: string;
  darkAccent: string;
}

/** Inline custom properties for one resolved mode. */
export type DynamicVarMap = Record<string, string>;

/** The localStorage cache record the bootstrap script reads pre-paint. */
export interface DynamicColorCacheRecord {
  enabled: boolean;
  light: DynamicVarMap;
  dark: DynamicVarMap;
}

/** The exact tokens dynamic colour may retint — nothing else, by design. */
export const DYNAMIC_VAR_NAMES = [
  "--primary",
  "--primary-foreground",
  "--ring",
  "--accent",
  "--accent-foreground",
] as const;

/** Foreground candidates for the luminance rule: near-white and ink. */
export const FOREGROUND_ON_DARK = "#ffffff";
export const FOREGROUND_ON_LIGHT = "#14181f";

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_PATTERN.test(value);
}

/**
 * Parses and validates the bridge's JSON. Anything short of a complete,
 * well-formed, available palette is null — the caller falls back to
 * Noma's own colours.
 */
export function parsePaletteJson(raw: unknown): DynamicPalette | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p["available"] !== true) return null;
  if (
    !isHexColor(p["lightPrimary"]) ||
    !isHexColor(p["darkPrimary"]) ||
    !isHexColor(p["lightAccent"]) ||
    !isHexColor(p["darkAccent"])
  ) {
    return null;
  }
  return {
    lightPrimary: p["lightPrimary"],
    darkPrimary: p["darkPrimary"],
    lightAccent: p["lightAccent"],
    darkAccent: p["darkAccent"],
  };
}

/** WCAG relative luminance of a #RRGGBB colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const channel = (start: number) => {
    const c = parseInt(hex.slice(start, start + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrastRatio(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The foreground that reads better on the given swatch: near-white on
 * darker colours (the light-mode primary, the dark accent surface),
 * ink on lighter ones (the dark-mode primary, the light accent
 * surface). Picked by contrast ratio, not by mode — the palette
 * decides.
 */
export function foregroundFor(background: string): string {
  const lum = relativeLuminance(background);
  const onDark = contrastRatio(lum, relativeLuminance(FOREGROUND_ON_DARK));
  const onLight = contrastRatio(lum, relativeLuminance(FOREGROUND_ON_LIGHT));
  return onDark >= onLight ? FOREGROUND_ON_DARK : FOREGROUND_ON_LIGHT;
}

/**
 * Pure mapping: palette + resolved mode → the five inline properties.
 * --ring follows --primary (it mirrors it in every stylesheet theme).
 */
export function dynamicVarsFor(palette: DynamicPalette, mode: "light" | "dark"): DynamicVarMap {
  const primary = mode === "light" ? palette.lightPrimary : palette.darkPrimary;
  const accent = mode === "light" ? palette.lightAccent : palette.darkAccent;
  return {
    "--primary": primary,
    "--primary-foreground": foregroundFor(primary),
    "--ring": primary,
    "--accent": accent,
    "--accent-foreground": foregroundFor(accent),
  };
}

/** Builds the bootstrap cache record: enabled, with both modes' maps. */
export function buildCacheRecord(palette: DynamicPalette): DynamicColorCacheRecord {
  return {
    enabled: true,
    light: dynamicVarsFor(palette, "light"),
    dark: dynamicVarsFor(palette, "dark"),
  };
}

function isVarMap(value: unknown): value is DynamicVarMap {
  if (typeof value !== "object" || value === null) return false;
  const map = value as Record<string, unknown>;
  return DYNAMIC_VAR_NAMES.every((name) => isHexColor(map[name]));
}

/** Validates a stored cache record; corrupt or partial records are null. */
export function parseCacheRecord(raw: unknown): DynamicColorCacheRecord | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record["enabled"] !== "boolean") return null;
  if (!isVarMap(record["light"]) || !isVarMap(record["dark"])) return null;
  return { enabled: record["enabled"], light: record["light"], dark: record["dark"] };
}

function localStore(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

function writeCacheRecord(record: DynamicColorCacheRecord): void {
  try {
    localStore()?.setItem(DYNAMIC_COLOR_STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* Private mode / quota — the live vars still apply this session. */
  }
}

function clearCacheRecord(): void {
  try {
    localStore()?.removeItem(DYNAMIC_COLOR_STORAGE_KEY);
  } catch {
    /* Nothing to clear if storage itself is unreachable. */
  }
}

function readBridgePalette(): DynamicPalette | null {
  if (!Capacitor.isNativePlatform()) return null;
  if (typeof window === "undefined") return null;
  try {
    const bridge = window.NomaDynamicColor;
    if (!bridge || typeof bridge.getPaletteJson !== "function") return null;
    return parsePaletteJson(bridge.getPaletteJson());
  } catch {
    return null;
  }
}

/**
 * True only where dynamic colour can actually work: the native app on
 * Android 12+, with the bridge reporting an available palette. The
 * Settings row renders only when this is true — no dead toggles on web,
 * PWA, or older Android.
 */
export function isDynamicColorAvailable(): boolean {
  return readBridgePalette() !== null;
}

function rootStyle(): CSSStyleDeclaration | undefined {
  if (typeof document === "undefined") return undefined;
  return document.documentElement?.style;
}

/** Applies one mode's var map as inline properties on <html>. */
export function applyDynamicVars(vars: DynamicVarMap): void {
  const style = rootStyle();
  if (!style) return;
  for (const name of DYNAMIC_VAR_NAMES) {
    const value = vars[name];
    if (typeof value === "string") style.setProperty(name, value);
  }
}

/** Removes the inline properties, restoring the stylesheet palette. */
export function clearDynamicVars(): void {
  const style = rootStyle();
  if (!style) return;
  for (const name of DYNAMIC_VAR_NAMES) {
    style.removeProperty(name);
  }
}

/**
 * The AppGate entry point, called beside applyTheme with the stored
 * choice and the toggle state. Enabled: pull the palette, apply the
 * resolved mode's vars, refresh the bootstrap cache. Disabled (or
 * unavailable, or malformed): clear the inline vars and stay silent;
 * disabled also clears the cache record, so the next cold start paints
 * Noma's own palette from the first frame.
 */
export function syncDynamicColor(choice: ThemeChoice, enabled: boolean): void {
  if (!enabled) {
    clearDynamicVars();
    clearCacheRecord();
    return;
  }
  const palette = readBridgePalette();
  if (!palette) {
    clearDynamicVars();
    return;
  }
  applyDynamicVars(dynamicVarsFor(palette, resolveTheme(choice)));
  writeCacheRecord(buildCacheRecord(palette));
}

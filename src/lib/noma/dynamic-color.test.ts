import { beforeEach, describe, expect, it, vi } from "vitest";

let nativePlatform = false;

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => nativePlatform },
}));

import {
  FOREGROUND_ON_DARK,
  FOREGROUND_ON_LIGHT,
  buildCacheRecord,
  clearDynamicVars,
  dynamicVarsFor,
  foregroundFor,
  isDynamicColorAvailable,
  parseCacheRecord,
  parsePaletteJson,
  relativeLuminance,
  syncDynamicColor,
  type DynamicPalette,
} from "./dynamic-color";
import { DYNAMIC_COLOR_STORAGE_KEY, THEME_BOOTSTRAP_SCRIPT, THEME_STORAGE_KEY } from "./theme";

/** A realistic Material You palette (baseline purple seed). */
const PALETTE: DynamicPalette = {
  lightPrimary: "#6750A4",
  darkPrimary: "#D0BCFF",
  lightAccent: "#E8DEF8",
  darkAccent: "#4A4458",
};

const PALETTE_JSON = JSON.stringify({ available: true, ...PALETTE });

class FakeStyle {
  props = new Map<string, string>();
  colorScheme = "";
  setProperty(name: string, value: string) {
    this.props.set(name, value);
  }
  removeProperty(name: string) {
    this.props.delete(name);
  }
  getPropertyValue(name: string) {
    return this.props.get(name) ?? "";
  }
}

class FakeStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

let style: FakeStyle;
let storage: FakeStorage;

function setGlobals(value: { window?: unknown; document?: unknown }) {
  const g = globalThis as { window?: unknown; document?: unknown };
  if ("window" in value) {
    if (value.window === undefined) delete g.window;
    else g.window = value.window;
  }
  if ("document" in value) {
    if (value.document === undefined) delete g.document;
    else g.document = value.document;
  }
}

/** Installs a fake document (with the shared fake style) and window. */
function installDom(windowExtras: Record<string, unknown> = {}) {
  style = new FakeStyle();
  setGlobals({
    document: { documentElement: { style } },
    window: { localStorage: storage, ...windowExtras },
  });
}

beforeEach(() => {
  nativePlatform = false;
  storage = new FakeStorage();
  style = new FakeStyle();
  setGlobals({ window: undefined, document: undefined });
});

describe("parsePaletteJson", () => {
  it("accepts a complete, available palette", () => {
    expect(parsePaletteJson(PALETTE_JSON)).toEqual(PALETTE);
  });

  it("rejects available:false (Android < 12, bridge refusal)", () => {
    expect(parsePaletteJson('{"available":false}')).toBeNull();
  });

  it("rejects malformed JSON and non-string input", () => {
    expect(parsePaletteJson("not json")).toBeNull();
    expect(parsePaletteJson("")).toBeNull();
    expect(parsePaletteJson(null)).toBeNull();
    expect(parsePaletteJson(undefined)).toBeNull();
    expect(parsePaletteJson(42)).toBeNull();
    expect(parsePaletteJson({ available: true })).toBeNull();
  });

  it("rejects a palette with a missing or non-hex colour", () => {
    const missing = JSON.stringify({
      available: true,
      lightPrimary: "#6750A4",
      darkPrimary: "#D0BCFF",
      lightAccent: "#E8DEF8",
    });
    expect(parsePaletteJson(missing)).toBeNull();
    const badHex = JSON.stringify({ available: true, ...PALETTE, darkAccent: "rebeccapurple" });
    expect(parsePaletteJson(badHex)).toBeNull();
    const shortHex = JSON.stringify({ available: true, ...PALETTE, darkAccent: "#4A445" });
    expect(parsePaletteJson(shortHex)).toBeNull();
  });
});

describe("relativeLuminance / foregroundFor", () => {
  it("puts black at 0 and white at 1", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 10);
  });

  it("gives near-white text on the darker light-mode primary", () => {
    expect(foregroundFor(PALETTE.lightPrimary)).toBe(FOREGROUND_ON_DARK);
  });

  it("gives ink text on the lighter dark-mode primary", () => {
    expect(foregroundFor(PALETTE.darkPrimary)).toBe(FOREGROUND_ON_LIGHT);
  });

  it("applies the same rule to accent surfaces, both ways", () => {
    expect(foregroundFor(PALETTE.lightAccent)).toBe(FOREGROUND_ON_LIGHT);
    expect(foregroundFor(PALETTE.darkAccent)).toBe(FOREGROUND_ON_DARK);
  });

  it("flips at the contrast crossover, not at a round luminance", () => {
    // #767676 (L ≈ 0.181) still reads better with white text;
    // #7F7F7F (L ≈ 0.212) has crossed over to ink.
    expect(foregroundFor("#767676")).toBe(FOREGROUND_ON_DARK);
    expect(foregroundFor("#7F7F7F")).toBe(FOREGROUND_ON_LIGHT);
  });
});

describe("dynamicVarsFor", () => {
  it("maps the light mode palette, ring following primary", () => {
    expect(dynamicVarsFor(PALETTE, "light")).toEqual({
      "--primary": "#6750A4",
      "--primary-foreground": FOREGROUND_ON_DARK,
      "--ring": "#6750A4",
      "--accent": "#E8DEF8",
      "--accent-foreground": FOREGROUND_ON_LIGHT,
    });
  });

  it("maps the dark mode palette, ring following primary", () => {
    expect(dynamicVarsFor(PALETTE, "dark")).toEqual({
      "--primary": "#D0BCFF",
      "--primary-foreground": FOREGROUND_ON_LIGHT,
      "--ring": "#D0BCFF",
      "--accent": "#4A4458",
      "--accent-foreground": FOREGROUND_ON_DARK,
    });
  });
});

describe("cache record", () => {
  it("round-trips through JSON with both modes and enabled:true", () => {
    const record = buildCacheRecord(PALETTE);
    expect(record.enabled).toBe(true);
    expect(record.light).toEqual(dynamicVarsFor(PALETTE, "light"));
    expect(record.dark).toEqual(dynamicVarsFor(PALETTE, "dark"));
    expect(parseCacheRecord(JSON.stringify(record))).toEqual(record);
  });

  it("rejects corrupt, partial, or wrongly-typed records", () => {
    expect(parseCacheRecord("nope")).toBeNull();
    expect(parseCacheRecord(null)).toBeNull();
    expect(parseCacheRecord(JSON.stringify({ enabled: true }))).toBeNull();
    const record = buildCacheRecord(PALETTE);
    expect(parseCacheRecord(JSON.stringify({ ...record, enabled: "yes" }))).toBeNull();
    const partial = { ...record, light: { "--primary": "#6750A4" } };
    expect(parseCacheRecord(JSON.stringify(partial))).toBeNull();
  });
});

describe("syncDynamicColor", () => {
  it("applies the dark map and caches both modes when enabled in dark", () => {
    nativePlatform = true;
    installDom({ NomaDynamicColor: { getPaletteJson: () => PALETTE_JSON } });

    syncDynamicColor("dark", true);

    expect(style.props.get("--primary")).toBe("#D0BCFF");
    expect(style.props.get("--ring")).toBe("#D0BCFF");
    expect(style.props.get("--accent")).toBe("#4A4458");
    const cached = parseCacheRecord(storage.getItem(DYNAMIC_COLOR_STORAGE_KEY));
    expect(cached).toEqual(buildCacheRecord(PALETTE));
  });

  it("applies the light map when the choice resolves light (nature included)", () => {
    nativePlatform = true;
    installDom({ NomaDynamicColor: { getPaletteJson: () => PALETTE_JSON } });

    syncDynamicColor("nature", true);

    expect(style.props.get("--primary")).toBe("#6750A4");
    expect(style.props.get("--accent")).toBe("#E8DEF8");
  });

  it("resolves the system choice from the OS colour scheme", () => {
    nativePlatform = true;
    installDom({
      NomaDynamicColor: { getPaletteJson: () => PALETTE_JSON },
      matchMedia: (query: string) => ({ matches: query.includes("dark"), media: query }),
    });

    syncDynamicColor("system", true);

    expect(style.props.get("--primary")).toBe("#D0BCFF");
  });

  it("clears the vars and the cache record when the toggle turns off", () => {
    nativePlatform = true;
    installDom({ NomaDynamicColor: { getPaletteJson: () => PALETTE_JSON } });
    syncDynamicColor("dark", true);
    expect(style.props.size).toBe(5);
    expect(storage.getItem(DYNAMIC_COLOR_STORAGE_KEY)).not.toBeNull();

    syncDynamicColor("dark", false);

    expect(style.props.size).toBe(0);
    expect(storage.getItem(DYNAMIC_COLOR_STORAGE_KEY)).toBeNull();
  });

  it("applies nothing when the bridge reports unavailable", () => {
    nativePlatform = true;
    installDom({ NomaDynamicColor: { getPaletteJson: () => '{"available":false}' } });

    expect(isDynamicColorAvailable()).toBe(false);
    syncDynamicColor("dark", true);
    expect(style.props.size).toBe(0);
  });

  it("applies nothing and stays silent on a malformed bridge response", () => {
    nativePlatform = true;
    installDom({ NomaDynamicColor: { getPaletteJson: () => "<<<broken>>>" } });

    expect(isDynamicColorAvailable()).toBe(false);
    expect(() => syncDynamicColor("dark", true)).not.toThrow();
    expect(style.props.size).toBe(0);
  });

  it("swallows a throwing bridge", () => {
    nativePlatform = true;
    installDom({
      NomaDynamicColor: {
        getPaletteJson: () => {
          throw new Error("bridge exploded");
        },
      },
    });

    expect(isDynamicColorAvailable()).toBe(false);
    expect(() => syncDynamicColor("dark", true)).not.toThrow();
    expect(style.props.size).toBe(0);
  });

  it("applies nothing on web, even with a bridge object present", () => {
    installDom({ NomaDynamicColor: { getPaletteJson: () => PALETTE_JSON } });

    expect(isDynamicColorAvailable()).toBe(false);
    syncDynamicColor("dark", true);
    expect(style.props.size).toBe(0);
  });

  it("applies nothing on native when the bridge never registered", () => {
    nativePlatform = true;
    installDom({});

    expect(isDynamicColorAvailable()).toBe(false);
    expect(() => syncDynamicColor("dark", true)).not.toThrow();
    expect(style.props.size).toBe(0);
  });

  it("clearDynamicVars removes exactly the five inline properties", () => {
    installDom({});
    style.setProperty("--primary", "#123456");
    style.setProperty("--ring", "#123456");
    style.setProperty("--unrelated", "keep me");

    clearDynamicVars();

    expect(style.props.has("--primary")).toBe(false);
    expect(style.props.has("--ring")).toBe(false);
    expect(style.props.get("--unrelated")).toBe("keep me");
  });
});

describe("THEME_BOOTSTRAP_SCRIPT dynamic colour (native-feel #7)", () => {
  const toggles: Array<[string, boolean]> = [];

  function runBootstrap(options: { theme?: string; record?: string | null }) {
    toggles.length = 0;
    const bootStyle = new FakeStyle();
    const bootStorage = new FakeStorage();
    if (options.theme) bootStorage.setItem(THEME_STORAGE_KEY, options.theme);
    if (options.record) bootStorage.setItem(DYNAMIC_COLOR_STORAGE_KEY, options.record);
    const bootWindow = {
      matchMedia: (query: string) => ({ matches: false, media: query }),
    };
    const bootDocument = {
      documentElement: {
        classList: {
          toggle: (name: string, force: boolean) => {
            toggles.push([name, force]);
          },
        },
        style: bootStyle,
      },
    };
    const run = new Function("localStorage", "window", "document", THEME_BOOTSTRAP_SCRIPT);
    run(bootStorage, bootWindow, bootDocument);
    return bootStyle;
  }

  it("changes nothing when no cache record exists", () => {
    const bootStyle = runBootstrap({ theme: "dark" });
    expect(toggles).toContainEqual(["dark", true]);
    expect(bootStyle.props.size).toBe(0);
  });

  it("paints the cached dark map pre-frame when enabled and resolved dark", () => {
    const bootStyle = runBootstrap({
      theme: "dark",
      record: JSON.stringify(buildCacheRecord(PALETTE)),
    });
    expect(bootStyle.props.get("--primary")).toBe("#D0BCFF");
    expect(bootStyle.props.get("--accent-foreground")).toBe(FOREGROUND_ON_DARK);
    expect(bootStyle.props.size).toBe(5);
  });

  it("paints the cached light map when resolved light", () => {
    const bootStyle = runBootstrap({
      theme: "light",
      record: JSON.stringify(buildCacheRecord(PALETTE)),
    });
    expect(bootStyle.props.get("--primary")).toBe("#6750A4");
    expect(bootStyle.props.size).toBe(5);
  });

  it("applies nothing when the record says disabled", () => {
    const record = { ...buildCacheRecord(PALETTE), enabled: false };
    const bootStyle = runBootstrap({ theme: "dark", record: JSON.stringify(record) });
    expect(bootStyle.props.size).toBe(0);
  });

  it("survives a corrupt record — theme still applies, no vars, no throw", () => {
    const bootStyle = runBootstrap({ theme: "dark", record: "{corrupt" });
    expect(toggles).toContainEqual(["dark", true]);
    expect(bootStyle.props.size).toBe(0);
  });
});

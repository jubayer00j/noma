import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setStyle = vi.fn(async (_options: { style: string }) => {});
let nativePlatform = false;

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => nativePlatform },
}));

vi.mock("@capacitor/status-bar", () => ({
  StatusBar: { setStyle: (options: { style: string }) => setStyle(options) },
  Style: { Dark: "DARK", Light: "LIGHT", Default: "DEFAULT" },
}));

import {
  applySystemInsets,
  initSystemInsetsListener,
  parseSystemInsets,
  statusBarStyleFor,
  syncSystemBarsToTheme,
} from "./system-bars";

describe("statusBarStyleFor", () => {
  it("maps a light surface to dark bar content (Style.Light)", () => {
    expect(statusBarStyleFor("light")).toBe("LIGHT");
  });

  it("maps a dark surface to light bar content (Style.Dark)", () => {
    expect(statusBarStyleFor("dark")).toBe("DARK");
  });
});

describe("syncSystemBarsToTheme", () => {
  beforeEach(() => {
    setStyle.mockClear();
    setStyle.mockImplementation(async () => {});
    nativePlatform = false;
    // resolveTheme("system") reads window.matchMedia; no window in node.
    delete (globalThis as { window?: unknown }).window;
  });

  it("is a no-op off native platforms", () => {
    syncSystemBarsToTheme("dark");
    syncSystemBarsToTheme("light");
    expect(setStyle).not.toHaveBeenCalled();
  });

  it("sends Style.Light for the light and nature themes on native", () => {
    nativePlatform = true;
    syncSystemBarsToTheme("light");
    syncSystemBarsToTheme("nature");
    expect(setStyle).toHaveBeenCalledTimes(2);
    expect(setStyle).toHaveBeenNthCalledWith(1, { style: "LIGHT" });
    expect(setStyle).toHaveBeenNthCalledWith(2, { style: "LIGHT" });
  });

  it("sends Style.Dark for the dark and amoled themes on native", () => {
    nativePlatform = true;
    syncSystemBarsToTheme("dark");
    syncSystemBarsToTheme("amoled");
    expect(setStyle).toHaveBeenCalledTimes(2);
    expect(setStyle).toHaveBeenNthCalledWith(1, { style: "DARK" });
    expect(setStyle).toHaveBeenNthCalledWith(2, { style: "DARK" });
  });

  it("resolves the system choice from the OS colour scheme", () => {
    nativePlatform = true;
    (globalThis as { window?: unknown }).window = {
      matchMedia: (query: string) => ({ matches: query.includes("dark"), media: query }),
    };
    syncSystemBarsToTheme("system");
    expect(setStyle).toHaveBeenCalledWith({ style: "DARK" });

    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: false, media: "" }),
    };
    syncSystemBarsToTheme("system");
    expect(setStyle).toHaveBeenCalledWith({ style: "LIGHT" });
  });

  it("swallows plugin failures — bar appearance never breaks the app", async () => {
    nativePlatform = true;
    setStyle.mockImplementation(async () => {
      throw new Error("plugin unavailable");
    });
    expect(() => syncSystemBarsToTheme("dark")).not.toThrow();
    // Let the rejected promise settle; an unhandled rejection would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

describe("parseSystemInsets", () => {
  it("accepts a well-formed payload and rounds to whole CSS px", () => {
    expect(parseSystemInsets({ top: 24.4, bottom: 15.6 })).toEqual({ top: 24, bottom: 16 });
    expect(parseSystemInsets({ top: 0, bottom: 0 })).toEqual({ top: 0, bottom: 0 });
  });

  it("rejects malformed payloads instead of guessing", () => {
    expect(parseSystemInsets(null)).toBeNull();
    expect(parseSystemInsets(24)).toBeNull();
    expect(parseSystemInsets({ top: 24 })).toBeNull();
    expect(parseSystemInsets({ top: -1, bottom: 0 })).toBeNull();
    expect(parseSystemInsets({ top: "24", bottom: 0 })).toBeNull();
    expect(parseSystemInsets({ top: Number.NaN, bottom: 0 })).toBeNull();
  });
});

describe("system inset CSS vars", () => {
  const setProperty = vi.fn();

  beforeEach(() => {
    setProperty.mockClear();
    nativePlatform = false;
    (globalThis as { document?: unknown }).document = {
      documentElement: { style: { setProperty } },
    };
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
  });

  it("applySystemInsets writes both vars in px", () => {
    applySystemInsets({ top: 24, bottom: 16 });
    expect(setProperty).toHaveBeenCalledTimes(2);
    expect(setProperty).toHaveBeenCalledWith("--noma-inset-top", "24px");
    expect(setProperty).toHaveBeenCalledWith("--noma-inset-bottom", "16px");
  });

  it("initSystemInsetsListener is a no-op off native platforms", () => {
    const addEventListener = vi.fn();
    (globalThis as { window?: unknown }).window = { addEventListener };
    initSystemInsetsListener();
    expect(addEventListener).not.toHaveBeenCalled();
    expect(setProperty).not.toHaveBeenCalled();
  });

  it("on native it applies the bridge's last values, then follows events", () => {
    nativePlatform = true;
    let handler: ((event: unknown) => void) | undefined;
    const addEventListener = vi.fn((type: string, fn: (event: unknown) => void) => {
      if (type === "noma:system-insets") handler = fn;
    });
    (globalThis as { window?: unknown }).window = {
      addEventListener,
      NomaSystemInsets: { getTopCssPx: () => 28, getBottomCssPx: () => 14 },
    };
    initSystemInsetsListener();
    // Mount case: the shell dispatched long before the bundle booted,
    // so the bridge's stored values land first.
    expect(setProperty).toHaveBeenCalledWith("--noma-inset-top", "28px");
    expect(setProperty).toHaveBeenCalledWith("--noma-inset-bottom", "14px");
    expect(addEventListener).toHaveBeenCalledTimes(1);

    setProperty.mockClear();
    handler?.({ detail: { top: 24, bottom: 12 } });
    expect(setProperty).toHaveBeenCalledWith("--noma-inset-top", "24px");
    expect(setProperty).toHaveBeenCalledWith("--noma-inset-bottom", "12px");

    // A malformed event keeps the previous values.
    setProperty.mockClear();
    handler?.({ detail: { top: "oops", bottom: 12 } });
    expect(setProperty).not.toHaveBeenCalled();

    // Register-once: a second init adds no second listener.
    initSystemInsetsListener();
    expect(addEventListener).toHaveBeenCalledTimes(1);
  });
});

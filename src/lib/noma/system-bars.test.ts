import { beforeEach, describe, expect, it, vi } from "vitest";

const setStyle = vi.fn(async (_options: { style: string }) => {});
let nativePlatform = false;

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => nativePlatform },
}));

vi.mock("@capacitor/status-bar", () => ({
  StatusBar: { setStyle: (options: { style: string }) => setStyle(options) },
  Style: { Dark: "DARK", Light: "LIGHT", Default: "DEFAULT" },
}));

import { statusBarStyleFor, syncSystemBarsToTheme } from "./system-bars";

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

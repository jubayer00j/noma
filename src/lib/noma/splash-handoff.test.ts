import { beforeEach, describe, expect, it, vi } from "vitest";

let nativePlatform = false;

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => nativePlatform },
}));

// The module under test keeps a single-fire flag in module state, so
// every test loads a fresh copy (vi.resetModules + dynamic import).
async function loadModule() {
  return import("./splash-handoff");
}

function setWindow(value: unknown) {
  (globalThis as { window?: unknown }).window = value;
}

describe("splash handoff bridge (native-feel #5)", () => {
  beforeEach(() => {
    vi.resetModules();
    nativePlatform = false;
    delete (globalThis as { window?: unknown }).window;
  });

  it("signals the native bridge exactly once on native, however often it is called", async () => {
    nativePlatform = true;
    const ready = vi.fn();
    setWindow({ NomaSplash: { ready } });
    const { signalSplashReady } = await loadModule();

    signalSplashReady();
    signalSplashReady();
    signalSplashReady();

    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("never signals off native platforms, even with a bridge object present", async () => {
    const ready = vi.fn();
    setWindow({ NomaSplash: { ready } });
    const { signalSplashReady } = await loadModule();

    signalSplashReady();

    expect(ready).not.toHaveBeenCalled();
  });

  it("swallows a missing bridge object — the native fallback dismisses the splash", async () => {
    nativePlatform = true;
    setWindow({});
    const { signalSplashReady } = await loadModule();

    expect(() => signalSplashReady()).not.toThrow();
  });

  it("swallows a missing window entirely (non-browser test environments)", async () => {
    nativePlatform = true;
    const { signalSplashReady } = await loadModule();

    expect(() => signalSplashReady()).not.toThrow();
  });

  it("swallows a throwing bridge, and does not retry it on later calls", async () => {
    nativePlatform = true;
    const ready = vi.fn(() => {
      throw new Error("bridge exploded");
    });
    setWindow({ NomaSplash: { ready } });
    const { signalSplashReady } = await loadModule();

    expect(() => signalSplashReady()).not.toThrow();
    expect(() => signalSplashReady()).not.toThrow();
    expect(ready).toHaveBeenCalledTimes(1);
  });
});

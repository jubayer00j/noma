// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechEngine, SpeechProbe } from "@/lib/noma/speech";
import { VoiceSection } from "./voice-section";

const probeState = vi.hoisted(() => ({
  current: { available: false, onDevice: false } as SpeechProbe,
}));

vi.mock("@/hooks/use-noma", () => ({
  useSettings: () => ({
    settings: { speechLanguage: "system" },
    update: vi.fn(),
  }),
}));

vi.mock("@/lib/noma/speech", () => ({
  defaultSpeechEngine: (): SpeechEngine =>
    ({
      probe: async () => probeState.current,
    }) as SpeechEngine,
}));

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderSection(probe: SpeechProbe) {
  probeState.current = probe;
  await act(async () => {
    root.render(<VoiceSection />);
  });
  // Flush the probe promise + the state update it drives.
  await act(async () => undefined);
}

describe("VoiceSection availability copy", () => {
  it("names the disabled speech service instead of the generic line", async () => {
    await renderSection({
      available: false,
      onDevice: false,
      reason: "service-disabled",
      serviceApp: "Google",
    });
    expect(container.textContent).toContain("— Google —");
    expect(container.textContent).toContain("disabled, so dictation can't run");
    expect(container.textContent).not.toContain("No speech recogniser is available");
  });

  it("falls back to the generic line when no reason is reported", async () => {
    await renderSection({ available: false, onDevice: false });
    expect(container.textContent).toContain("No speech recogniser is available");
  });

  it("shows the platform disclosure when a recogniser is available", async () => {
    await renderSection({ available: true, onDevice: false });
    expect(container.textContent).toContain("recognised by your device's speech service");
  });
});

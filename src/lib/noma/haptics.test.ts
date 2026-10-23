import { beforeEach, describe, expect, it, vi } from "vitest";

const impact = vi.fn(async (_options: { style: string }) => {});
const notification = vi.fn(async (_options: { type: string }) => {});
let nativePlatform = false;

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => nativePlatform },
}));

vi.mock("@capacitor/haptics", () => ({
  Haptics: {
    impact: (options: { style: string }) => impact(options),
    notification: (options: { type: string }) => notification(options),
  },
  ImpactStyle: { Heavy: "HEAVY", Medium: "MEDIUM", Light: "LIGHT" },
  NotificationType: { Success: "SUCCESS", Warning: "WARNING", Error: "ERROR" },
}));

import {
  hapticSwipeArmed,
  hapticSwipeCommit,
  hapticUnlockFailure,
  hapticUnlockSuccess,
  setHapticsEnabled,
} from "./haptics";

function fireEverything() {
  hapticSwipeArmed();
  hapticSwipeCommit("pin");
  hapticSwipeCommit("restore");
  hapticSwipeCommit("trash");
  hapticSwipeCommit("deleteForever");
  hapticUnlockSuccess();
  hapticUnlockFailure();
}

describe("haptics bridge (native-feel #4)", () => {
  beforeEach(() => {
    impact.mockClear();
    notification.mockClear();
    impact.mockImplementation(async () => {});
    notification.mockImplementation(async () => {});
    nativePlatform = false;
    setHapticsEnabled(true);
  });

  it("is a no-op off native platforms, even when enabled", () => {
    fireEverything();
    expect(impact).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
  });

  it("maps the swipe vocabulary: armed tick and pin/restore are Light, trash is Medium", () => {
    nativePlatform = true;
    hapticSwipeArmed();
    hapticSwipeCommit("pin");
    hapticSwipeCommit("restore");
    hapticSwipeCommit("trash");
    expect(impact).toHaveBeenCalledTimes(4);
    expect(impact).toHaveBeenNthCalledWith(1, { style: "LIGHT" });
    expect(impact).toHaveBeenNthCalledWith(2, { style: "LIGHT" });
    expect(impact).toHaveBeenNthCalledWith(3, { style: "LIGHT" });
    expect(impact).toHaveBeenNthCalledWith(4, { style: "MEDIUM" });
    expect(notification).not.toHaveBeenCalled();
  });

  it("keeps delete-forever silent — its swipe only opens the confirmation dialog", () => {
    nativePlatform = true;
    hapticSwipeCommit("deleteForever");
    expect(impact).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
  });

  it("maps unlock outcomes to the Success and Warning notification types", () => {
    nativePlatform = true;
    hapticUnlockSuccess();
    hapticUnlockFailure();
    expect(notification).toHaveBeenCalledTimes(2);
    expect(notification).toHaveBeenNthCalledWith(1, { type: "SUCCESS" });
    expect(notification).toHaveBeenNthCalledWith(2, { type: "WARNING" });
    expect(impact).not.toHaveBeenCalled();
  });

  it("the enabled mirror gates everything, and re-enabling restores feedback", () => {
    nativePlatform = true;
    setHapticsEnabled(false);
    fireEverything();
    expect(impact).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();

    setHapticsEnabled(true);
    hapticUnlockSuccess();
    expect(notification).toHaveBeenCalledTimes(1);
  });

  it("swallows plugin rejections — feedback never breaks the action it decorates", async () => {
    nativePlatform = true;
    impact.mockImplementation(async () => {
      throw new Error("plugin unavailable");
    });
    notification.mockImplementation(async () => {
      throw new Error("plugin unavailable");
    });
    expect(() => fireEverything()).not.toThrow();
    // Let the rejected promises settle; an unhandled rejection would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("swallows a synchronously throwing plugin too", () => {
    nativePlatform = true;
    impact.mockImplementation((() => {
      throw new Error("sync failure");
    }) as never);
    expect(() => hapticSwipeCommit("trash")).not.toThrow();
    expect(() => hapticSwipeArmed()).not.toThrow();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dismissTopOverlay,
  hasOpenOverlay,
  openOverlayCount,
  registerOverlay,
  resetOverlayRegistry,
} from "./overlay-registry";
import {
  getSettingsBackHandler,
  getWorkspaceBackHandler,
  handleSystemBackPress,
  hasSettingsSubScreen,
  isWorkspaceRoute,
  registerSettingsBackHandler,
  registerWorkspaceBackHandler,
  resolveSystemBackAction,
  resolveWorkspaceBackStep,
  type SystemBackEffects,
  type WorkspaceBackState,
} from "./system-back";

function makeEffects(): SystemBackEffects {
  return {
    dismissOverlay: vi.fn(),
    minimizeApp: vi.fn(),
    navigateToWorkspace: vi.fn(),
  };
}

const CLOSED: WorkspaceBackState = {
  lockDialogOpen: false,
  aiDialogOpen: false,
  versionHistoryOpen: false,
  reminderOpen: false,
  confirmationOpen: false,
  promptOpen: false,
  searchOpen: false,
  activeNoteId: null,
  noteMode: "read",
  askOpen: false,
};

afterEach(() => {
  resetOverlayRegistry();
  registerWorkspaceBackHandler(() => false)();
});

describe("resolveSystemBackAction — coordinator priority", () => {
  it("overlay beats every other layer", () => {
    expect(
      resolveSystemBackAction({ overlayOpen: true, locked: true, pathname: "/settings" }),
    ).toBe("dismiss-overlay");
    expect(resolveSystemBackAction({ overlayOpen: true, locked: false, pathname: "/" })).toBe(
      "dismiss-overlay",
    );
    expect(resolveSystemBackAction({ overlayOpen: true, locked: false, pathname: "/signin" })).toBe(
      "dismiss-overlay",
    );
  });

  it("lock screen minimizes from any route", () => {
    for (const pathname of ["/", "/app", "/settings", "/account", "/share-target", "/signin"]) {
      expect(resolveSystemBackAction({ overlayOpen: false, locked: true, pathname })).toBe(
        "minimize",
      );
    }
  });

  it("signin minimizes (no in-app destination)", () => {
    expect(
      resolveSystemBackAction({ overlayOpen: false, locked: false, pathname: "/signin" }),
    ).toBe("minimize");
  });

  it("workspace routes consult the workspace chain", () => {
    expect(resolveSystemBackAction({ overlayOpen: false, locked: false, pathname: "/" })).toBe(
      "workspace-chain",
    );
    expect(resolveSystemBackAction({ overlayOpen: false, locked: false, pathname: "/app" })).toBe(
      "workspace-chain",
    );
  });

  it("secondary routes navigate to the workspace", () => {
    for (const pathname of ["/settings", "/account", "/share-target", "/contact"]) {
      expect(resolveSystemBackAction({ overlayOpen: false, locked: false, pathname })).toBe(
        "navigate-workspace",
      );
    }
  });

  it("normalises a trailing slash", () => {
    expect(
      resolveSystemBackAction({ overlayOpen: false, locked: false, pathname: "/settings/" }),
    ).toBe("navigate-workspace");
    expect(isWorkspaceRoute("/")).toBe(true);
    expect(isWorkspaceRoute("/app")).toBe(true);
    expect(isWorkspaceRoute("/settings")).toBe(false);
  });
});

describe("handleSystemBackPress — execution", () => {
  it("dismisses the overlay and touches nothing else", () => {
    const effects = makeEffects();
    const action = handleSystemBackPress(
      { overlayOpen: true, locked: false, pathname: "/settings" },
      effects,
    );
    expect(action).toBe("dismiss-overlay");
    expect(effects.dismissOverlay).toHaveBeenCalledTimes(1);
    expect(effects.minimizeApp).not.toHaveBeenCalled();
    expect(effects.navigateToWorkspace).not.toHaveBeenCalled();
  });

  it("minimizes when locked, even on a workspace route", () => {
    const chain = vi.fn(() => true);
    registerWorkspaceBackHandler(chain);
    const effects = makeEffects();
    handleSystemBackPress({ overlayOpen: false, locked: true, pathname: "/" }, effects);
    expect(effects.minimizeApp).toHaveBeenCalledTimes(1);
    expect(chain).not.toHaveBeenCalled();
  });

  it("minimizes on signin without consulting the chain", () => {
    const chain = vi.fn(() => true);
    registerWorkspaceBackHandler(chain);
    const effects = makeEffects();
    handleSystemBackPress({ overlayOpen: false, locked: false, pathname: "/signin" }, effects);
    expect(effects.minimizeApp).toHaveBeenCalledTimes(1);
    expect(chain).not.toHaveBeenCalled();
  });

  it("navigates from settings to the workspace", () => {
    const effects = makeEffects();
    const action = handleSystemBackPress(
      { overlayOpen: false, locked: false, pathname: "/settings" },
      effects,
    );
    expect(action).toBe("navigate-workspace");
    expect(effects.navigateToWorkspace).toHaveBeenCalledTimes(1);
    expect(effects.minimizeApp).not.toHaveBeenCalled();
  });

  it("runs the workspace chain on a workspace route and stops when it consumes", () => {
    const chain = vi.fn(() => true);
    registerWorkspaceBackHandler(chain);
    const effects = makeEffects();
    handleSystemBackPress({ overlayOpen: false, locked: false, pathname: "/" }, effects);
    expect(chain).toHaveBeenCalledTimes(1);
    expect(effects.minimizeApp).not.toHaveBeenCalled();
  });

  it("falls through to minimize when the chain declines", () => {
    registerWorkspaceBackHandler(() => false);
    const effects = makeEffects();
    handleSystemBackPress({ overlayOpen: false, locked: false, pathname: "/app" }, effects);
    expect(effects.minimizeApp).toHaveBeenCalledTimes(1);
  });

  it("falls through to minimize when no workspace is registered", () => {
    expect(getWorkspaceBackHandler()).toBeNull();
    const effects = makeEffects();
    handleSystemBackPress({ overlayOpen: false, locked: false, pathname: "/" }, effects);
    expect(effects.minimizeApp).toHaveBeenCalledTimes(1);
  });

  it("unregistering clears only the caller's own handler", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const unregisterFirst = registerWorkspaceBackHandler(first);
    registerWorkspaceBackHandler(second);
    unregisterFirst();
    expect(getWorkspaceBackHandler()).toBe(second);
  });
});

describe("settings sub-screen step (settings restructure)", () => {
  afterEach(() => {
    registerSettingsBackHandler(() => false)();
  });

  it("resolves to the sub-screen step on /settings when one is open", () => {
    expect(
      resolveSystemBackAction({
        overlayOpen: false,
        locked: false,
        pathname: "/settings",
        settingsSubScreenOpen: true,
      }),
    ).toBe("settings-sub-screen");
    expect(
      resolveSystemBackAction({
        overlayOpen: false,
        locked: false,
        pathname: "/settings/",
        settingsSubScreenOpen: true,
      }),
    ).toBe("settings-sub-screen");
  });

  it("without a sub-screen, /settings still leaves for the workspace", () => {
    expect(
      resolveSystemBackAction({
        overlayOpen: false,
        locked: false,
        pathname: "/settings",
        settingsSubScreenOpen: false,
      }),
    ).toBe("navigate-workspace");
    expect(
      resolveSystemBackAction({ overlayOpen: false, locked: false, pathname: "/settings" }),
    ).toBe("navigate-workspace");
  });

  it("the flag is ignored on other routes", () => {
    expect(
      resolveSystemBackAction({
        overlayOpen: false,
        locked: false,
        pathname: "/account",
        settingsSubScreenOpen: true,
      }),
    ).toBe("navigate-workspace");
    expect(
      resolveSystemBackAction({
        overlayOpen: false,
        locked: false,
        pathname: "/",
        settingsSubScreenOpen: true,
      }),
    ).toBe("workspace-chain");
  });

  it("dialog over a sub-screen wins: overlay layer beats the sub-screen step", () => {
    expect(
      resolveSystemBackAction({
        overlayOpen: true,
        locked: false,
        pathname: "/settings",
        settingsSubScreenOpen: true,
      }),
    ).toBe("dismiss-overlay");
  });

  it("the lock layer beats the sub-screen step", () => {
    expect(
      resolveSystemBackAction({
        overlayOpen: false,
        locked: true,
        pathname: "/settings",
        settingsSubScreenOpen: true,
      }),
    ).toBe("minimize");
  });

  it("a press runs the registered handler and navigates nowhere when it consumes", () => {
    const handler = vi.fn(() => true);
    registerSettingsBackHandler(handler);
    const effects = makeEffects();
    const action = handleSystemBackPress(
      { overlayOpen: false, locked: false, pathname: "/settings", settingsSubScreenOpen: true },
      effects,
    );
    expect(action).toBe("settings-sub-screen");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(effects.navigateToWorkspace).not.toHaveBeenCalled();
    expect(effects.minimizeApp).not.toHaveBeenCalled();
  });

  it("falls through to navigate-workspace when the handler declines", () => {
    registerSettingsBackHandler(() => false);
    const effects = makeEffects();
    handleSystemBackPress(
      { overlayOpen: false, locked: false, pathname: "/settings", settingsSubScreenOpen: true },
      effects,
    );
    expect(effects.navigateToWorkspace).toHaveBeenCalledTimes(1);
  });

  it("registration is a single slot and unregister clears only its own handler", () => {
    expect(hasSettingsSubScreen()).toBe(false);
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const unregisterFirst = registerSettingsBackHandler(first);
    registerSettingsBackHandler(second);
    unregisterFirst();
    expect(getSettingsBackHandler()).toBe(second);
    expect(hasSettingsSubScreen()).toBe(true);
  });
});

describe("overlay registry", () => {
  it("starts empty and dismiss is a no-op", () => {
    expect(hasOpenOverlay()).toBe(false);
    expect(dismissTopOverlay()).toBe(false);
  });

  it("registers, counts and unregisters", () => {
    const unregister = registerOverlay(vi.fn());
    expect(hasOpenOverlay()).toBe(true);
    expect(openOverlayCount()).toBe(1);
    unregister();
    expect(hasOpenOverlay()).toBe(false);
    expect(openOverlayCount()).toBe(0);
  });

  it("dismisses the most recently opened overlay first", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerOverlay(first);
    registerOverlay(second);
    expect(dismissTopOverlay()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("an open overlay consumes a press before the workspace chain", () => {
    const dismiss = vi.fn();
    registerOverlay(dismiss);
    registerWorkspaceBackHandler(() => true);
    const effects = makeEffects();
    effects.dismissOverlay = vi.fn(() => {
      dismissTopOverlay();
    });
    handleSystemBackPress({ overlayOpen: hasOpenOverlay(), locked: false, pathname: "/" }, effects);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(effects.minimizeApp).not.toHaveBeenCalled();
    expect(effects.navigateToWorkspace).not.toHaveBeenCalled();
  });
});

describe("resolveWorkspaceBackStep — extended chain order", () => {
  it("returns null when nothing is open", () => {
    expect(resolveWorkspaceBackStep(CLOSED)).toBeNull();
  });

  it("lock dialog leads the chain", () => {
    expect(resolveWorkspaceBackStep({ ...CLOSED, lockDialogOpen: true })).toBe("lock-dialog");
    expect(
      resolveWorkspaceBackStep({
        ...CLOSED,
        lockDialogOpen: true,
        aiDialogOpen: true,
        versionHistoryOpen: true,
        activeNoteId: "n1",
      }),
    ).toBe("lock-dialog");
  });

  it("AI dialog follows the lock dialog", () => {
    expect(resolveWorkspaceBackStep({ ...CLOSED, aiDialogOpen: true })).toBe("ai-dialog");
    expect(
      resolveWorkspaceBackStep({ ...CLOSED, aiDialogOpen: true, versionHistoryOpen: true }),
    ).toBe("ai-dialog");
  });

  // Regression: the pre-existing seven layers keep their exact order.
  it("preserves the original order below the new dialog layers", () => {
    const all: WorkspaceBackState = {
      ...CLOSED,
      versionHistoryOpen: true,
      reminderOpen: true,
      confirmationOpen: true,
      promptOpen: true,
      searchOpen: true,
      activeNoteId: "n1",
      noteMode: "edit",
    };
    expect(resolveWorkspaceBackStep(all)).toBe("version-history");
    expect(resolveWorkspaceBackStep({ ...all, versionHistoryOpen: false })).toBe("reminder");
    expect(
      resolveWorkspaceBackStep({ ...all, versionHistoryOpen: false, reminderOpen: false }),
    ).toBe("confirmation");
    expect(
      resolveWorkspaceBackStep({
        ...all,
        versionHistoryOpen: false,
        reminderOpen: false,
        confirmationOpen: false,
      }),
    ).toBe("prompt");
    expect(
      resolveWorkspaceBackStep({
        ...all,
        versionHistoryOpen: false,
        reminderOpen: false,
        confirmationOpen: false,
        promptOpen: false,
      }),
    ).toBe("search");
    expect(
      resolveWorkspaceBackStep({
        ...all,
        versionHistoryOpen: false,
        reminderOpen: false,
        confirmationOpen: false,
        promptOpen: false,
        searchOpen: false,
      }),
    ).toBe("editor");
    expect(
      resolveWorkspaceBackStep({
        ...all,
        versionHistoryOpen: false,
        reminderOpen: false,
        confirmationOpen: false,
        promptOpen: false,
        searchOpen: false,
        noteMode: "read",
      }),
    ).toBe("note");
  });

  it("editor only in edit mode; read mode closes the note", () => {
    expect(resolveWorkspaceBackStep({ ...CLOSED, activeNoteId: "n1", noteMode: "edit" })).toBe(
      "editor",
    );
    expect(resolveWorkspaceBackStep({ ...CLOSED, activeNoteId: "n1", noteMode: "read" })).toBe(
      "note",
    );
  });

  // Ask Noma sits under an open note but above the list: a note opened
  // from a source card backs out to Ask first, Ask backs out to the list.
  it("ask resolves after the note steps and before falling through", () => {
    expect(resolveWorkspaceBackStep({ ...CLOSED, askOpen: true })).toBe("ask");
    expect(
      resolveWorkspaceBackStep({ ...CLOSED, askOpen: true, activeNoteId: "n1", noteMode: "read" }),
    ).toBe("note");
    expect(
      resolveWorkspaceBackStep({ ...CLOSED, askOpen: true, activeNoteId: "n1", noteMode: "edit" }),
    ).toBe("editor");
    expect(resolveWorkspaceBackStep({ ...CLOSED, askOpen: true, searchOpen: true })).toBe("search");
  });
});

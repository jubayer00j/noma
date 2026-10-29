// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  attachCaretAboveKeyboard,
  caretScrollDeltaPx,
  CARET_MARGIN_PX,
  effectiveKeyboardHeightPx,
  effectiveVisibleBottomPx,
  keyboardHeightPx,
  NATIVE_IME_EVENT,
  subscribeKeyboardInset,
  visibleBottomPx,
  type VisualViewportLike,
} from "./keyboard-scroll";

/* Caret-above-keyboard: pure helpers pinned, wiring driven with a fake
 * visualViewport (jsdom ships none). */

describe("keyboardHeightPx", () => {
  it("keyboard open: layout height minus visual height", () => {
    expect(keyboardHeightPx(800, { height: 500, offsetTop: 0 })).toBe(300);
  });

  it("no keyboard: equal heights", () => {
    expect(keyboardHeightPx(800, { height: 800, offsetTop: 0 })).toBe(0);
  });

  it("small delta is chrome/pinch noise, not a keyboard", () => {
    expect(keyboardHeightPx(800, { height: 750, offsetTop: 0 })).toBe(0);
    expect(keyboardHeightPx(800, { height: 701, offsetTop: 0 })).toBe(0);
  });

  it("exactly at the threshold counts as a keyboard", () => {
    expect(keyboardHeightPx(800, { height: 700, offsetTop: 0 })).toBe(100);
  });
});

describe("visibleBottomPx", () => {
  it("height plus offsetTop", () => {
    expect(visibleBottomPx({ height: 500, offsetTop: 40 })).toBe(540);
  });
});

describe("caretScrollDeltaPx", () => {
  it("caret below the visible bottom scrolls by the overlap plus margin", () => {
    expect(caretScrollDeltaPx(520, 500)).toBe(20 + CARET_MARGIN_PX);
  });

  it("caret already visible never scrolls", () => {
    expect(caretScrollDeltaPx(400, 500)).toBe(0);
    expect(caretScrollDeltaPx(500 - CARET_MARGIN_PX, 500)).toBe(0);
  });
});

describe("effectiveKeyboardHeightPx", () => {
  it("native height wins when the viewport never shrinks (installed app)", () => {
    expect(effectiveKeyboardHeightPx(300, 0)).toBe(300);
  });

  it("visualViewport delta wins on web, where native never fires", () => {
    expect(effectiveKeyboardHeightPx(0, 300)).toBe(300);
  });

  it("larger of the two wins if both ever report", () => {
    expect(effectiveKeyboardHeightPx(200, 300)).toBe(300);
    expect(effectiveKeyboardHeightPx(300, 200)).toBe(300);
  });

  it("zero when neither reports", () => {
    expect(effectiveKeyboardHeightPx(0, 0)).toBe(0);
  });
});

describe("effectiveVisibleBottomPx", () => {
  it("native height: layout height minus the keyboard (viewport stays full)", () => {
    expect(effectiveVisibleBottomPx(800, 300, { height: 800, offsetTop: 0 })).toBe(500);
  });

  it("no native height: the visual-viewport bottom (web path)", () => {
    expect(effectiveVisibleBottomPx(800, 0, { height: 500, offsetTop: 0 })).toBe(500);
  });
});

describe("native IME height (installed app)", () => {
  it("a native event reserves room and scrolls the caret above the keyboard even with a full-height viewport", async () => {
    const viewport = fakeViewport(800);
    const scroller = document.createElement("div");
    const handlers: Record<string, Array<() => void>> = {};
    const editor = {
      state: { selection: { from: 0 } },
      view: { coordsAtPos: () => ({ bottom: 900 - scroller.scrollTop }) },
      isFocused: true,
      on: (event: string, fn: () => void) => {
        (handlers[event] ??= []).push(fn);
      },
      off: (event: string, fn: () => void) => {
        handlers[event] = (handlers[event] ?? []).filter((f) => f !== fn);
      },
    } as never;
    const cleanup = attachCaretAboveKeyboard(editor, scroller, {
      getViewport: () => viewport,
      getLayoutHeight: () => 800,
    });
    await flush();
    expect(scroller.style.paddingBottom).toBe("");

    window.dispatchEvent(new CustomEvent(NATIVE_IME_EVENT, { detail: 300 }));
    await flush();
    // Real bottom room, not just scroll-padding: the last line must
    // have somewhere to scroll into.
    expect(scroller.style.scrollPaddingBottom).toBe("300px");
    expect(scroller.style.paddingBottom).toBe("300px");
    // Visible bottom is 800 - 300 = 500; caret at 900 scrolls by 416.
    expect(scroller.scrollTop).toBe(416);

    // Keyboard closes: the event carries 0, room is removed.
    window.dispatchEvent(new CustomEvent(NATIVE_IME_EVENT, { detail: 0 }));
    await flush();
    expect(scroller.style.scrollPaddingBottom).toBe("");
    expect(scroller.style.paddingBottom).toBe("");

    cleanup();
  });

  it("a bridge value present at mount covers the keyboard-already-open case", async () => {
    const viewport = fakeViewport(800);
    const { editor } = fakeEditor(100);
    const scroller = document.createElement("div");
    (window as unknown as { NomaIme?: { getHeightCssPx: () => number } }).NomaIme = {
      getHeightCssPx: () => 250,
    };
    try {
      const cleanup = attachCaretAboveKeyboard(editor, scroller, {
        getViewport: () => viewport,
        getLayoutHeight: () => 800,
      });
      await flush();
      expect(scroller.style.scrollPaddingBottom).toBe("250px");
      expect(scroller.style.paddingBottom).toBe("250px");
      cleanup();
      expect(scroller.style.scrollPaddingBottom).toBe("");
      expect(scroller.style.paddingBottom).toBe("");
    } finally {
      delete (window as unknown as { NomaIme?: unknown }).NomaIme;
    }
  });

  it("a non-numeric native detail is treated as closed, never as a height", async () => {
    const viewport = fakeViewport(800);
    const { editor } = fakeEditor(100);
    const scroller = document.createElement("div");
    const cleanup = attachCaretAboveKeyboard(editor, scroller, {
      getViewport: () => viewport,
      getLayoutHeight: () => 800,
    });
    window.dispatchEvent(new CustomEvent(NATIVE_IME_EVENT, { detail: "300" as never }));
    await flush();
    expect(scroller.style.paddingBottom).toBe("");
    cleanup();
  });
});

function fakeViewport(height: number): VisualViewportLike & {
  emit: (type: string) => void;
  listeners: Record<string, Array<() => void>>;
} {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    height,
    offsetTop: 0,
    listeners,
    addEventListener: (type, fn) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type, fn) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    emit: (type) => {
      for (const fn of listeners[type] ?? []) fn();
    },
  };
}

function fakeEditor(caretBottom: number, focused = true) {
  const handlers: Record<string, Array<() => void>> = {};
  return {
    editor: {
      state: { selection: { from: 0 } },
      view: { coordsAtPos: () => ({ bottom: caretBottom }) },
      isFocused: focused,
      on: (event: string, fn: () => void) => {
        (handlers[event] ??= []).push(fn);
      },
      off: (event: string, fn: () => void) => {
        handlers[event] = (handlers[event] ?? []).filter((f) => f !== fn);
      },
    } as never,
    handlers,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("attachCaretAboveKeyboard", () => {
  it("reserves keyboard height on the scroller when the viewport shrinks, clears on restore", async () => {
    const viewport = fakeViewport(800);
    const { editor } = fakeEditor(100);
    const scroller = document.createElement("div");
    const cleanup = attachCaretAboveKeyboard(editor, scroller, {
      getViewport: () => viewport,
      getLayoutHeight: () => 800,
    });
    await flush();
    expect(scroller.style.scrollPaddingBottom).toBe("");

    viewport.height = 500;
    viewport.emit("resize");
    await flush();
    expect(scroller.style.scrollPaddingBottom).toBe("300px");

    viewport.height = 800;
    viewport.emit("resize");
    await flush();
    expect(scroller.style.scrollPaddingBottom).toBe("");

    cleanup();
    expect(scroller.style.scrollPaddingBottom).toBe("");
  });

  it("scrolls the scroller only when the caret sits below the visible bottom", async () => {
    const viewport = fakeViewport(500);
    const scroller = document.createElement("div");
    const handlers: Record<string, Array<() => void>> = {};
    // Like a real browser, the caret's viewport position moves up as the
    // scroller scrolls — so a second pass after the first scroll must be a
    // no-op, proving the wiring never fights its own scroll.
    const editor = {
      state: { selection: { from: 0 } },
      view: { coordsAtPos: () => ({ bottom: 520 - scroller.scrollTop }) },
      isFocused: true,
      on: (event: string, fn: () => void) => {
        (handlers[event] ??= []).push(fn);
      },
      off: (event: string, fn: () => void) => {
        handlers[event] = (handlers[event] ?? []).filter((f) => f !== fn);
      },
    } as never;
    attachCaretAboveKeyboard(editor, scroller, {
      getViewport: () => viewport,
      getLayoutHeight: () => 800,
    });
    await flush();
    // Initial pass scrolled by the overlap (520 + 16 - 500).
    expect(scroller.scrollTop).toBe(36);

    // A selection update with the caret now visible must not move anything.
    handlers["selectionUpdate"]?.forEach((fn) => fn());
    await flush();
    expect(scroller.scrollTop).toBe(36);
  });

  it("never scrolls when the editor is not focused", async () => {
    const viewport = fakeViewport(500);
    const { editor } = fakeEditor(900, false);
    const scroller = document.createElement("div");
    attachCaretAboveKeyboard(editor, scroller, {
      getViewport: () => viewport,
      getLayoutHeight: () => 800,
    });
    await flush();
    expect(scroller.scrollTop).toBe(0);
    // Padding still tracks the keyboard: the browser-driven path stays armed.
    expect(scroller.style.scrollPaddingBottom).toBe("300px");
  });

  it("no visualViewport means no listeners, no crash, no padding", async () => {
    const { editor } = fakeEditor(900);
    const scroller = document.createElement("div");
    const cleanup = attachCaretAboveKeyboard(editor, scroller, {
      getViewport: () => null,
      getLayoutHeight: () => 800,
    });
    await flush();
    expect(scroller.style.scrollPaddingBottom).toBe("");
    expect(scroller.scrollTop).toBe(0);
    cleanup();
  });
});

describe("subscribeKeyboardInset", () => {
  it("reports the native IME height as it opens and closes, without repeats", async () => {
    const seen: number[] = [];
    const unsubscribe = subscribeKeyboardInset((h) => seen.push(h), {
      getViewport: () => fakeViewport(800),
      getLayoutHeight: () => 800,
    });
    // Synchronous first report: no keyboard.
    expect(seen).toEqual([0]);

    window.dispatchEvent(new CustomEvent(NATIVE_IME_EVENT, { detail: 300 }));
    await flush();
    expect(seen).toEqual([0, 300]);

    // The same height again is not re-reported.
    window.dispatchEvent(new CustomEvent(NATIVE_IME_EVENT, { detail: 300 }));
    await flush();
    expect(seen).toEqual([0, 300]);

    window.dispatchEvent(new CustomEvent(NATIVE_IME_EVENT, { detail: 0 }));
    await flush();
    expect(seen).toEqual([0, 300, 0]);

    // After unsubscribe, further events change nothing.
    unsubscribe();
    window.dispatchEvent(new CustomEvent(NATIVE_IME_EVENT, { detail: 280 }));
    await flush();
    expect(seen).toEqual([0, 300, 0]);
  });

  it("falls back to the visual-viewport shrink on web", async () => {
    const viewport = fakeViewport(800);
    const seen: number[] = [];
    const unsubscribe = subscribeKeyboardInset((h) => seen.push(h), {
      getViewport: () => viewport,
      getLayoutHeight: () => 800,
    });
    expect(seen).toEqual([0]);
    viewport.height = 500;
    viewport.emit("resize");
    await flush();
    expect(seen).toEqual([0, 300]);
    unsubscribe();
  });

  it("reads the bridge at subscribe time for the keyboard-already-open case", () => {
    (window as unknown as { NomaIme?: { getHeightCssPx: () => number } }).NomaIme = {
      getHeightCssPx: () => 250,
    };
    try {
      const seen: number[] = [];
      const unsubscribe = subscribeKeyboardInset((h) => seen.push(h), {
        getViewport: () => fakeViewport(800),
        getLayoutHeight: () => 800,
      });
      expect(seen).toEqual([250]);
      unsubscribe();
    } finally {
      delete (window as unknown as { NomaIme?: unknown }).NomaIme;
    }
  });
});

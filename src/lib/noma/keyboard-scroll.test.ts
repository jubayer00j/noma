// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  attachCaretAboveKeyboard,
  caretScrollDeltaPx,
  CARET_MARGIN_PX,
  keyboardHeightPx,
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

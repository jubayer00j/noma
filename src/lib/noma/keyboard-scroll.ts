import type { Editor } from "@tiptap/react";

/**
 * Caret-above-keyboard (Android WebView): typing in a long note used to slide
 * the current line underneath the on-screen keyboard, because nothing in the
 * app watched the visual viewport. ProseMirror's built-in scroll-the-selection
 * -into-view measures against the layout viewport, which does not shrink the
 * way the visual viewport does when the keyboard opens — so by its math the
 * caret was "visible" while it sat behind the keyboard (the PR #76 residual:
 * its spec left this as a verify-on-device item).
 *
 * This module keeps the caret above the keyboard in two ways:
 *  1. it reserves the keyboard height as `scroll-padding-bottom` on the note
 *     surface, so any browser-driven scrolling respects the keyboard, and
 *  2. on every selection/transaction and every visual-viewport change it
 *     scrolls the note surface by exactly the overlap when the caret rect
 *     sits below the visible bottom. It never scrolls otherwise, so a manual
 *     scroll is never fought.
 *
 * Pure helpers are unit-tested; the DOM wiring takes injectable viewport
 * getters so tests can drive it with a fake visualViewport (jsdom has none).
 */

/** A viewport shrink smaller than this is chrome/pinch noise, not a keyboard. */
export const KEYBOARD_MIN_HEIGHT_PX = 100;

/** Breathing room kept between the caret line and the top of the keyboard. */
export const CARET_MARGIN_PX = 16;

export interface VisualViewportSnapshot {
  height: number;
  offsetTop: number;
}

export interface VisualViewportLike extends VisualViewportSnapshot {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/** Keyboard height: layout height minus visual-viewport height, clamped at 0. */
export function keyboardHeightPx(
  layoutHeight: number,
  viewport: VisualViewportSnapshot,
): number {
  const delta = layoutHeight - viewport.height;
  return delta >= KEYBOARD_MIN_HEIGHT_PX ? delta : 0;
}

/** Bottom edge of the actually visible area, in viewport coordinates. */
export function visibleBottomPx(viewport: VisualViewportSnapshot): number {
  return viewport.height + viewport.offsetTop;
}

/**
 * Scroll delta (px) needed to bring a caret bottom edge above the visible
 * bottom, with margin. Zero when the caret is already visible — the caller
 * must never scroll on a zero delta, or it would fight manual scrolling.
 */
export function caretScrollDeltaPx(
  caretBottom: number,
  visibleBottom: number,
  margin: number = CARET_MARGIN_PX,
): number {
  const overflow = caretBottom + margin - visibleBottom;
  return overflow > 0 ? overflow : 0;
}

export interface AttachCaretAboveKeyboardOptions {
  getViewport?: () => VisualViewportLike | null;
  getLayoutHeight?: () => number;
}

/**
 * Wires an editor to its scroll container (the note surface). While the
 * editor is focused, keeps the caret line above the keyboard. Returns a
 * cleanup that removes listeners and clears the reserved padding. No-ops
 * where there is no visualViewport (desktop web) or no keyboard.
 */
export function attachCaretAboveKeyboard(
  editor: Editor,
  scroller: HTMLElement,
  options: AttachCaretAboveKeyboardOptions = {},
): () => void {
  const getViewport =
    options.getViewport ?? (() => (window.visualViewport ?? null) as VisualViewportLike | null);
  const getLayoutHeight = options.getLayoutHeight ?? (() => window.innerHeight);

  let raf = 0;

  const applyKeyboardPadding = () => {
    const viewport = getViewport();
    const height = viewport ? keyboardHeightPx(getLayoutHeight(), viewport) : 0;
    scroller.style.scrollPaddingBottom = height > 0 ? `${height}px` : "";
  };

  const ensureCaretVisible = () => {
    if (!editor.isFocused) return;
    const viewport = getViewport();
    if (!viewport) return;
    const rect = editor.view.coordsAtPos(editor.state.selection.from);
    const delta = caretScrollDeltaPx(rect.bottom, visibleBottomPx(viewport));
    if (delta > 0) scroller.scrollTop += delta;
  };

  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      applyKeyboardPadding();
      ensureCaretVisible();
    });
  };

  const viewport = getViewport();
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  editor.on("selectionUpdate", schedule);
  editor.on("update", schedule);
  // The keyboard may already be open when the editor mounts (tap-to-edit).
  schedule();

  return () => {
    cancelAnimationFrame(raf);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    editor.off("selectionUpdate", schedule);
    editor.off("update", schedule);
    scroller.style.scrollPaddingBottom = "";
  };
}

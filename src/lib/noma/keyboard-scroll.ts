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
 *
 * Native seam (installed app only): PR #82 fixed the web case, where the
 * browser resizes and the visual viewport shrinks — but in the app the
 * window stays full-height behind the keyboard (decorFitsSystemWindows
 * (false) defeats adjustResize), so the visualViewport signal never
 * yields a usable height and a scroll delta alone hard-clamps at the
 * content's bottom. MainActivity therefore forwards the real IME
 * inset as a `noma:ime-height` window event (CSS px) plus a
 * synchronous `window.NomaIme.getHeightCssPx()` getter; this module
 * treats that height as the authoritative keyboard height and, while
 * it is open, also gives the scroll content real bottom room equal
 * to it — so maximum scroll can genuinely lift the document's last
 * line above the keyboard. The visualViewport path stays as the web
 * fallback and is never regressed by the native one.
 */

/** Window event the native shell dispatches with the IME height in CSS px. */
export const NATIVE_IME_EVENT = "noma:ime-height";

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

/** Native IME bridge the installed app registers (absent on web). */
export interface NomaImeBridgeLike {
  getHeightCssPx: () => number;
}

/**
 * Effective keyboard height: the native IME height when the shell
 * supplies one, else the visual-viewport shrink. max() keeps the web
 * fallback intact (native never fires there) and lets the larger
 * signal win if both ever report.
 */
export function effectiveKeyboardHeightPx(nativeHeight: number, viewportDelta: number): number {
  return Math.max(nativeHeight, viewportDelta);
}

/**
 * Bottom edge of the actually visible area when the native shell
 * reports the keyboard: the layout viewport stays full-height behind
 * the keyboard, so the visible bottom is the layout height minus the
 * keyboard — not the visual-viewport bottom (which never shrinks in
 * the app). Without a native height, the visual-viewport bottom is
 * correct (web path).
 */
export function effectiveVisibleBottomPx(
  layoutHeight: number,
  nativeHeight: number,
  viewport: VisualViewportSnapshot,
): number {
  if (nativeHeight > 0) {
    return layoutHeight - Math.max(nativeHeight, keyboardHeightPx(layoutHeight, viewport));
  }
  return visibleBottomPx(viewport);
}

export interface AttachCaretAboveKeyboardOptions {
  getViewport?: () => VisualViewportLike | null;
  getLayoutHeight?: () => number;
}

/**
 * Wires an editor to its scroll container (the note surface). While the
 * editor is focused, keeps the caret line above the keyboard. Returns a
 * cleanup that removes listeners and clears the reserved room. No-ops
 * where there is no visualViewport and no native IME height (desktop
 * web with no keyboard) — and never scrolls when the caret is already
 * visible, so manual scrolling is never fought.
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
  // Native IME height in CSS px (installed app only; 0 = absent/closed).
  let nativeHeight = 0;

  // Mount-with-keyboard-open case: a note opened while the keyboard
  // is already up fires no new inset dispatch, so read the bridge's
  // last value once. A missing or throwing bridge is treated as
  // absent; the visualViewport path remains.
  const readNativeHeight = () => {
    try {
      const bridge = (window as unknown as { NomaIme?: NomaImeBridgeLike }).NomaIme;
      const value = bridge?.getHeightCssPx?.();
      if (typeof value === "number" && value > 0) nativeHeight = Math.round(value);
    } catch {
      // Absent or unusable bridge — visualViewport path carries on.
    }
  };

  const onNativeIme = (event: Event) => {
    const value = (event as CustomEvent<number>).detail;
    nativeHeight = typeof value === "number" && value > 0 ? Math.round(value) : 0;
    schedule();
  };

  const applyKeyboardRoom = () => {
    const viewport = getViewport();
    const layoutHeight = getLayoutHeight();
    const height = effectiveKeyboardHeightPx(
      nativeHeight,
      viewport ? keyboardHeightPx(layoutHeight, viewport) : 0,
    );
    scroller.style.scrollPaddingBottom = height > 0 ? `${height}px` : "";
    // Real bottom room, on top of the editor's own pb-32: without it
    // a scroll delta hard-clamps at the content's bottom and the
    // document's last line can never rise above the keyboard.
    scroller.style.paddingBottom = height > 0 ? `${height}px` : "";
  };

  const ensureCaretVisible = () => {
    if (!editor.isFocused) return;
    const viewport = getViewport();
    if (!viewport && nativeHeight === 0) return;
    const layoutHeight = getLayoutHeight();
    const visibleBottom =
      viewport != null
        ? effectiveVisibleBottomPx(layoutHeight, nativeHeight, viewport)
        : layoutHeight - nativeHeight;
    const rect = editor.view.coordsAtPos(editor.state.selection.from);
    const delta = caretScrollDeltaPx(rect.bottom, visibleBottom);
    if (delta > 0) scroller.scrollTop += delta;
  };

  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      applyKeyboardRoom();
      ensureCaretVisible();
    });
  };

  const viewport = getViewport();
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  window.addEventListener(NATIVE_IME_EVENT, onNativeIme);
  editor.on("selectionUpdate", schedule);
  editor.on("update", schedule);
  // The keyboard may already be open when the editor mounts (tap-to-edit).
  readNativeHeight();
  schedule();

  return () => {
    cancelAnimationFrame(raf);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    window.removeEventListener(NATIVE_IME_EVENT, onNativeIme);
    editor.off("selectionUpdate", schedule);
    editor.off("update", schedule);
    scroller.style.scrollPaddingBottom = "";
    scroller.style.paddingBottom = "";
  };
}

export interface SubscribeKeyboardInsetOptions {
  getViewport?: () => VisualViewportLike | null;
  getLayoutHeight?: () => number;
}

/**
 * Tracks the effective on-screen-keyboard height for a surface whose
 * bottom must dock above the keyboard (the Ask composer): the same
 * two signals attachCaretAboveKeyboard consumes — the native shell's
 * `noma:ime-height` event, plus its mount-time bridge value, in the
 * installed app; the visual-viewport shrink on web — resolved through
 * effectiveKeyboardHeightPx. The Ask view shipped (PR #101) without
 * this: its flex column keeps the window's full height behind the
 * keyboard in the app, so the composer sat underneath it (found on
 * device 2026-10-29). Calls back synchronously once with the current
 * height, then only when the height changes. Returns the unsubscribe.
 */
export function subscribeKeyboardInset(
  onChange: (heightCssPx: number) => void,
  options: SubscribeKeyboardInsetOptions = {},
): () => void {
  const getViewport =
    options.getViewport ?? (() => (window.visualViewport ?? null) as VisualViewportLike | null);
  const getLayoutHeight = options.getLayoutHeight ?? (() => window.innerHeight);

  let raf = 0;
  let nativeHeight = 0;
  let last = -1;

  // Same mount-time bridge read as attachCaretAboveKeyboard: a surface
  // opened while the keyboard is already up gets no fresh dispatch.
  const readNativeHeight = () => {
    try {
      const bridge = (window as unknown as { NomaIme?: NomaImeBridgeLike }).NomaIme;
      const value = bridge?.getHeightCssPx?.();
      if (typeof value === "number" && value > 0) nativeHeight = Math.round(value);
    } catch {
      // Absent or unusable bridge — the visualViewport path carries on.
    }
  };

  const apply = () => {
    const viewport = getViewport();
    const height = effectiveKeyboardHeightPx(
      nativeHeight,
      viewport ? keyboardHeightPx(getLayoutHeight(), viewport) : 0,
    );
    if (height !== last) {
      last = height;
      onChange(height);
    }
  };

  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(apply);
  };

  const onNativeIme = (event: Event) => {
    const value = (event as CustomEvent<number>).detail;
    nativeHeight = typeof value === "number" && value > 0 ? Math.round(value) : 0;
    schedule();
  };

  const viewport = getViewport();
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  window.addEventListener(NATIVE_IME_EVENT, onNativeIme);
  readNativeHeight();
  apply();

  return () => {
    cancelAnimationFrame(raf);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    window.removeEventListener(NATIVE_IME_EVENT, onNativeIme);
  };
}

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Registry of currently-open Radix overlays (dialogs, alert dialogs,
 * sheets, menus, popovers, selects), fed by the shared wrappers in
 * `src/components/ui/*`.
 *
 * Why this exists: the Android system-back coordinator (system-back.ts)
 * must know whether a transient overlay is on screen so a hardware back
 * press can close it instead of whatever sits underneath. Radix closes
 * overlays on `Escape`, but a hardware back press never reaches the
 * page as a key event, and sniffing the DOM for `[data-state="open"]`
 * nodes would couple the coordinator to Radix's markup. Instead, every
 * shared overlay root registers itself here while open, together with
 * the dismiss function that closes it through its normal
 * `onOpenChange(false)` path.
 *
 * Entries form a stack in open order; the coordinator dismisses the
 * most recently opened one, mirroring how stacked overlays behave.
 */

export type OverlayDismiss = () => void;

interface OverlayEntry {
  id: number;
  dismiss: OverlayDismiss;
}

const stack: OverlayEntry[] = [];
let nextId = 1;

/** Registers an open overlay; returns the unregister function. */
export function registerOverlay(dismiss: OverlayDismiss): () => void {
  const id = nextId++;
  stack.push({ id, dismiss });
  return () => {
    const index = stack.findIndex((entry) => entry.id === id);
    if (index !== -1) stack.splice(index, 1);
  };
}

/** True while any registered overlay is open. */
export function hasOpenOverlay(): boolean {
  return stack.length > 0;
}

/**
 * Dismisses the most recently opened overlay through its own close
 * path. Returns false when no overlay is open.
 */
export function dismissTopOverlay(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.dismiss();
  return true;
}

/** Number of currently registered overlays (diagnostics/tests). */
export function openOverlayCount(): number {
  return stack.length;
}

/** Test-only reset so suites start from an empty registry. */
export function resetOverlayRegistry(): void {
  stack.length = 0;
  nextId = 1;
}

/**
 * Registers `dismiss` while `open` is true. Used by the shared ui
 * overlay wrappers; the latest dismiss closure is always the one kept,
 * so callers can pass a fresh closure every render.
 */
export function useOverlayRegistration(open: boolean, dismiss: OverlayDismiss): void {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    if (!open) return;
    return registerOverlay(() => dismissRef.current());
  }, [open]);
}

interface OverlayRootProps {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
}

/**
 * Open-state plumbing shared by every Radix root wrapper in
 * `src/components/ui/*` (Dialog, AlertDialog, Sheet, DropdownMenu,
 * Popover, Select). It makes the root controlled-by-the-wrapper when
 * the consumer leaves it uncontrolled (menus, popovers and selects
 * usually do), passes controlled props through untouched, and
 * registers the overlay here while it is open so the system-back
 * coordinator can dismiss it through the normal `onOpenChange(false)`
 * path — the same close a pointer or Escape would produce.
 *
 * Behaviour for consumers is unchanged: their `onOpenChange` still
 * fires for every transition, and controlled roots stay controlled.
 */
export function useRegisteredOverlayRoot(props: OverlayRootProps): {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(props.defaultOpen ?? false);
  const open = props.open ?? uncontrolledOpen;

  const controlledRef = useRef(props.open !== undefined);
  controlledRef.current = props.open !== undefined;
  const consumerOnOpenChangeRef = useRef(props.onOpenChange);
  consumerOnOpenChangeRef.current = props.onOpenChange;

  const handleOpenChange = useCallback((next: boolean) => {
    if (!controlledRef.current) setUncontrolledOpen(next);
    consumerOnOpenChangeRef.current?.(next);
  }, []);

  useOverlayRegistration(open, () => handleOpenChange(false));

  return { open, onOpenChange: handleOpenChange };
}

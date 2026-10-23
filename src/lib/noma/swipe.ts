import type { ViewKind } from "./view";

/**
 * Swipe actions for note rows (native-feel #3) — the pure decision logic
 * behind NoteItem's touch gestures. The component owns the DOM (pointer
 * events, transforms, timers); everything decidable without a DOM lives
 * here and is unit-tested: which actions a view offers, when a touch
 * becomes a drag (slop + axis lock), and when a release commits.
 */

export type SwipeActionKind = "trash" | "pin" | "restore" | "deleteForever";

export interface SwipeActionMap {
  /** Action revealed by swiping the row left (finger moves left). */
  left: SwipeActionKind | null;
  /** Action revealed by swiping the row right (finger moves right). */
  right: SwipeActionKind | null;
}

/**
 * The gesture map (spec: native-feel #3).
 * - Normal views: left = Move to Trash, right = Pin/Unpin. Pin is the
 *   right-swipe action rather than archive because it is a *visible*
 *   toggle — the note floats to the top — while a swipe that hides a
 *   note would feel like a bug.
 * - Trash: right = Restore; left = Delete permanently, which the
 *   component routes to `actions.deleteForever` — that only opens the
 *   existing confirmation dialog, so a swipe can never delete directly.
 * - Templates: pin is meaningless for a template, so right is disabled;
 *   left = trash still applies (a trashed template lands in Trash, where
 *   the trash map takes over).
 */
export function swipeActionsFor(viewKind: ViewKind, note: { deleted: boolean }): SwipeActionMap {
  if (note.deleted || viewKind === "trash") return { left: "deleteForever", right: "restore" };
  if (viewKind === "templates") return { left: "trash", right: null };
  return { left: "trash", right: "pin" };
}

/** Movement (px) before a touch counts as a drag rather than a tap. */
export const SWIPE_SLOP_PX = 10;
/** Release at or beyond this fraction of the row width commits the action. */
export const SWIPE_COMMIT_FRACTION = 0.4;
/** Flick commit needs at least this speed (px/ms)… */
export const SWIPE_FLICK_VELOCITY_PX_PER_MS = 0.5;
/** …over at least this distance, so a twitch can never fire an action. */
export const SWIPE_FLICK_MIN_DISTANCE_PX = 24;
/** A direction with no action still follows the finger at this rate. */
export const SWIPE_RESISTANCE = 0.3;

export type SwipePhase = "idle" | "pending" | "dragging" | "cancelled" | "committed";

export interface SwipeGesture {
  phase: SwipePhase;
  pointerId: number | null;
  startX: number;
  startY: number;
  lastX: number;
  lastT: number;
  /** Effective horizontal offset (px) to render: resistance applied. */
  dx: number;
  /** Raw horizontal offset (px), before resistance. */
  rawDx: number;
  /** Signed horizontal velocity (px/ms), smoothed per move segment. */
  velocityX: number;
  /** Exactly-once guard: true once this gesture has produced its action. */
  fired: boolean;
}

export const idleSwipeGesture: SwipeGesture = {
  phase: "idle",
  pointerId: null,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastT: 0,
  dx: 0,
  rawDx: 0,
  velocityX: 0,
  fired: false,
};

export interface SwipePoint {
  pointerId: number;
  x: number;
  y: number;
  /** Event timestamp (ms) — used only for flick velocity. */
  t: number;
}

/**
 * Begin tracking a touch. Touch pointers only: a mouse drag must never
 * fling a note (desktop keeps hover + the overflow menu). A pointer
 * arriving while a drag is already claimed (or committed) is ignored;
 * a stale `pending` that never claimed the gesture may be replaced.
 */
export function swipePointerDown(
  g: SwipeGesture,
  p: SwipePoint & { pointerType: string },
): SwipeGesture {
  if (p.pointerType !== "touch") return g;
  if (g.phase === "dragging" || g.phase === "committed") return g;
  return {
    ...idleSwipeGesture,
    phase: "pending",
    pointerId: p.pointerId,
    startX: p.x,
    startY: p.y,
    lastX: p.x,
    lastT: p.t,
  };
}

function effectiveDx(rawDx: number, map: SwipeActionMap): number {
  if (rawDx > 0 && map.right === null) return rawDx * SWIPE_RESISTANCE;
  if (rawDx < 0 && map.left === null) return rawDx * SWIPE_RESISTANCE;
  return rawDx;
}

export function swipePointerMove(
  g: SwipeGesture,
  p: SwipePoint,
  map: SwipeActionMap,
  rowWidth: number,
): SwipeGesture {
  if (g.phase !== "pending" && g.phase !== "dragging") return g;
  if (p.pointerId !== g.pointerId) return g;
  const rawDx = p.x - g.startX;
  const rawDy = p.y - g.startY;

  if (g.phase === "pending") {
    if (Math.max(Math.abs(rawDx), Math.abs(rawDy)) <= SWIPE_SLOP_PX) {
      // Still a possible tap: track the finger, reveal nothing.
      return { ...g, lastX: p.x, lastT: p.t };
    }
    // Axis lock: vertical-dominant movement belongs to the scroller —
    // the browser takes over (and fires pointercancel); never a swipe.
    if (Math.abs(rawDy) >= Math.abs(rawDx)) {
      return { ...g, phase: "cancelled", dx: 0, rawDx: 0, lastX: p.x, lastT: p.t };
    }
  }

  // Velocity: exponential smoothing over move segments, so momentum at
  // release reflects the end of the gesture rather than one segment.
  let velocityX = g.velocityX;
  const dt = p.t - g.lastT;
  if (dt > 0) {
    const segment = (p.x - g.lastX) / dt;
    velocityX = g.phase === "dragging" ? velocityX * 0.6 + segment * 0.4 : segment;
  }
  const dx = effectiveDx(rawDx, map);
  const clamped = rowWidth > 0 ? Math.max(-rowWidth, Math.min(rowWidth, dx)) : dx;
  return {
    ...g,
    phase: "dragging",
    dx: clamped,
    rawDx,
    velocityX,
    lastX: p.x,
    lastT: p.t,
  };
}

export type SwipeRelease =
  /** The touch never became a drag: let the normal click (open) through. */
  | { type: "tap" }
  /** Spring back; no action (below threshold, cancelled, wrong pointer). */
  | { type: "settle" }
  /** Fire `action` exactly once. */
  | { type: "commit"; action: SwipeActionKind; direction: "left" | "right" };

export function swipePointerUp(
  g: SwipeGesture,
  map: SwipeActionMap,
  rowWidth: number,
): { gesture: SwipeGesture; release: SwipeRelease } {
  if (g.phase === "pending") return { gesture: idleSwipeGesture, release: { type: "tap" } };
  if (g.phase !== "dragging") return { gesture: idleSwipeGesture, release: { type: "settle" } };

  const direction: "left" | "right" = g.dx < 0 ? "left" : "right";
  const action = direction === "left" ? map.left : map.right;
  const distance = Math.abs(g.dx);
  const threshold = rowWidth > 0 ? rowWidth * SWIPE_COMMIT_FRACTION : Number.POSITIVE_INFINITY;
  const flicked =
    Math.abs(g.velocityX) >= SWIPE_FLICK_VELOCITY_PX_PER_MS &&
    Math.abs(g.rawDx) >= SWIPE_FLICK_MIN_DISTANCE_PX &&
    Math.sign(g.velocityX) === Math.sign(g.rawDx);

  if (action !== null && !g.fired && (distance >= threshold || flicked)) {
    return {
      gesture: { ...g, phase: "committed", fired: true },
      release: { type: "commit", action, direction },
    };
  }
  return { gesture: idleSwipeGesture, release: { type: "settle" } };
}

/** The browser took the gesture (scroll) or it was interrupted: reset. */
export function swipePointerCancel(g: SwipeGesture): SwipeGesture {
  if (g.phase === "committed") return g;
  return idleSwipeGesture;
}

/**
 * Would releasing at the current offset commit? Drives the underlay's
 * armed emphasis. Flicks can't be "armed" before release, by design.
 */
export function swipeWouldCommit(g: SwipeGesture, map: SwipeActionMap, rowWidth: number): boolean {
  if (g.phase !== "dragging" || rowWidth <= 0) return false;
  const action = g.dx < 0 ? map.left : map.right;
  return action !== null && Math.abs(g.dx) >= rowWidth * SWIPE_COMMIT_FRACTION;
}

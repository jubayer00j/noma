import { describe, expect, it } from "vitest";
import {
  idleSwipeGesture,
  swipeActionsFor,
  swipePointerCancel,
  swipePointerDown,
  swipePointerMove,
  swipePointerUp,
  swipeWouldCommit,
  SWIPE_COMMIT_FRACTION,
  SWIPE_RESISTANCE,
  type SwipeGesture,
  type SwipeActionMap,
} from "./swipe";

const NORMAL: SwipeActionMap = { left: "trash", right: "pin" };
const WIDTH = 360;
const THRESHOLD = WIDTH * SWIPE_COMMIT_FRACTION; // 144

const down = (g: SwipeGesture, x = 200, y = 100, pointerType = "touch", t = 0) =>
  swipePointerDown(g, { pointerId: 1, x, y, t, pointerType });
const move = (g: SwipeGesture, x: number, t: number, map: SwipeActionMap = NORMAL, y = 100) =>
  swipePointerMove(g, { pointerId: 1, x, y, t }, map, WIDTH);
const up = (g: SwipeGesture, map: SwipeActionMap = NORMAL) => swipePointerUp(g, map, WIDTH);

/** A slow drag: one move every 100ms, so velocity stays near zero. */
function slowDragTo(x: number, map: SwipeActionMap = NORMAL): SwipeGesture {
  let g = down(idleSwipeGesture);
  g = move(g, 200 + (x - 200) / 2, 100, map);
  g = move(g, x, 200, map);
  // Hold still for a beat so the last segment's velocity decays to ~0.
  g = move(g, x, 400, map);
  return g;
}

describe("swipeActionsFor — the gesture map", () => {
  it("normal views: left = trash, right = pin", () => {
    expect(swipeActionsFor("all", { deleted: false })).toEqual({ left: "trash", right: "pin" });
    expect(swipeActionsFor("archive", { deleted: false })).toEqual({
      left: "trash",
      right: "pin",
    });
    expect(swipeActionsFor("folder", { deleted: false })).toEqual({ left: "trash", right: "pin" });
  });

  it("trash view: right = restore, left = delete (dialog only)", () => {
    expect(swipeActionsFor("trash", { deleted: true })).toEqual({
      left: "deleteForever",
      right: "restore",
    });
  });

  it("a deleted note maps to trash actions even outside the trash view", () => {
    expect(swipeActionsFor("all", { deleted: true })).toEqual({
      left: "deleteForever",
      right: "restore",
    });
  });

  it("templates view: pin disabled, trash still available", () => {
    expect(swipeActionsFor("templates", { deleted: false })).toEqual({
      left: "trash",
      right: null,
    });
  });
});

describe("swipePointerDown — touch pointers only", () => {
  it("a mouse drag never starts a gesture", () => {
    expect(down(idleSwipeGesture, 200, 100, "mouse")).toBe(idleSwipeGesture);
  });

  it("a pen never starts a gesture", () => {
    expect(down(idleSwipeGesture, 200, 100, "pen")).toBe(idleSwipeGesture);
  });

  it("a touch begins in pending", () => {
    const g = down(idleSwipeGesture);
    expect(g.phase).toBe("pending");
    expect(g.dx).toBe(0);
  });

  it("a second pointer cannot hijack a claimed drag", () => {
    const g = slowDragTo(80);
    expect(g.phase).toBe("dragging");
    const hijack = swipePointerDown(g, {
      pointerId: 2,
      x: 10,
      y: 10,
      t: 500,
      pointerType: "touch",
    });
    expect(hijack).toBe(g);
  });
});

describe("slop and axis lock", () => {
  it("movement below the slop stays a pending tap and reveals nothing", () => {
    let g = down(idleSwipeGesture);
    g = move(g, 206, 16);
    expect(g.phase).toBe("pending");
    expect(g.dx).toBe(0);
    expect(up(g).release).toEqual({ type: "tap" });
  });

  it("vertical-dominant movement past the slop cancels to the scroller", () => {
    let g = down(idleSwipeGesture);
    g = swipePointerMove(g, { pointerId: 1, x: 204, y: 130, t: 16 }, NORMAL, WIDTH);
    expect(g.phase).toBe("cancelled");
    expect(g.dx).toBe(0);
    expect(up(g).release).toEqual({ type: "settle" });
  });

  it("horizontal-dominant movement past the slop starts dragging", () => {
    let g = down(idleSwipeGesture);
    g = swipePointerMove(g, { pointerId: 1, x: 170, y: 104, t: 16 }, NORMAL, WIDTH);
    expect(g.phase).toBe("dragging");
    expect(g.dx).toBe(-30);
  });

  it("moves from a different pointer are ignored mid-gesture", () => {
    let g = down(idleSwipeGesture);
    g = swipePointerMove(g, { pointerId: 99, x: 100, y: 100, t: 16 }, NORMAL, WIDTH);
    expect(g.phase).toBe("pending");
    expect(g.dx).toBe(0);
  });
});

describe("resistance on a disabled direction", () => {
  it("templates view: rightward drag is damped and can never commit", () => {
    const map = swipeActionsFor("templates", { deleted: false });
    let g = down(idleSwipeGesture);
    g = move(g, 300, 100, map); // rawDx = +100
    expect(g.dx).toBeCloseTo(100 * SWIPE_RESISTANCE);
    g = move(g, 300, 500, map); // hold still; velocity decays
    const { release } = up(g, map);
    expect(release).toEqual({ type: "settle" });
  });
});

describe("commit decisions", () => {
  it("a slow drag released past 40% of the row width commits left = trash", () => {
    const g = slowDragTo(200 - THRESHOLD - 10);
    expect(g.dx).toBeLessThanOrEqual(-THRESHOLD);
    const { gesture, release } = up(g);
    expect(release).toEqual({ type: "commit", action: "trash", direction: "left" });
    expect(gesture.phase).toBe("committed");
    expect(gesture.fired).toBe(true);
  });

  it("a slow drag released past 40% to the right commits pin", () => {
    const g = slowDragTo(200 + THRESHOLD + 10);
    expect(up(g).release).toEqual({ type: "commit", action: "pin", direction: "right" });
  });

  it("a slow drag released below the threshold settles", () => {
    const g = slowDragTo(200 - THRESHOLD + 20);
    expect(up(g).release).toEqual({ type: "settle" });
  });

  it("a fast flick commits well below the distance threshold", () => {
    let g = down(idleSwipeGesture);
    // One quick segment: 40px in 16ms — velocity ≈ 2.5 px/ms.
    g = move(g, 160, 16);
    expect(Math.abs(g.dx)).toBeLessThan(THRESHOLD);
    expect(up(g).release).toEqual({ type: "commit", action: "trash", direction: "left" });
  });

  it("a flick whose velocity points back toward rest does not commit", () => {
    let g = down(idleSwipeGesture);
    g = move(g, 120, 100); // drag left slowly to dx=-80
    g = move(g, 150, 116); // snap back right fast: velocity +1.875, rawDx -50
    expect(up(g).release).toEqual({ type: "settle" });
  });

  it("a flick toward a disabled direction never commits", () => {
    const map = swipeActionsFor("templates", { deleted: false });
    let g = down(idleSwipeGesture);
    g = move(g, 260, 16, map); // fast right flick in templates view
    expect(up(g, map).release).toEqual({ type: "settle" });
  });

  it("fires exactly once: a committed gesture cannot commit again", () => {
    const g = slowDragTo(200 - THRESHOLD - 10);
    const first = up(g);
    expect(first.release.type).toBe("commit");
    const second = swipePointerUp(first.gesture, NORMAL, WIDTH);
    expect(second.release).toEqual({ type: "settle" });
  });

  it("trash view: left past threshold commits delete, right commits restore", () => {
    const map = swipeActionsFor("trash", { deleted: true });
    expect(up(slowDragTo(200 - THRESHOLD - 10, map), map).release).toEqual({
      type: "commit",
      action: "deleteForever",
      direction: "left",
    });
    expect(up(slowDragTo(200 + THRESHOLD + 10, map), map).release).toEqual({
      type: "commit",
      action: "restore",
      direction: "right",
    });
  });
});

describe("cancel and armed state", () => {
  it("pointer cancel resets a drag (but never un-fires a committed one)", () => {
    const g = slowDragTo(120);
    expect(g.phase).toBe("dragging");
    expect(swipePointerCancel(g)).toEqual(idleSwipeGesture);
    const committed = up(slowDragTo(200 - THRESHOLD - 10)).gesture;
    expect(swipePointerCancel(committed)).toBe(committed);
  });

  it("swipeWouldCommit tracks the distance threshold only", () => {
    expect(swipeWouldCommit(slowDragTo(200 - THRESHOLD - 10), NORMAL, WIDTH)).toBe(true);
    expect(swipeWouldCommit(slowDragTo(200 - THRESHOLD + 20), NORMAL, WIDTH)).toBe(false);
    expect(swipeWouldCommit(idleSwipeGesture, NORMAL, WIDTH)).toBe(false);
  });
});

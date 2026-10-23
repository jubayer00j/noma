// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteItem, type NoteActions } from "./note-list";
import type { Note } from "@/lib/noma/types";
import type { ViewKind } from "@/lib/noma/view";

// Native-feel #4: the row's haptic calls are asserted through a mock of
// the bridge module (the bridge itself is unit-tested in haptics.test.ts
// with the plugin mocked — here only the wiring is under test).
const hapticsMock = vi.hoisted(() => ({
  hapticSwipeArmed: vi.fn(),
  hapticSwipeCommit: vi.fn(),
}));
vi.mock("@/lib/noma/haptics", () => hapticsMock);

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

// happy-dom has no layout: clientWidth is 0, which would make the swipe
// commit threshold meaningless. Give every element the width of a typical
// phone row for these tests only (descriptor restored afterwards).
const ROW_WIDTH = 360;
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => ROW_WIDTH,
  });
});
afterAll(() => {
  if (originalClientWidth) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", originalClientWidth);
  }
});

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    title: "Swipe me",
    content: "<p>Body text</p>",
    contentFormat: "tiptap-html",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    folderId: null,
    tagIds: [],
    pinned: false,
    favorite: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    reminderAt: null,
    wordCount: 2,
    ...overrides,
  };
}

function makeActions(): NoteActions {
  return {
    open: vi.fn(),
    togglePin: vi.fn(),
    toggleFavorite: vi.fn(),
    setArchived: vi.fn(),
    duplicate: vi.fn(),
    move: vi.fn(),
    trash: vi.fn(),
    restore: vi.fn(),
    deleteForever: vi.fn(),
  };
}

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

function renderRow(note: Note, actions: NoteActions, viewKind: ViewKind = "all") {
  act(() => {
    root.render(
      <NoteItem
        note={note}
        folders={[]}
        tagNameMap={new Map()}
        folderNameMap={new Map()}
        isActive={false}
        actions={actions}
        isPhoneAlarm={false}
        viewKind={viewKind}
      />,
    );
  });
}

function cardEl(): HTMLDivElement {
  const button = container.querySelector('button[aria-label^="Open"]');
  if (!button?.parentElement) throw new Error("note card not rendered");
  return button.parentElement as HTMLDivElement;
}

function underlayEl(): HTMLDivElement | null {
  return (
    (Array.from(container.querySelectorAll("div")).find((d) => d.className.includes("inset-0")) as
      HTMLDivElement | undefined) ?? null
  );
}

/** Dispatch a pointer event with an explicit, deterministic timestamp. */
function firePointer(
  el: Element,
  type: string,
  opts: { x: number; y?: number; t: number; pointerType?: string },
) {
  const pointerType = opts.pointerType ?? "touch";
  const Ctor =
    (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? window.MouseEvent;
  const e = new Ctor(type, {
    bubbles: true,
    cancelable: true,
    clientX: opts.x,
    clientY: opts.y ?? 100,
    pointerId: 1,
    pointerType,
  } as MouseEventInit);
  // Shadow prototype getters with own values where the constructor did
  // not take them (fallback MouseEvent has no pointer props at all).
  const rec = e as unknown as Record<string, unknown>;
  if (rec["pointerId"] !== 1) Object.defineProperty(e, "pointerId", { value: 1 });
  if (rec["pointerType"] !== pointerType) {
    Object.defineProperty(e, "pointerType", { value: pointerType });
  }
  Object.defineProperty(e, "timeStamp", { value: opts.t });
  act(() => {
    el.dispatchEvent(e);
  });
}

/** Slow drag (timestamps spread so flick velocity stays ~0) to offset dx. */
function slowDrag(el: Element, dx: number) {
  firePointer(el, "pointerdown", { x: 200, t: 0 });
  firePointer(el, "pointermove", { x: 200 + dx / 2, t: 150 });
  firePointer(el, "pointermove", { x: 200 + dx, t: 300 });
  firePointer(el, "pointermove", { x: 200 + dx, t: 600 }); // hold: velocity decays
}

const sleep = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

describe("NoteItem swipe gestures (native-feel #3)", () => {
  it("renders the Trash underlay on a left swipe and Pin on a right swipe (normal view)", () => {
    const actions = makeActions();
    renderRow(makeNote(), actions);
    const card = cardEl();

    slowDrag(card, -60);
    expect(underlayEl()?.textContent).toContain("Trash");
    firePointer(card, "pointercancel", { x: 140, t: 700 });

    slowDrag(card, 60);
    expect(underlayEl()?.textContent).toContain("Pin");
    firePointer(card, "pointercancel", { x: 260, t: 1400 });
  });

  it("a committed left swipe calls actions.trash exactly once and swallows the trailing click", async () => {
    const actions = makeActions();
    const note = makeNote();
    renderRow(note, actions);
    const card = cardEl();

    slowDrag(card, -160); // 160px ≥ 40% of the 360px row
    firePointer(card, "pointerup", { x: 40, t: 700 });
    // Removal actions dispatch after the slide-off animation.
    expect(actions.trash).not.toHaveBeenCalled();
    await sleep(240);
    expect(actions.trash).toHaveBeenCalledTimes(1);
    expect(actions.trash).toHaveBeenCalledWith(note);

    // The click trailing the drag must not open the note…
    act(() => {
      card
        .querySelector("button")!
        .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(actions.open).not.toHaveBeenCalled();
    // …but the suppression is consumed: the next genuine tap opens.
    act(() => {
      card
        .querySelector("button")!
        .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(actions.open).toHaveBeenCalledTimes(1);
  });

  it("a committed right swipe pins immediately, with no toast-path action", () => {
    const actions = makeActions();
    const note = makeNote();
    renderRow(note, actions);
    const card = cardEl();

    slowDrag(card, 160);
    firePointer(card, "pointerup", { x: 360, t: 700 });
    expect(actions.togglePin).toHaveBeenCalledTimes(1);
    expect(actions.togglePin).toHaveBeenCalledWith(note);
    expect(actions.trash).not.toHaveBeenCalled();
  });

  it("a short swipe springs back and fires nothing; the tap still opens", () => {
    const actions = makeActions();
    renderRow(makeNote(), actions);
    const card = cardEl();

    slowDrag(card, -60); // below the 144px commit threshold
    firePointer(card, "pointerup", { x: 140, t: 700 });
    expect(actions.trash).not.toHaveBeenCalled();
    expect(card.style.transform).toBe("");

    // A plain tap (no drag) is untouched by the gesture layer.
    firePointer(card, "pointerdown", { x: 200, t: 1000 });
    firePointer(card, "pointerup", { x: 201, t: 1050 });
    act(() => {
      card
        .querySelector("button")!
        .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(actions.open).toHaveBeenCalledTimes(1);
  });

  it("a vertical-dominant drag is left to the scroller", () => {
    const actions = makeActions();
    renderRow(makeNote(), actions);
    const card = cardEl();

    firePointer(card, "pointerdown", { x: 200, t: 0 });
    firePointer(card, "pointermove", { x: 204, y: 160, t: 100 });
    expect(card.style.transform ?? "").not.toContain("translateX(-");
    expect(underlayEl()).toBeNull();
    firePointer(card, "pointercancel", { x: 204, y: 160, t: 150 });
    expect(actions.trash).not.toHaveBeenCalled();
  });

  it("a mouse drag never starts a swipe", () => {
    const actions = makeActions();
    renderRow(makeNote(), actions);
    const card = cardEl();

    firePointer(card, "pointerdown", { x: 200, t: 0, pointerType: "mouse" });
    firePointer(card, "pointermove", { x: 40, t: 100, pointerType: "mouse" });
    expect(card.style.transform ?? "").toBe("");
    expect(underlayEl()).toBeNull();
    firePointer(card, "pointerup", { x: 40, t: 150, pointerType: "mouse" });
    expect(actions.trash).not.toHaveBeenCalled();
  });

  it("trash view: right swipe restores, left swipe opens delete via the action (never direct)", async () => {
    const actions = makeActions();
    const note = makeNote({ deleted: true, deletedAt: 1_700_000_000_000 });
    renderRow(note, actions, "trash");
    const card = cardEl();

    slowDrag(card, 60);
    expect(underlayEl()?.textContent).toContain("Restore");
    firePointer(card, "pointercancel", { x: 260, t: 700 });

    slowDrag(card, -60);
    expect(underlayEl()?.textContent).toContain("Delete");
    firePointer(card, "pointercancel", { x: 140, t: 1400 });

    // Committed left swipe → actions.deleteForever (which only opens the
    // workspace confirmation dialog), fired immediately, card springs back.
    slowDrag(card, -160);
    firePointer(card, "pointerup", { x: 40, t: 2100 });
    expect(actions.deleteForever).toHaveBeenCalledTimes(1);
    expect(actions.deleteForever).toHaveBeenCalledWith(note);

    // Committed right swipe → restore after the slide-off.
    slowDrag(card, 160);
    firePointer(card, "pointerup", { x: 360, t: 2800 });
    await sleep(240);
    expect(actions.restore).toHaveBeenCalledTimes(1);
    expect(actions.restore).toHaveBeenCalledWith(note);
  });

  it("templates view: right swipe is disabled (resisted, no pin), left still trashes", async () => {
    const actions = makeActions();
    const note = makeNote({ isTemplate: true });
    renderRow(note, actions, "templates");
    const card = cardEl();

    slowDrag(card, 160);
    // Resisted to 30%: the card barely follows and no panel is revealed.
    expect(card.style.transform).toBe("translateX(48px)");
    expect(underlayEl()).toBeNull();
    firePointer(card, "pointerup", { x: 360, t: 700 });
    expect(actions.togglePin).not.toHaveBeenCalled();

    slowDrag(card, -160);
    firePointer(card, "pointerup", { x: 40, t: 1400 });
    await sleep(240);
    expect(actions.trash).toHaveBeenCalledTimes(1);
  });

  it("a recycled row resets its swipe state when the note changes", () => {
    const actions = makeActions();
    renderRow(makeNote({ id: "note-a", title: "First" }), actions);
    const card = cardEl();

    slowDrag(card, -100);
    expect(card.style.transform).toBe("translateX(-100px)");

    renderRow(makeNote({ id: "note-b", title: "Second" }), actions);
    const recycled = cardEl();
    expect(recycled.style.transform ?? "").toBe("");
    expect(underlayEl()).toBeNull();
  });
});

describe("NoteItem haptics (native-feel #4)", () => {
  beforeEach(() => {
    hapticsMock.hapticSwipeArmed.mockClear();
    hapticsMock.hapticSwipeCommit.mockClear();
  });

  it("ticks once when the drag crosses the commit threshold, and again after dropping back and re-crossing", () => {
    const actions = makeActions();
    renderRow(makeNote(), actions);
    const card = cardEl();

    firePointer(card, "pointerdown", { x: 200, t: 0 });
    // dx −80: dragging, but below the 144px commit threshold — no tick.
    firePointer(card, "pointermove", { x: 120, t: 150 });
    expect(hapticsMock.hapticSwipeArmed).not.toHaveBeenCalled();
    // dx −160: the crossing fires exactly one tick…
    firePointer(card, "pointermove", { x: 40, t: 300 });
    expect(hapticsMock.hapticSwipeArmed).toHaveBeenCalledTimes(1);
    // …and holding past the threshold does not spam.
    firePointer(card, "pointermove", { x: 30, t: 450 });
    expect(hapticsMock.hapticSwipeArmed).toHaveBeenCalledTimes(1);
    // Dropping back below the threshold re-arms; re-crossing ticks again.
    firePointer(card, "pointermove", { x: 140, t: 600 });
    expect(hapticsMock.hapticSwipeArmed).toHaveBeenCalledTimes(1);
    firePointer(card, "pointermove", { x: 40, t: 750 });
    expect(hapticsMock.hapticSwipeArmed).toHaveBeenCalledTimes(2);
    firePointer(card, "pointercancel", { x: 40, t: 800 });
    expect(hapticsMock.hapticSwipeCommit).not.toHaveBeenCalled();
  });

  it("never ticks during sub-threshold movement, and a spring-back release stays silent", () => {
    const actions = makeActions();
    renderRow(makeNote(), actions);
    const card = cardEl();

    slowDrag(card, -60);
    firePointer(card, "pointerup", { x: 140, t: 700 });
    expect(hapticsMock.hapticSwipeArmed).not.toHaveBeenCalled();
    expect(hapticsMock.hapticSwipeCommit).not.toHaveBeenCalled();
  });

  it("fires the trash commit haptic at release, before the slide-off dispatch lands", async () => {
    const actions = makeActions();
    renderRow(makeNote(), actions);
    const card = cardEl();

    slowDrag(card, -160);
    firePointer(card, "pointerup", { x: 40, t: 700 });
    // The buzz belongs to the release: it has already fired while the
    // action itself still waits for the slide-off animation.
    expect(hapticsMock.hapticSwipeCommit).toHaveBeenCalledTimes(1);
    expect(hapticsMock.hapticSwipeCommit).toHaveBeenCalledWith("trash");
    expect(actions.trash).not.toHaveBeenCalled();
    await sleep(240);
    expect(actions.trash).toHaveBeenCalledTimes(1);
    expect(hapticsMock.hapticSwipeCommit).toHaveBeenCalledTimes(1);
  });

  it("fires the pin commit haptic at release on a right swipe", () => {
    const actions = makeActions();
    renderRow(makeNote(), actions);
    const card = cardEl();

    slowDrag(card, 160);
    firePointer(card, "pointerup", { x: 360, t: 700 });
    expect(hapticsMock.hapticSwipeCommit).toHaveBeenCalledTimes(1);
    expect(hapticsMock.hapticSwipeCommit).toHaveBeenCalledWith("pin");
    expect(actions.togglePin).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent } from "./dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import {
  dismissTopOverlay,
  openOverlayCount,
  resetOverlayRegistry,
  useRegisteredOverlayRoot,
} from "@/lib/noma/overlay-registry";

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetOverlayRegistry();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetOverlayRegistry();
});

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

describe("ui overlay wrappers — registration", () => {
  it("a controlled open Dialog registers; dismiss goes through onOpenChange", () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>hello</DialogContent>
      </Dialog>,
    );
    expect(openOverlayCount()).toBe(1);
    act(() => {
      dismissTopOverlay();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a closed Dialog does not register", () => {
    render(
      <Dialog open={false} onOpenChange={() => {}}>
        <DialogContent>hello</DialogContent>
      </Dialog>,
    );
    expect(openOverlayCount()).toBe(0);
  });

  it("an uncontrolled DropdownMenu registers while open and dismisses itself", () => {
    function Menu() {
      const [label] = useState("menu");
      return (
        <DropdownMenu>
          <DropdownMenuTrigger>{label}</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>One</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }
    render(<Menu />);
    expect(openOverlayCount()).toBe(0);
    const trigger =
      container.querySelector("[data-radix-menu-trigger]") ?? container.querySelector("button");
    expect(trigger).not.toBeNull();
    act(() => {
      trigger!.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
      trigger!.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true }));
      (trigger as HTMLElement).click();
    });
    expect(openOverlayCount()).toBe(1);
    act(() => {
      dismissTopOverlay();
    });
    expect(openOverlayCount()).toBe(0);
  });
});

describe("useRegisteredOverlayRoot", () => {
  it("uncontrolled roots track their own state and unregister on dismiss", () => {
    const onOpenChange = vi.fn();
    function Probe() {
      const rootProps = useRegisteredOverlayRoot({ onOpenChange });
      return (
        <button data-open={String(rootProps.open)} onClick={() => rootProps.onOpenChange(true)}>
          probe
        </button>
      );
    }
    render(<Probe />);
    expect(openOverlayCount()).toBe(0);
    const button = container.querySelector("button")!;
    act(() => button.click());
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(openOverlayCount()).toBe(1);
    act(() => {
      dismissTopOverlay();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(openOverlayCount()).toBe(0);
    expect(button.getAttribute("data-open")).toBe("false");
  });

  it("controlled roots stay controlled: dismiss only notifies the consumer", () => {
    const onOpenChange = vi.fn();
    function Probe() {
      const rootProps = useRegisteredOverlayRoot({ open: true, onOpenChange });
      return <span data-open={String(rootProps.open)}>probe</span>;
    }
    render(<Probe />);
    expect(openOverlayCount()).toBe(1);
    act(() => {
      dismissTopOverlay();
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // The consumer kept `open` pinned true, so the overlay stays registered.
    expect(openOverlayCount()).toBe(1);
  });
});

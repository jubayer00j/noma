import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";

/** One candidate in the `[[` note-link picker. */
export interface NoteLinkItem {
  id: string;
  title: string;
}

type PickerProps = SuggestionProps<NoteLinkItem, NoteLinkItem>;

interface NoteLinkPickerHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

/**
 * The `[[` picker dropdown: a quiet list of note titles, keyboard-driven
 * (↑/↓/Enter) by the suggestion plugin through the imperative handle,
 * mouse-selectable otherwise. Selection routes through the suggestion
 * props' `command`, which swaps the `[[query` text for the link chip.
 */
const NoteLinkPicker = forwardRef<NoteLinkPickerHandle, PickerProps>(
  function NoteLinkPicker(props, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    // The imperative key handler outlives individual renders; read the
    // freshest props/selection through refs so it never acts on stale items.
    const propsRef = useRef(props);
    propsRef.current = props;
    const selectedRef = useRef(0);
    selectedRef.current = selectedIndex;

    useEffect(() => {
      setSelectedIndex(0);
    }, [props.items]);

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: ({ event }) => {
          const items = propsRef.current.items;
          if (items.length === 0) return false;
          if (event.key === "ArrowUp") {
            setSelectedIndex((index) => (index + items.length - 1) % items.length);
            return true;
          }
          if (event.key === "ArrowDown") {
            setSelectedIndex((index) => (index + 1) % items.length);
            return true;
          }
          if (event.key === "Enter") {
            const item = items[selectedRef.current];
            if (item) propsRef.current.command(item);
            return true;
          }
          return false;
        },
      }),
      [],
    );

    if (props.items.length === 0) {
      return (
        <div className="w-64 rounded-xl border border-border bg-popover px-3 py-2.5 text-xs text-muted-foreground shadow-lg">
          No notes match &ldquo;{props.query}&rdquo;
        </div>
      );
    }

    return (
      <div
        className="noma-scroll max-h-64 w-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
        role="listbox"
        aria-label="Link to a note"
      >
        {props.items.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
            onMouseDown={(event) => {
              // mousedown (not click): insert before the editor processes
              // the focus shift, and keep the editor selection intact.
              event.preventDefault();
              props.command(item);
            }}
            onMouseEnter={() => setSelectedIndex(index)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-popover-foreground",
              index === selectedIndex && "bg-accent",
            )}
          >
            <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate font-serif">{item.title}</span>
          </button>
        ))}
      </div>
    );
  },
);

/**
 * The @tiptap/suggestion render lifecycle for the picker: a React root in
 * a fixed-position host pinned under the `[[` match (the plugin supplies
 * the caret rect), following the same createRoot pattern the Read View
 * uses for chart mounts.
 */
export function createNoteLinkSuggestionRender() {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let handle: NoteLinkPickerHandle | null = null;

  const position = (props: PickerProps) => {
    if (!container) return;
    const rect = props.clientRect?.();
    if (!rect) return;
    const width = 256;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    container.style.left = `${left}px`;
    container.style.top = `${rect.bottom + 6}px`;
  };

  return {
    onStart(props: PickerProps) {
      container = document.createElement("div");
      container.style.position = "fixed";
      container.style.zIndex = "70";
      document.body.appendChild(container);
      root = createRoot(container);
      root.render(
        <NoteLinkPicker
          ref={(instance) => {
            handle = instance;
          }}
          {...props}
        />,
      );
      position(props);
    },
    onUpdate(props: PickerProps) {
      root?.render(
        <NoteLinkPicker
          ref={(instance) => {
            handle = instance;
          }}
          {...props}
        />,
      );
      position(props);
    },
    onKeyDown(props: SuggestionKeyDownProps) {
      // The workspace closes the open note on a window-level Escape; an
      // Escape that merely dismisses this picker must not reach it.
      if (props.event.key === "Escape") props.event.stopPropagation();
      return handle?.onKeyDown(props) ?? false;
    },
    onExit() {
      root?.unmount();
      container?.remove();
      root = null;
      container = null;
      handle = null;
    },
  };
}

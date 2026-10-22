import { useEffect, useMemo, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDatabase } from "@/lib/noma/DatabaseContext";
import { sanitizeHtml } from "@/lib/noma/sanitize";
import { ChartRenderer, parseChartElement } from "./chart-node";
import { useNoteSessionAttachments } from "./note-session-context";

/**
 * Static read renderer for note content. Renders the already-sanitized stored
 * HTML directly instead of constructing a Tiptap/ProseMirror editor, then
 * enhances the two custom node types the editor persists as plain markup:
 *
 * - `img[src^="noma-attachment://"]` resolved to blob/data URLs via IndexedDB
 * - `div[data-type="noma-chart"]` mounted with the existing ChartRenderer
 *
 * The `.tiptap` class keeps the shared `.noma-editor .tiptap` typography exactly
 * as the editor produced it. Sanitization is the same `sanitizeHtml` applied on
 * every content write, so the rendered markup carries identical trust.
 *
 * Enhancement is idempotent per element: the effect can re-run without the
 * HTML changing (e.g. the database handle is recreated on auth changes) and
 * will neither double-wrap images nor mount a second React root on a chart.
 */
export function NoteReadContent({ content }: { content: string }) {
  const { db } = useDatabase();
  // Decrypted payloads for a locked note open in an unlocked session; its
  // attachment rows hold ciphertext, so the session map wins when present.
  const sessionAttachments = useNoteSessionAttachments();
  const html = useMemo(() => sanitizeHtml(content || ""), [content]);
  const containerRef = useRef<HTMLDivElement>(null);
  // Chart React roots, keyed by host element. Kept across effect re-runs so a
  // chart is never mounted twice on the same element.
  const chartRoots = useRef(new Map<Element, Root>());

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let active = true;

    // Content changed: React replaced the DOM. Unmount roots whose host
    // element is gone so they can't leak or go stale.
    for (const [el, root] of chartRoots.current) {
      if (!container.contains(el)) {
        root.unmount();
        chartRoots.current.delete(el);
      }
    }

    for (const img of Array.from(container.querySelectorAll("img"))) {
      // Structural enhancement runs once per element; a re-run must not
      // double-wrap.
      if (!img.hasAttribute("data-noma-enhanced")) {
        img.setAttribute("data-noma-enhanced", "");
        // Mirror the editor image node view's presentation.
        img.classList.add(
          "rounded-lg",
          "max-w-full",
          "h-auto",
          "object-contain",
          "border",
          "border-border/40",
          "shadow-2xs",
        );
        const wrapper = document.createElement("div");
        wrapper.className = "relative inline-block my-2 max-w-full";
        img.replaceWith(wrapper);
        wrapper.appendChild(img);
      }
      // Attachment resolution runs whenever a database handle is available
      // and this image is still unresolved (the handle can arrive after mount
      // or be recreated, e.g. on auth changes).
      const src = img.getAttribute("src") || "";
      if (src.startsWith("noma-attachment://") && db && !img.hasAttribute("data-noma-resolved")) {
        const attachmentId = src.replace("noma-attachment://", "");
        db.attachments.get(attachmentId).then((att) => {
          if (!active) return;
          const data = att?.encrypted ? sessionAttachments?.get(attachmentId) : att?.data;
          if (data) {
            img.setAttribute("src", data);
            img.setAttribute("data-noma-resolved", "");
          }
        });
      }
    }

    for (const el of Array.from(container.querySelectorAll('div[data-type="noma-chart"]'))) {
      if (chartRoots.current.has(el)) continue;
      // Mirror the read-only chart node view's static wrapper (its edit/delete
      // chrome is already hidden in read mode, so only the frame is needed).
      el.classList.add(
        "group",
        "relative",
        "my-4",
        "rounded-xl",
        "border",
        "border-border",
        "bg-card",
        "p-3",
        "sm:p-4",
        "transition-all",
        "hover:border-ring/50",
        "max-w-full",
        "overflow-hidden",
      );
      const root = createRoot(el);
      root.render(<ChartRenderer chartData={parseChartElement(el as HTMLElement)} />);
      chartRoots.current.set(el, root);
    }

    return () => {
      active = false;
    };
  }, [html, db, sessionAttachments]);

  // Final cleanup when the read view unmounts (e.g. navigating between notes).
  useEffect(
    () => () => {
      for (const root of chartRoots.current.values()) root.unmount();
      chartRoots.current.clear();
    },
    [],
  );

  return <div ref={containerRef} className="tiptap" dangerouslySetInnerHTML={{ __html: html }} />;
}

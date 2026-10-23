import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { BackgroundColor, Color, TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { mergeAttributes, Node, type AnyExtension } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Suggestion, { type SuggestionOptions } from "@tiptap/suggestion";
import { useEffect, useState } from "react";
import { useDatabase } from "@/lib/noma/DatabaseContext";
import { NomaChartNode } from "./chart-node";
import { createNoteLinkSuggestionRender, type NoteLinkItem } from "./note-link-picker";
import { useNoteSessionAttachments } from "./note-session-context";

/**
 * Custom Tiptap Image extension resolving `noma-attachment://<id>` local attachment URIs
 * into renderable IndexedDB blob/data URLs dynamically without bloating `note.content`.
 */
function NomaImageComponent({ node }: NodeViewProps) {
  const { db } = useDatabase();
  // For a locked note in an unlocked session, attachment rows hold
  // ciphertext — resolve from the session's decrypted map instead.
  const sessionAttachments = useNoteSessionAttachments();
  const [src, setSrc] = useState<string>("");
  const srcAttr = node.attrs["src"] as string;
  const altAttr = node.attrs["alt"] as string | undefined;

  useEffect(() => {
    let active = true;
    if (srcAttr && srcAttr.startsWith("noma-attachment://")) {
      const attachmentId = srcAttr.replace("noma-attachment://", "");
      if (db) {
        db.attachments.get(attachmentId).then((att) => {
          if (!active) return;
          const data = att?.encrypted ? sessionAttachments?.get(attachmentId) : att?.data;
          if (data) setSrc(data);
        });
      }
    } else {
      setSrc(srcAttr || "");
    }
    return () => {
      active = false;
    };
  }, [srcAttr, db, sessionAttachments]);

  return (
    <div className="relative inline-block my-2 max-w-full">
      <img
        src={src || srcAttr}
        alt={altAttr || "Note image"}
        className="rounded-lg max-w-full h-auto object-contain border border-border/40 shadow-2xs"
      />
    </div>
  );
}

const NomaImageNode = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(NomaImageComponent);
  },
});

/** Editor rendering of a note-link chip: an inert pill (snapshot label).
 * Clicking selects the atom; navigation lives in the Read View and the
 * backlinks panel, never mid-edit. */
function NoteLinkChipView({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper
      as="span"
      data-note-link=""
      data-note-id={(node.attrs["noteId"] as string | null) ?? ""}
      className="noma-note-link-chip"
    >
      {(node.attrs["label"] as string) ?? ""}
    </NodeViewWrapper>
  );
}

interface NoteLinkNodeOptions {
  suggestion: Partial<SuggestionOptions<NoteLinkItem, NoteLinkItem>>;
}

/**
 * Inline atom linking to another note by id. Serialises as
 * `<span data-note-link data-note-id="…">Label</span>` — the id makes the
 * link rename-proof, the label is the title snapshot from insertion time
 * (the Read View re-resolves it to the live title). The `[[` suggestion
 * plugin is attached only when the host supplies an items callback
 * (i.e. in the workspace editor); the bare node keeps the schema able to
 * parse existing chips anywhere else.
 */
export const NoteLinkNode = Node.create<NoteLinkNodeOptions>({
  name: "noteLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return {
      suggestion: {},
    };
  },

  addAttributes() {
    return {
      noteId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-note-id"),
        renderHTML: (attributes) =>
          attributes["noteId"] ? { "data-note-id": attributes["noteId"] as string } : {},
      },
      label: {
        default: "",
        parseHTML: (element) => element.textContent ?? "",
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-note-link]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-note-link": "" }),
      (node.attrs["label"] as string) ?? "",
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(NoteLinkChipView);
  },

  addProseMirrorPlugins() {
    const suggestion = this.options.suggestion;
    if (typeof suggestion.items !== "function" || typeof suggestion.render !== "function") {
      return [];
    }
    return [
      Suggestion({
        editor: this.editor,
        char: "[[",
        ...suggestion,
      }),
    ];
  },
});

export interface NomaExtensionsOptions {
  /**
   * When true, the extensions are tuned for the read-only Read View:
   * links open on click and the editor placeholder is omitted.
   */
  readOnly?: boolean;
  /**
   * Supplies `[[` picker candidates for a query. When provided (and not
   * read-only), the note-link node gains its suggestion picker; when
   * omitted, link chips still parse and render but can't be inserted.
   */
  noteLinkItems?: (query: string) => NoteLinkItem[];
}

/**
 * The single source of truth for Noma's Tiptap document schema, shared by the
 * editor and the read-only Read View so both render notes identically.
 */
export function createNomaExtensions(options: NomaExtensionsOptions = {}): AnyExtension[] {
  const { readOnly = false, noteLinkItems } = options;
  const noteLink =
    !readOnly && noteLinkItems
      ? NoteLinkNode.configure({
          suggestion: {
            items: ({ query }) => noteLinkItems(query),
            command: ({ editor, range, props }) => {
              // Mirror @tiptap/extension-mention: if the character after
              // the match is a space it is consumed as the separator, so
              // the chip doesn't end up doubled-spaced.
              const nodeAfter = editor.view.state.selection.$to.nodeAfter;
              const overrideSpace = nodeAfter?.text?.startsWith(" ");
              if (overrideSpace) range.to += 1;
              editor
                .chain()
                .focus()
                .insertContentAt(range, [
                  {
                    type: "noteLink",
                    attrs: { noteId: props.id, label: props.title },
                  },
                  { type: "text", text: " " },
                ])
                .run();
            },
            render: createNoteLinkSuggestionRender,
          },
        })
      : NoteLinkNode;
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
    }),
    Underline,
    Link.configure({
      openOnClick: readOnly,
      autolink: true,
      HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
    }),
    TextStyle,
    Color,
    BackgroundColor,
    Highlight,
    NomaImageNode.configure({ inline: false }),
    noteLink,
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    ...(readOnly ? [] : [Placeholder.configure({ placeholder: "Start writing…" })]),
    NomaChartNode,
  ];
}

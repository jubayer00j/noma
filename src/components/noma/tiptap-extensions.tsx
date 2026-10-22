import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { BackgroundColor, Color, TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import { type AnyExtension } from "@tiptap/core";
import { ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useState } from "react";
import { useDatabase } from "@/lib/noma/DatabaseContext";
import { NomaChartNode } from "./chart-node";
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

export interface NomaExtensionsOptions {
  /**
   * When true, the extensions are tuned for the read-only Read View:
   * links open on click and the editor placeholder is omitted.
   */
  readOnly?: boolean;
}

/**
 * The single source of truth for Noma's Tiptap document schema, shared by the
 * editor and the read-only Read View so both render notes identically.
 */
export function createNomaExtensions(options: NomaExtensionsOptions = {}): AnyExtension[] {
  const { readOnly = false } = options;
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

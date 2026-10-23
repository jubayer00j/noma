import { format, formatDistanceToNowStrict } from "date-fns";
import { Bell, FolderOpen } from "lucide-react";
import React from "react";
import { NoteReadContent } from "./note-read-content";
import { noteTitle } from "@/lib/noma/notes";
import type { Folder, Note, Tag } from "@/lib/noma/types";

interface NoteReadViewProps {
  note: Note;
  folders: Folder[];
  tags: Tag[];
  fontSize: number;
  editorWidth: number;
  lineHeight: number;
  /** Live note lookup for resolving link chips; forwarded to the content renderer. */
  notesById?: ReadonlyMap<string, Note>;
  /** Opens the target of a clicked live link chip. */
  onOpenNote?: (noteId: string) => void;
}

/**
 * Dedicated reading experience for a note. Renders the stored (sanitized) HTML
 * statically — no Tiptap/ProseMirror construction — so opening a note skips
 * editor, schema, and view initialization entirely. Charts and attachment
 * images are enhanced after mount; typography comes from the shared
 * `.noma-editor .tiptap` styles, identical to the editor's output.
 */
export function NoteReadView({
  note,
  folders,
  tags,
  fontSize,
  editorWidth,
  lineHeight,
  notesById,
  onOpenNote,
}: NoteReadViewProps) {
  const folder = folders.find((item) => item.id === note.folderId) ?? null;
  const noteTags = tags.filter((tag) => note.tagIds.includes(tag.id));

  return (
    <article
      className="noma-read mx-auto w-full px-5 pb-32 sm:px-8 animate-in fade-in duration-200 motion-reduce:animate-none"
      style={
        {
          maxWidth: `${editorWidth}px`,
          "--noma-font-size": `${fontSize}px`,
          "--noma-line-height": String(lineHeight),
        } as React.CSSProperties
      }
      aria-label={noteTitle(note)}
    >
      <h1 className="mt-8 mb-3 font-serif text-3xl leading-tight font-semibold tracking-tight text-foreground sm:text-4xl">
        {noteTitle(note)}
      </h1>

      <div className="mb-8 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
        <span className="tabular-nums">
          Updated {formatDistanceToNowStrict(note.updatedAt, { addSuffix: true })}
        </span>
        {folder && (
          <span className="inline-flex items-center gap-1.5">
            <FolderOpen className="size-3.5" aria-hidden="true" />
            {folder.name}
          </span>
        )}
        {noteTags.slice(0, 5).map((tag) => (
          <span key={tag.id} className="rounded-full bg-secondary px-2 py-0.5 text-[11px]">
            #{tag.name}
          </span>
        ))}
        {note.reminderAt && (
          <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
            <Bell className="size-3" aria-hidden="true" />
            {format(note.reminderAt, "MMM d, p")}
          </span>
        )}
        {note.wordCount > 0 && <span className="tabular-nums">{note.wordCount} words</span>}
      </div>

      {/* `.noma-editor` scopes the shared content typography; the content is
          rendered statically (no editor instance, cursor, or chrome). */}
      <div className="noma-editor">
        <NoteReadContent content={note.content} notesById={notesById} onOpenNote={onOpenNote} />
      </div>
    </article>
  );
}

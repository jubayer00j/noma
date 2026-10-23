import { useMemo, type ReactNode } from "react";
import { CornerUpLeft, Link2 } from "lucide-react";
import { buildLinkIndex, extractNoteLinks } from "@/lib/noma/links";
import { noteTitle } from "@/lib/noma/notes";
import type { Note } from "@/lib/noma/types";

interface BacklinksPanelProps {
  /**
   * The open note. Its live content (decrypted in an unlocked session,
   * draft edits included) drives the "Links" list, so the panel is right
   * even where storage still holds ciphertext or the last autosave.
   */
  note: Note;
  /** The whole library, for the derived "Linked from" index. */
  notes: Note[];
  onOpenNote: (note: Note) => void;
  editorWidth: number;
}

/**
 * The quiet link footer under an open note: "Links" (outgoing) and
 * "Linked from" (incoming). Both lists are derived from content at render
 * time — never stored — so they cannot drift from the notes themselves.
 * Trashed or deleted-forever targets are omitted here; their chips in
 * the body already render muted with the last known label.
 */
export function BacklinksPanel({ note, notes, onOpenNote, editorWidth }: BacklinksPanelProps) {
  const byId = useMemo(() => new Map(notes.map((item) => [item.id, item])), [notes]);

  const outgoing = useMemo(
    () =>
      extractNoteLinks(note.content || "")
        .map((id) => byId.get(id))
        .filter((target): target is Note => Boolean(target) && !target!.deleted)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [note.content, byId],
  );

  const incoming = useMemo(() => {
    const index = buildLinkIndex(notes);
    return (index.incoming.get(note.id) ?? [])
      .map((id) => byId.get(id))
      .filter((source): source is Note => Boolean(source))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [notes, note.id, byId]);

  if (outgoing.length === 0 && incoming.length === 0) return null;

  const section = (title: string, icon: ReactNode, items: Note[]) =>
    items.length === 0 ? null : (
      <section key={title}>
        <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
          {icon}
          {title}
        </h3>
        <ul className="space-y-0.5">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onOpenNote(item)}
                className="w-full truncate rounded-md px-2 py-1.5 text-left font-serif text-[15px] text-foreground/90 transition-colors hover:bg-accent/60"
              >
                {noteTitle(item)}
              </button>
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <div className="mx-auto -mt-24 w-full px-5 sm:px-8" style={{ maxWidth: `${editorWidth}px` }}>
      <div className="space-y-6 border-t border-border/60 pt-6 pb-24">
        {section("Links", <Link2 className="size-3.5" aria-hidden="true" />, outgoing)}
        {section(
          "Linked from",
          <CornerUpLeft className="size-3.5" aria-hidden="true" />,
          incoming,
        )}
      </div>
    </div>
  );
}

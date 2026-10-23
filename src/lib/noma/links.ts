import type { Note } from "./types";

/**
 * Note-to-note links ("backlinks"). A link is an inline chip in a note's
 * HTML body — `<span data-note-link data-note-id="<note id>">Label</span>` —
 * inserted by the editor's `[[` picker. Links ride inside the content, so
 * backups and sync carry them with no schema change, and the reverse index
 * ("Linked from") is derived from the content at read time, never stored:
 * edits, deletes, restores and sync merges can never desync it.
 */

/**
 * The ordered, de-duplicated ids a body links to, in first-appearance
 * order. A pure string scan (no DOM) so it runs identically in the app,
 * in tests, and anywhere else content is read. It matches the element
 * form both the editor (`getHTML`) and the sanitiser emit — the stored,
 * sanitised form included.
 */
export function extractNoteLinks(content: string): string[] {
  if (!content) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  const tagPattern = /<span\b[^>]*>/gi;
  let tag: RegExpExecArray | null;
  while ((tag = tagPattern.exec(content)) !== null) {
    const markup = tag[0];
    if (!/\bdata-note-link\b/.test(markup)) continue;
    const idMatch =
      /\bdata-note-id\s*=\s*"([^"]*)"/.exec(markup) ??
      /\bdata-note-id\s*=\s*'([^']*)'/.exec(markup);
    const id = idMatch?.[1];
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export interface LinkIndex {
  /** Source note id → the note ids it links to (extraction order). */
  outgoing: Map<string, string[]>;
  /** Target note id → the note ids linking to it. */
  incoming: Map<string, string[]>;
}

/**
 * Builds the link graph over a set of notes. Sources are live, non-template
 * notes: a template's links are scaffolding for future notes, not a note
 * linking, and a trashed note stops contributing until restored. Locked
 * notes contribute nothing — their content is a ciphertext envelope, so
 * extraction naturally finds no links in it. Self-links are kept in
 * `outgoing` but excluded from a note's own `incoming` list.
 */
export function buildLinkIndex(notes: Note[]): LinkIndex {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const note of notes) {
    if (note.deleted || note.isTemplate) continue;
    const targets = extractNoteLinks(note.content || "");
    if (targets.length === 0) continue;
    outgoing.set(note.id, targets);
    for (const targetId of targets) {
      if (targetId === note.id) continue;
      const sources = incoming.get(targetId);
      if (sources) sources.push(note.id);
      else incoming.set(targetId, [note.id]);
    }
  }
  return { outgoing, incoming };
}

import type { NomaDatabase } from "./db";
import { createNote, duplicateNote, updateNote } from "./notes";
import { expandDatePlaceholder } from "./daily";
import type { Note } from "./types";

/**
 * Templates are ordinary notes flagged `isTemplate`. They ride the note
 * record, so backup and Drive sync carry them with no extra plumbing;
 * views and search partition them out (see view.ts / search.ts).
 *
 * Both directions go through `duplicateNote`, which already clones
 * attachments and remaps their ids inside the content — template images
 * just work. Locked notes never cross the boundary in either direction:
 * a template made from ciphertext would mint sealed notes.
 */
export async function saveAsTemplate(
  db: NomaDatabase,
  noteId: string,
  name: string,
): Promise<Note | null> {
  const source = await db.notes.get(noteId);
  if (!source || source.lock || source.deleted) return null;

  const copy = await duplicateNote(db, noteId);
  if (!copy) return null;

  await updateNote(db, copy.id, {
    title: name,
    isTemplate: true,
    dailyDate: null,
    dailyDefault: false,
    pinned: false,
    favorite: false,
    archived: false,
    reminderAt: null,
  });
  return (await db.notes.get(copy.id)) ?? copy;
}

export async function createNoteFromTemplate(
  db: NomaDatabase,
  templateId: string,
  now: Date = new Date(),
): Promise<Note | null> {
  const template = await db.notes.get(templateId);
  if (!template || !template.isTemplate || template.lock || template.deleted) return null;

  const copy = await duplicateNote(db, templateId);
  if (!copy) return null;

  // Expand placeholders against the template's own text for the title and
  // the duplicate's (attachment-remapped) content for the body, then route
  // both through updateNote so the new note is sanitised and word-counted.
  await updateNote(db, copy.id, {
    title: expandDatePlaceholder(template.title, now),
    content: expandDatePlaceholder(copy.content, now),
    isTemplate: false,
    dailyDate: null,
    dailyDefault: false,
    reminderAt: null,
  });
  return (await db.notes.get(copy.id)) ?? copy;
}

/** Marks one template as the daily default (or clears it with null),
 * keeping exactly one default across the library. */
export async function setDailyDefault(
  db: NomaDatabase,
  templateId: string | null,
): Promise<void> {
  const templates = await db.notes.filter((note) => Boolean(note.isTemplate)).toArray();
  for (const template of templates) {
    const shouldBeDefault = templateId !== null && template.id === templateId;
    if (Boolean(template.dailyDefault) !== shouldBeDefault) {
      await updateNote(db, template.id, { dailyDefault: shouldBeDefault });
    }
  }
}

/* ---------------- Built-in templates ----------------
 * Seeded lazily with deterministic ids: two devices that seed before
 * their first sync create the *same* records, which merge into one copy
 * instead of duplicating. A built-in the user deleted forever leaves a
 * tombstone behind, and seeding respects it — deleted means deleted. */

export const BUILTIN_TEMPLATES: ReadonlyArray<{ id: string; title: string; content: string }> = [
  {
    id: "9e107d9d-372b-4c81-9c3d-000000000001",
    title: "Meeting notes",
    content:
      "<h2>Attendees</h2><p></p><h2>Agenda</h2><ul><li><p></p></li></ul>" +
      "<h2>Notes</h2><p></p><h2>Action items</h2><ul><li><p></p></li></ul>",
  },
  {
    id: "9e107d9d-372b-4c81-9c3d-000000000002",
    title: "Morning pages",
    content:
      "<h2>Mind dump</h2><p>Write whatever is on your mind — no editing, no judgement.</p>" +
      "<h2>Today's one thing</h2><p></p><h2>Gratitude</h2><p></p>",
  },
  {
    id: "9e107d9d-372b-4c81-9c3d-000000000003",
    title: "Checklist",
    content: "<h2>Checklist</h2><ul><li><p>First task</p></li><li><p>Second task</p></li></ul>",
  },
];

export async function ensureBuiltinTemplates(db: NomaDatabase): Promise<void> {
  for (const builtin of BUILTIN_TEMPLATES) {
    if (await db.notes.get(builtin.id)) continue;
    if (db.tombstones) {
      const tombstone = await db.tombstones.get(builtin.id);
      if (tombstone && tombstone.entity === "note") continue;
    }
    const note = await createNote(db, {
      id: builtin.id,
      title: builtin.title,
      isTemplate: true,
      dailyDefault: false,
    });
    // Route content through updateNote for sanitising + word count.
    await updateNote(db, note.id, { content: builtin.content });
  }
}

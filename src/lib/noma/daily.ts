import type { NomaDatabase } from "./db";
import { createNote, updateNote } from "./notes";
import { createNoteFromTemplate } from "./templates";
import type { Note } from "./types";

/**
 * Daily notes: one journal note per local calendar day, identified by its
 * `dailyDate` key. The key is built from local date components — never from
 * `toISOString()`, which is UTC and would roll the "day" over hours before
 * local midnight in positive-offset timezones.
 */
export function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Long-form local date for titles, e.g. "Friday, 23 October 2026". */
export function formatDailyTitle(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/** The one v1 template placeholder: `{{date}}` → the long-form local date. */
export function expandDatePlaceholder(text: string, date: Date): string {
  return text.split("{{date}}").join(formatDailyTitle(date));
}

/**
 * In-flight creations, keyed per database + day, so a double-tap (or a
 * Today tap racing another entry point) can never mint two daily notes
 * for the same day — one-per-day is an invariant, not a preference.
 */
const inFlightDailyNotes = new Map<string, Promise<Note>>();

export function getOrCreateDailyNote(
  db: NomaDatabase,
  now: Date = new Date(),
): Promise<Note> {
  const key = localDateKey(now);
  const flightKey = `${db.name}:${key}`;
  const existing = inFlightDailyNotes.get(flightKey);
  if (existing) return existing;
  const promise = (async () => {
    try {
      return await findOrCreateDailyNote(db, key, now);
    } finally {
      inFlightDailyNotes.delete(flightKey);
    }
  })();
  inFlightDailyNotes.set(flightKey, promise);
  return promise;
}

async function findOrCreateDailyNote(
  db: NomaDatabase,
  key: string,
  now: Date,
): Promise<Note> {
  const sameDay = await db.notes.filter((note) => note.dailyDate === key).toArray();

  const live = sameDay.find((note) => !note.deleted);
  if (live) return live;

  // Trashed earlier today: restore it rather than minting a second note
  // for the same day.
  const trashed = sameDay.find((note) => note.deleted);
  if (trashed) {
    await updateNote(db, trashed.id, { deleted: false, deletedAt: null });
    return (await db.notes.get(trashed.id)) ?? { ...trashed, deleted: false, deletedAt: null };
  }

  // Seed the new page from the daily-default template, if one is set.
  // Instantiation goes through the "Use template" path so attachments
  // are cloned and their refs remapped — the daily note owns its copies
  // and keeps working if the template is later deleted forever. (Copying
  // the template's raw content string instead would leave the daily
  // note referencing attachment rows the template owns.)
  const dailyDefault = (
    await db.notes
      .filter((note) => Boolean(note.isTemplate) && Boolean(note.dailyDefault) && !note.deleted)
      .toArray()
  )[0];
  if (dailyDefault) {
    const seeded = await createNoteFromTemplate(db, dailyDefault.id, now);
    if (seeded) {
      // The page is the day's own note: it takes the day's title and
      // lives outside whatever folder/tag set the template carries.
      await updateNote(db, seeded.id, {
        title: formatDailyTitle(now),
        dailyDate: key,
        folderId: null,
        tagIds: [],
      });
      return (await db.notes.get(seeded.id)) ?? seeded;
    }
  }

  const note = await createNote(db, { title: formatDailyTitle(now), dailyDate: key });
  // createNote stores its init verbatim; route the content through
  // updateNote so it is sanitised and word-counted like every other note.
  await updateNote(db, note.id, { content: "" });
  return (await db.notes.get(note.id)) ?? note;
}

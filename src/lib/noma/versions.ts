import { type NomaDatabase, newId } from "./db";
import { countWords, sanitizeHtml } from "./sanitize";
import { maintainSemanticIndexForNote } from "./semantic";
import type { Note, NoteVersion } from "./types";

/**
 * Per-note version history.
 *
 * A version is the title + content of a note state that was replaced by
 * a later edit. Snapshots hook the single write path (`updateNote`) and
 * follow a "settled state" rule: the replaced state only becomes a
 * version once it had rested untouched for SETTLE_MS, so autosave
 * bursts (a write every ~400 ms while typing) produce nothing, while
 * the state a user paused on is preserved before the next edit lands.
 * History therefore tracks editing sessions, not keystrokes.
 *
 * Two hard rules:
 * - Locked notes have NO history. A snapshot stores the note's own
 *   storage form, so a plaintext version of a note that later gets
 *   locked would defeat the encryption. Nothing is ever snapshotted
 *   while a note carries a lock, and locking purges existing history
 *   (see lockNote). In an unlocked session, content saves bypass
 *   updateNote entirely (saveLockedNoteContent re-seals first), and a
 *   title-only save still sees the stored record's lock and no-ops
 *   here — ciphertext is never copied into a version row.
 * - History is local to this device. Versions are not part of the
 *   backup payload and never sync (the versions table is simply not
 *   enumerated there); cross-device safety comes from sync's
 *   note-level conflict copies instead.
 */

/** A replaced state must have rested at least this long to become a version. */
export const SETTLE_MS = 60_000;

/** Hard cap on kept versions per note; the oldest are pruned beyond it. */
export const MAX_VERSIONS = 50;

/** Keeps only the newest MAX_VERSIONS rows for a note. */
async function pruneVersions(db: NomaDatabase, noteId: string): Promise<void> {
  if (!db.noteVersions) return;
  const rows = await db.noteVersions.where("noteId").equals(noteId).toArray();
  if (rows.length <= MAX_VERSIONS) return;
  rows.sort((a, b) => b.createdAt - a.createdAt);
  await db.noteVersions.bulkDelete(rows.slice(MAX_VERSIONS).map((row) => row.id));
}

async function insertVersion(db: NomaDatabase, note: Note): Promise<void> {
  if (!db.noteVersions) return;
  await db.noteVersions.put({
    id: newId(),
    noteId: note.id,
    title: note.title,
    content: note.content,
    // The version is timestamped by the state it holds: when that text
    // was current, i.e. the replaced state's own updatedAt.
    createdAt: note.updatedAt,
  });
  await pruneVersions(db, note.id);
}

/**
 * Snapshots the note state about to be replaced, if it had settled
 * (see the module comment). No-ops for locked notes and for states
 * younger than SETTLE_MS. The caller (updateNote) only calls this when
 * title or content actually changed.
 */
export async function snapshotIfSettled(
  db: NomaDatabase,
  oldNote: Note,
  now: number = Date.now(),
): Promise<void> {
  if (oldNote.lock) return;
  if (now - oldNote.updatedAt < SETTLE_MS) return;
  await insertVersion(db, oldNote);
}

/**
 * Snapshots unconditionally (restore uses it so a restore is itself
 * undoable even when the current state is fresh). Same lock guard.
 */
export async function forceSnapshot(db: NomaDatabase, note: Note): Promise<void> {
  if (note.lock) return;
  await insertVersion(db, note);
}

/** All versions of a note, newest first. */
export async function listVersions(db: NomaDatabase, noteId: string): Promise<NoteVersion[]> {
  if (!db.noteVersions) return [];
  const rows = await db.noteVersions.where("noteId").equals(noteId).toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/** Deletes every version of one note (permanent note deletion, locking). */
export async function clearVersions(db: NomaDatabase, noteId: string): Promise<void> {
  if (!db.noteVersions) return;
  await db.noteVersions.where("noteId").equals(noteId).delete();
}

/**
 * Restores a version: the current state is force-snapshotted first (so
 * the restore can itself be undone), then the version's title + content
 * are written back with the same sanitising write updateNote performs.
 * Returns false when the version or its note is gone — or the note is
 * locked, in which case nothing is written at all: plaintext must never
 * land on a sealed record.
 */
export async function restoreVersion(db: NomaDatabase, versionId: string): Promise<boolean> {
  if (!db.noteVersions) return false;
  const version = await db.noteVersions.get(versionId);
  if (!version) return false;
  const note = await db.notes.get(version.noteId);
  if (!note || note.lock) return false;

  await forceSnapshot(db, note);

  const content = sanitizeHtml(version.content);
  await db.notes.update(note.id, {
    title: version.title,
    content,
    wordCount: countWords(content),
    updatedAt: Date.now(),
  });
  // The restore writes directly (not via updateNote), so refresh the
  // note's semantic vector here: the stored vector described the
  // pre-restore content and must never be what search matches against.
  await maintainSemanticIndexForNote(db, note.id);
  return true;
}

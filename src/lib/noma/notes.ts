import { type NomaDatabase, newId } from "./db";
import {
  cancelNotification,
  notificationSnapshotForNote,
  scheduleNotification,
} from "./notifications";
import { countWords, sanitizeHtml } from "./sanitize";
import { notePreviewText } from "./note-export";
import { cleanupOrphanedAttachments } from "./media";
import { recordTombstone } from "./sync";
import { maintainSemanticIndexForNote } from "./semantic";
import { clearVersions, snapshotIfSettled } from "./versions";
import type {
  AlarmToneMode,
  Folder,
  Note,
  Reminder,
  ReminderAlertType,
  Tag,
  AttachmentMeta,
} from "./types";

export async function createNote(db: NomaDatabase, init: Partial<Note> = {}): Promise<Note> {
  const now = Date.now();
  const note: Note = {
    id: newId(),
    title: "",
    content: "",
    contentFormat: "tiptap-html",
    createdAt: now,
    updatedAt: now,
    folderId: null,
    tagIds: [],
    pinned: false,
    favorite: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    reminderAt: null,
    wordCount: 0,
    ...init,
  };
  await db.notes.put(note);
  return note;
}

export async function updateNote(
  db: NomaDatabase,
  id: string,
  patch: Partial<Note>,
): Promise<void> {
  const next: Partial<Note> = { ...patch, updatedAt: Date.now() };
  if (typeof patch.content === "string") {
    next.content = sanitizeHtml(patch.content);
    next.wordCount = countWords(next.content);
  }
  // Version history (see versions.ts): when the patch touches title or
  // content, snapshot the stored state first — but only if it actually
  // differs from what the patch will write, compared like-for-like
  // against the sanitised values in `next`. The snapshot itself applies
  // the settled-state rule and never fires for a locked note (the
  // stored record carries the lock), so no ciphertext is ever copied
  // into a version. Flag-only patches skip the extra read entirely.
  if (patch.title !== undefined || patch.content !== undefined) {
    const stored = await db.notes.get(id);
    if (stored) {
      const titleChanged = (next.title ?? stored.title) !== stored.title;
      const contentChanged = (next.content ?? stored.content) !== stored.content;
      if (titleChanged || contentChanged) await snapshotIfSettled(db, stored);
    }
  }
  await db.notes.update(id, next);
  // Semantic search maintenance (#8.5): when a patch changes what a
  // note's embedding is made of (title/content) or whether it may keep
  // one (deleted/lock/template), refresh its vector — fire-and-forget,
  // best-effort, and a no-op unless a valid index already exists (the
  // user's Settings build was the opt-in). See semantic.ts.
  if (
    patch.title !== undefined ||
    patch.content !== undefined ||
    patch.deleted !== undefined ||
    patch.lock !== undefined ||
    patch.isTemplate !== undefined
  ) {
    void maintainSemanticIndexForNote(db, id);
  }
}

export async function duplicateNote(db: NomaDatabase, id: string): Promise<Note | null> {
  const source = await db.notes.get(id);
  if (!source) return null;
  // A locked note's body is ciphertext with attachment references sealed
  // inside it, so its attachments can't be re-mapped to fresh ids. The UI
  // asks the user to unlock the note first, then duplicate.
  if (source.lock) return null;

  const now = Date.now();
  const newNoteId = newId();

  // Scan source content for all noma-attachment://<OLD_ID> references
  let rewrittenContent = source.content || "";
  const attachmentRegex = /noma-attachment:\/\/([a-zA-Z0-9_-]+)/g;
  const referencedIds = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = attachmentRegex.exec(source.content || "")) !== null) {
    if (match[1]) referencedIds.add(match[1]);
  }

  // Clone each referenced attachment so duplicated notes have independent attachment records
  for (const oldAttachmentId of referencedIds) {
    try {
      const sourceAttachment = await db.attachments.get(oldAttachmentId);
      if (sourceAttachment && sourceAttachment.data) {
        const newAttachmentId = newId();
        const clonedAttachment: AttachmentMeta = {
          ...sourceAttachment,
          id: newAttachmentId,
          noteId: newNoteId,
          createdAt: now,
          updatedAt: now,
        };
        await db.attachments.put(clonedAttachment);

        // Replace all occurrences of old attachment ID with new attachment ID in the duplicated content
        const replaceRegex = new RegExp(`noma-attachment://${oldAttachmentId}`, "g");
        rewrittenContent = rewrittenContent.replace(
          replaceRegex,
          `noma-attachment://${newAttachmentId}`,
        );
      }
    } catch (err) {
      console.error(`Failed to clone attachment ${oldAttachmentId} during note duplication`, err);
    }
  }

  const { id: _drop, ...rest } = source;
  const newNote: Note = {
    ...rest,
    id: newNoteId,
    content: rewrittenContent,
    createdAt: now,
    updatedAt: now,
    reminderAt: null,
    // A copy is a fresh note, never a second owner of the source's day:
    // it must not inherit dailyDate (one daily note per day) nor the
    // dailyDefault slot (exactly one template may hold it). isTemplate
    // DOES carry over — duplicating a template yields a template.
    dailyDate: null,
    dailyDefault: false,
    title: source.title ? `${source.title} (copy)` : "Untitled (copy)",
  };

  await db.notes.put(newNote);
  return newNote;
}

export const togglePinned = (db: NomaDatabase, n: Note) =>
  updateNote(db, n.id, { pinned: !n.pinned });
export const toggleFavorite = (db: NomaDatabase, n: Note) =>
  updateNote(db, n.id, { favorite: !n.favorite });
export const setArchived = (db: NomaDatabase, n: Note, archived: boolean) =>
  updateNote(db, n.id, { archived });

export const trashNote = async (db: NomaDatabase, id: string) => {
  await updateNote(db, id, { deleted: true, deletedAt: Date.now(), pinned: false });
  await cleanupOrphanedAttachments(db);
};

export const restoreNote = (db: NomaDatabase, id: string) =>
  updateNote(db, id, { deleted: false, deletedAt: null });

export async function deleteNoteForever(db: NomaDatabase, id: string): Promise<void> {
  // Find associated reminders to cancel notifications
  const reminders = await db.reminders.where("noteId").equals(id).toArray();
  for (const reminder of reminders) {
    await cancelNotification(reminder.id, reminder.notificationId);
  }

  await db.transaction(
    "rw",
    db.notes,
    db.attachments,
    db.reminders,
    db.noteVersions,
    db.noteEmbeddings,
    async () => {
      await db.attachments.where("noteId").equals(id).delete();
      await db.reminders.where("noteId").equals(id).delete();
      // Permanent deletion purges the note's version history with it
      // (soft-delete/trash keeps history — a restored note keeps its past).
      await clearVersions(db, id);
      // The semantic vector is derived from the note's content and dies
      // with it — no row may outlive the note (semantic.ts).
      if (db.noteEmbeddings) await db.noteEmbeddings.delete(id);
      await db.notes.delete(id);
    },
  );

  // The note tombstone cascades to its attachments and reminders on other
  // devices, so they don't need markers of their own.
  await recordTombstone(db, "note", id);
  await cleanupOrphanedAttachments(db);
}

export async function emptyTrash(db: NomaDatabase): Promise<number> {
  const trashed = await db.notes.filter((n) => n.deleted).toArray();
  for (const note of trashed) await deleteNoteForever(db, note.id);
  await cleanupOrphanedAttachments(db);
  return trashed.length;
}

/* Folders */

export async function createFolder(db: NomaDatabase, name: string): Promise<Folder> {
  const now = Date.now();
  const folder: Folder = {
    id: newId(),
    name: name.trim() || "Untitled folder",
    parentId: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.folders.put(folder);
  return folder;
}

export const renameFolder = (db: NomaDatabase, id: string, name: string) =>
  db.folders.update(id, { name: name.trim(), updatedAt: Date.now() });

export async function deleteFolder(db: NomaDatabase, id: string): Promise<void> {
  await db.transaction("rw", db.folders, db.notes, async () => {
    const notes = await db.notes.where("folderId").equals(id).toArray();
    for (const note of notes) await updateNote(db, note.id, { folderId: null });
    await db.folders.delete(id);
  });
  await recordTombstone(db, "folder", id);
}

export const moveNote = (db: NomaDatabase, noteId: string, folderId: string | null) =>
  updateNote(db, noteId, { folderId });

/* Tags */

export async function createTag(db: NomaDatabase, name: string): Promise<Tag> {
  const clean = name.trim().replace(/^#/, "");
  const existing = await db.tags
    .filter((t) => t.name.toLowerCase() === clean.toLowerCase())
    .first();
  if (existing) return existing;
  const now = Date.now();
  const tag: Tag = { id: newId(), name: clean || "untitled", createdAt: now, updatedAt: now };
  await db.tags.put(tag);
  return tag;
}

export const renameTag = (db: NomaDatabase, id: string, name: string) =>
  db.tags.update(id, { name: name.trim().replace(/^#/, ""), updatedAt: Date.now() });

export async function deleteTag(db: NomaDatabase, id: string): Promise<void> {
  await db.transaction("rw", db.tags, db.notes, async () => {
    const notes = await db.notes.filter((n) => n.tagIds.includes(id)).toArray();
    for (const note of notes) {
      await updateNote(db, note.id, { tagIds: note.tagIds.filter((t) => t !== id) });
    }
    await db.tags.delete(id);
  });
  await recordTombstone(db, "tag", id);
}

export async function setNoteTags(
  db: NomaDatabase,
  noteId: string,
  tagIds: string[],
): Promise<void> {
  await updateNote(db, noteId, { tagIds });
}

export function notePreview(note: Note, length = 140): string {
  const cached = notePreviewCache.get(note.id);
  const contentHash = hashNoteContent(note.content);
  if (cached && cached.contentHash === contentHash && cached.length === length) {
    return cached.preview;
  }
  const preview = computeNotePreview(note, length);
  notePreviewCache.set(note.id, { contentHash, length, preview });
  // Backstop so the cache can never grow without limit, even if pruning
  // hasn't run yet (e.g. right after mass deletions). Map preserves
  // insertion order, so the oldest entries go first.
  while (notePreviewCache.size > NOTE_PREVIEW_CACHE_MAX) {
    const oldest = notePreviewCache.keys().next();
    if (oldest.done) break;
    notePreviewCache.delete(oldest.value);
  }
  return preview;
}

/**
 * Drops cached previews for notes that no longer exist, keeping memory
 * bounded. Call with the currently-live note ids (e.g. after the notes
 * list refreshes). Returns the number of entries removed.
 */
export function pruneNotePreviewCache(livingIds: Iterable<string>): number {
  const living = new Set(livingIds);
  let removed = 0;
  for (const id of notePreviewCache.keys()) {
    if (!living.has(id)) {
      notePreviewCache.delete(id);
      removed++;
    }
  }
  return removed;
}

/* ------- Note preview cache (see notePreview above) ------- */

interface NotePreviewCacheEntry {
  /** FNV-1a hash of the note content the preview was computed from. */
  contentHash: number;
  /** The `length` argument the preview was computed with. */
  length: number;
  preview: string;
}

const notePreviewCache = new Map<string, NotePreviewCacheEntry>();

/** Hard upper bound so the cache can never grow forever. */
const NOTE_PREVIEW_CACHE_MAX = 10000;

/**
 * Cheap FNV-1a hash used to detect content changes. Hashing is O(n) but
 * native-speed (no DOM work), and it means non-content updates (pin, tags,
 * reminders) that bump `updatedAt` don't needlessly invalidate the preview.
 */
function hashNoteContent(content: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The preview computation. The text comes from note-export's
 * structure-aware preview builder (list items keep their markers) rather
 * than the flat htmlToPlainText extractor, which strips markers and made
 * structured notes read as one unordered run on the cards.
 */
function computeNotePreview(note: Note, length: number): string {
  // Locked notes are title-only everywhere: never surface body text.
  if (note.lock) return "";
  const text = notePreviewText(note.content);
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

export function noteTitle(note: Note): string {
  return note.title.trim() || "Untitled note";
}

/* Reminders */

export interface SetReminderOptions {
  alertType?: ReminderAlertType | undefined;
  alarmToneMode?: AlarmToneMode | undefined;
  alarmToneUri?: string | undefined;
  alarmToneName?: string | undefined;
  alarmVibrate?: boolean | undefined;
}

function applyAlertFields(
  reminder: Reminder,
  options?: SetReminderOptions,
): { alertType: ReminderAlertType; scheduled: boolean } {
  const alertType: ReminderAlertType = options?.alertType ?? reminder.alertType ?? "notification";
  if (alertType === "phone-alarm") {
    // Phone alarms are handed to the external Clock app; Noma must not also
    // schedule its own notification for the same reminder.
    reminder.alertType = "phone-alarm";
    reminder.alarmToneMode = options?.alarmToneMode ?? reminder.alarmToneMode ?? "system";
    reminder.alarmToneUri = options?.alarmToneUri ?? reminder.alarmToneUri;
    reminder.alarmToneName = options?.alarmToneName ?? reminder.alarmToneName;
    reminder.alarmVibrate = options?.alarmVibrate ?? reminder.alarmVibrate ?? true;
    reminder.notificationId = undefined;
    return { alertType, scheduled: false };
  }
  reminder.alertType = "notification";
  reminder.alarmToneMode = undefined;
  reminder.alarmToneUri = undefined;
  reminder.alarmToneName = undefined;
  reminder.alarmVibrate = undefined;
  return { alertType, scheduled: true };
}

export async function setNoteReminder(
  db: NomaDatabase,
  noteId: string,
  scheduledAt: number,
  options?: SetReminderOptions,
): Promise<Reminder> {
  const existingList = await db.reminders.where("noteId").equals(noteId).toArray();
  const primary = existingList[0];
  const extras = existingList.slice(1);
  const now = Date.now();

  // Cancel notifications & remove any duplicate rows safely
  for (const extra of extras) {
    await cancelNotification(extra.id, extra.notificationId);
    await db.reminders.delete(extra.id);
    await recordTombstone(db, "reminder", extra.id);
  }

  if (primary) {
    await cancelNotification(primary.id, primary.notificationId);
    const updated: Reminder = {
      ...primary,
      scheduledAt,
      status: "pending",
      updatedAt: now,
    };
    const { scheduled } = applyAlertFields(updated, options);
    if (scheduled) {
      const note = await db.notes.get(noteId);
      const notifId = await scheduleNotification(updated, notificationSnapshotForNote(note));
      if (notifId !== undefined) updated.notificationId = notifId;
    }
    await db.reminders.put(updated);
    await db.notes.update(noteId, { reminderAt: scheduledAt, updatedAt: now });
    return updated;
  }

  const reminder: Reminder = {
    id: newId(),
    noteId,
    scheduledAt,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };

  const { scheduled } = applyAlertFields(reminder, options);
  if (scheduled) {
    const note = await db.notes.get(noteId);
    const notifId = await scheduleNotification(reminder, notificationSnapshotForNote(note));
    if (notifId !== undefined) reminder.notificationId = notifId;
  }

  await db.transaction("rw", db.reminders, db.notes, async () => {
    await db.reminders.put(reminder);
    await db.notes.update(noteId, { reminderAt: scheduledAt, updatedAt: now });
  });

  return reminder;
}

export async function deleteNoteReminder(db: NomaDatabase, noteId: string): Promise<void> {
  const existingList = await db.reminders.where("noteId").equals(noteId).toArray();
  for (const existing of existingList) {
    await cancelNotification(existing.id, existing.notificationId);
  }
  await db.transaction("rw", db.reminders, db.notes, async () => {
    await db.reminders.where("noteId").equals(noteId).delete();
    await db.notes.update(noteId, { reminderAt: null });
  });
  for (const existing of existingList) {
    await recordTombstone(db, "reminder", existing.id);
  }
}

export async function updateReminderStatus(
  db: NomaDatabase,
  reminderId: string,
  status: "completed" | "dismissed" | "pending",
): Promise<void> {
  const existing = await db.reminders.get(reminderId);
  if (!existing) return;

  const now = Date.now();

  if (status !== "pending") {
    await cancelNotification(existing.id, existing.notificationId);
    await db.transaction("rw", db.reminders, db.notes, async () => {
      await db.reminders.update(reminderId, { status, updatedAt: now });
      await db.notes.update(existing.noteId, { reminderAt: null, updatedAt: now });
    });
  } else {
    // Reopening as pending
    const updatedReminder: Reminder = {
      ...existing,
      status: "pending",
      updatedAt: now,
    };

    let notifId: number | undefined;
    // Phone alarms live in the external Clock app; reopening only restores the
    // Noma reminder row — it cannot recreate the Clock alarm.
    if (existing.scheduledAt > now && existing.alertType !== "phone-alarm") {
      const note = await db.notes.get(existing.noteId);
      notifId = await scheduleNotification(updatedReminder, notificationSnapshotForNote(note));
    }

    await db.transaction("rw", db.reminders, db.notes, async () => {
      await db.reminders.update(reminderId, {
        status: "pending",
        updatedAt: now,
        ...(notifId !== undefined ? { notificationId: notifId } : {}),
      });
      await db.notes.update(existing.noteId, {
        reminderAt: existing.scheduledAt,
        updatedAt: now,
      });
    });
  }
}

export async function cleanupOrphanedReminders(db: NomaDatabase): Promise<void> {
  const notes = await db.notes.toArray();
  const validNoteIds = new Set(notes.map((n) => n.id));
  const reminders = await db.reminders.toArray();

  // 1. Remove orphaned reminders (whose note no longer exists)
  const orphaned = reminders.filter((r) => !validNoteIds.has(r.noteId));
  for (const r of orphaned) {
    await cancelNotification(r.id, r.notificationId);
    await db.reminders.delete(r.id);
    await recordTombstone(db, "reminder", r.id);
  }

  // 2. Group non-orphaned reminders by noteId and clean up accidental duplicates
  const reminderGroups = new Map<string, Reminder[]>();
  for (const r of reminders) {
    if (!validNoteIds.has(r.noteId)) continue;
    const group = reminderGroups.get(r.noteId) ?? [];
    group.push(r);
    reminderGroups.set(r.noteId, group);
  }

  for (const group of reminderGroups.values()) {
    if (group.length > 1) {
      // Keep the most recently updated reminder, delete extra duplicate rows
      group.sort((a, b) => b.updatedAt - a.updatedAt);
      const extras = group.slice(1);
      for (const extra of extras) {
        await cancelNotification(extra.id, extra.notificationId);
        await db.reminders.delete(extra.id);
        await recordTombstone(db, "reminder", extra.id);
      }
    }
  }

  // 3. Re-read/recompute remaining reminders from database after deletions
  const survivingReminders = await db.reminders.toArray();
  const survivingMap = new Map<string, Reminder>();
  for (const r of survivingReminders) {
    survivingMap.set(r.noteId, r);
  }

  // 4. Enforce note.reminderAt accuracy against surviving post-deletion state
  for (const note of notes) {
    const surviving = survivingMap.get(note.id);
    if (surviving && surviving.status === "pending") {
      if (note.reminderAt !== surviving.scheduledAt) {
        await db.notes.update(note.id, { reminderAt: surviving.scheduledAt });
      }
    } else {
      if (note.reminderAt !== null) {
        await db.notes.update(note.id, { reminderAt: null });
      }
    }
  }
}

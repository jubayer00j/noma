import JSZip from "jszip";
import { type NomaDatabase, newId } from "./db";
import { cleanupOrphanedReminders } from "./notes";
import { cleanupOrphanedAttachments } from "./media";
import { scheduleNotification } from "./notifications";
import { sanitizeHtml } from "./sanitize";
import {
  BACKUP_FORMAT_VERSION,
  NOMA_VERSION,
  type AttachmentMeta,
  type BackupManifest,
  type Folder,
  type Note,
  type Reminder,
  type Tag,
} from "./types";

export interface ExportOptions {
  noteIds?: string[];
  folderId?: string | null;
  includeAttachments?: boolean;
  includeFolders?: boolean;
  includeTags?: boolean;
  includeSettings?: boolean;
  includeReminders?: boolean;
}

export interface BackupPayload {
  manifest: BackupManifest;
  notes: Note[];
  folders: Folder[];
  tags: Tag[];
  attachments: AttachmentMeta[];
  reminders: Reminder[];
  settings: Record<string, unknown> | null;
}

export function backupFileName(date = new Date()): string {
  return `Noma-Backup-${date.toISOString().slice(0, 10)}.zip`;
}

/* ---------------- Export ---------------- */

export async function collectBackup(
  db: NomaDatabase,
  ownerId: string | null,
  options: ExportOptions = {},
): Promise<BackupPayload> {
  const {
    noteIds,
    folderId,
    includeAttachments = true,
    includeFolders = true,
    includeTags = true,
    includeSettings = true,
    includeReminders = true,
  } = options;

  let notes = await db.notes.toArray();
  if (noteIds?.length) notes = notes.filter((n) => noteIds.includes(n.id));
  else if (folderId !== undefined) notes = notes.filter((n) => n.folderId === folderId);

  const folders = includeFolders ? await db.folders.toArray() : [];
  const tags = includeTags ? await db.tags.toArray() : [];
  const noteIdSet = new Set(notes.map((n) => n.id));
  const attachments = includeAttachments
    ? (await db.attachments.toArray()).filter((a) => noteIdSet.has(a.noteId))
    : [];
  const reminders = includeReminders
    ? (await db.reminders.toArray()).filter((r) => noteIdSet.has(r.noteId))
    : [];
  const rawSettings = includeSettings ? ((await db.settings.get("app")) ?? null) : null;
  const sanitizedSettings = rawSettings
    ? {
        ...rawSettings,
        passwordHash: null,
        passwordSalt: null,
        patternHash: null,
        patternSalt: null,
        failedAttempts: 0,
        lockoutUntil: null,
        appLockEnabled: false,
        unlockMethods: {
          biometric: false,
          pattern: false,
          password: false,
        },
      }
    : null;

  return {
    manifest: {
      backupFormatVersion: BACKUP_FORMAT_VERSION,
      ownerId: ownerId,
      libraryId: db.name,
      nomaVersion: NOMA_VERSION,
      createdAt: new Date().toISOString(),
      noteCount: notes.length,
      folderCount: folders.length,
      tagCount: tags.length,
      attachmentCount: attachments.length,
      reminderCount: reminders.length,
    },
    notes,
    folders,
    tags,
    attachments,
    reminders,
    settings: sanitizedSettings as unknown as Record<string, unknown> | null,
  };
}

export async function buildBackupZip(
  db: NomaDatabase,
  ownerId: string | null,
  options: ExportOptions = {},
): Promise<{ blob: Blob; payload: BackupPayload }> {
  const payload = await collectBackup(db, ownerId, options);
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(payload.manifest, null, 2));
  zip.file("folders.json", JSON.stringify(payload.folders, null, 2));
  zip.file("tags.json", JSON.stringify(payload.tags, null, 2));
  zip.file("reminders.json", JSON.stringify(payload.reminders, null, 2));
  zip.file("settings.json", JSON.stringify(payload.settings, null, 2));

  const notesFolder = zip.folder("notes")!;
  for (const note of payload.notes)
    notesFolder.file(`${note.id}.json`, JSON.stringify(note, null, 2));

  if (payload.attachments.length) {
    const attachmentsFolder = zip.folder("attachments")!;
    attachmentsFolder.file(
      "index.json",
      JSON.stringify(
        payload.attachments.map(({ data: _d, ...m }) => m),
        null,
        2,
      ),
    );
    for (const attachment of payload.attachments) {
      if (attachment.encrypted) {
        // Locked-note attachment: `data` is an encryption envelope, not a
        // data URL. Store it verbatim; the `<id>.json` record (used on
        // import) carries the same envelope.
        attachmentsFolder.file(`${attachment.id}-${attachment.name}.encrypted`, attachment.data);
      } else {
        const base64 = attachment.data.split(",")[1] ?? "";
        attachmentsFolder.file(`${attachment.id}-${attachment.name}`, base64, { base64: true });
      }
      attachmentsFolder.file(`${attachment.id}.json`, JSON.stringify(attachment, null, 2));
    }
  }

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  return { blob, payload };
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- Import ---------------- */

export class BackupError extends Error {}

async function readJson<T>(zip: JSZip, path: string): Promise<T | null> {
  const file = zip.file(path);
  if (!file) return null;
  try {
    return JSON.parse(await file.async("string")) as T;
  } catch {
    throw new BackupError(`${path} is not valid JSON. This backup file looks corrupted.`);
  }
}

export async function readBackupZip(
  file: Blob,
  ownerId: string | null = null,
): Promise<BackupPayload> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new BackupError("That file isn't a readable ZIP archive.");
  }

  const manifest = await readJson<BackupManifest>(zip, "manifest.json");
  if (!manifest || typeof manifest.backupFormatVersion !== "number") {
    throw new BackupError("This archive has no Noma manifest, so it can't be imported.");
  }

  if (ownerId && (!manifest.ownerId || manifest.ownerId !== ownerId)) {
    throw new BackupError(
      "This backup belongs to a different account. You cannot restore it here.",
    );
  }
  if (manifest.backupFormatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      `This backup was made by a newer version of Noma (format v${manifest.backupFormatVersion}). Update Noma and try again.`,
    );
  }

  const notes: Note[] = [];
  const noteFiles = zip.folder("notes")?.file(/\.json$/) ?? [];
  for (const noteFile of noteFiles) {
    try {
      const note = JSON.parse(await noteFile.async("string")) as Note;
      if (note?.id && typeof note.content === "string") {
        // Locked notes carry an encryption envelope as content — running it
        // through the HTML sanitizer would destroy it. They stay sealed and
        // keep the credentials from the backup.
        const content = note.lock ? note.content : sanitizeHtml(note.content);
        notes.push({ ...note, content, tagIds: note.tagIds ?? [] });
      }
    } catch {
      // Skip individual unreadable notes rather than failing the whole import.
    }
  }

  const attachments: AttachmentMeta[] = [];
  const attachmentFiles = zip.folder("attachments")?.file(/[0-9a-z-]+\.json$/i) ?? [];
  for (const attachmentFile of attachmentFiles) {
    if (attachmentFile.name.endsWith("index.json")) continue;
    try {
      const meta = JSON.parse(await attachmentFile.async("string")) as AttachmentMeta;
      if (meta?.id && meta.data) attachments.push(meta);
    } catch {
      /* ignore */
    }
  }

  return {
    manifest,
    notes,
    folders: (await readJson<Folder[]>(zip, "folders.json")) ?? [],
    tags: (await readJson<Tag[]>(zip, "tags.json")) ?? [],
    attachments,
    reminders: (await readJson<Reminder[]>(zip, "reminders.json")) ?? [],
    settings: await readJson<Record<string, unknown>>(zip, "settings.json"),
  };
}

export async function applyBackup(
  db: NomaDatabase,
  payload: BackupPayload,
  mode: "merge" | "replace",
): Promise<void> {
  // Deduplicate payload.reminders by noteId so backup restore never introduces duplicate reminders for a note
  const deduplicatedReminders: Reminder[] = [];
  if (payload.reminders?.length) {
    const reminderMap = new Map<string, Reminder>();
    for (const r of payload.reminders) {
      const existing = reminderMap.get(r.noteId);
      if (!existing || r.updatedAt > existing.updatedAt) {
        reminderMap.set(r.noteId, r);
      }
    }
    deduplicatedReminders.push(...reminderMap.values());
  }

  await db.transaction(
    "rw",
    db.notes,
    db.folders,
    db.tags,
    db.attachments,
    db.reminders,
    async () => {
      if (mode === "replace") {
        await Promise.all([
          db.notes.clear(),
          db.folders.clear(),
          db.tags.clear(),
          db.attachments.clear(),
          db.reminders.clear(),
        ]);
        await db.folders.bulkPut(payload.folders);
        await db.tags.bulkPut(payload.tags);
        await db.notes.bulkPut(payload.notes);
        await db.attachments.bulkPut(payload.attachments);
        if (deduplicatedReminders.length) await db.reminders.bulkPut(deduplicatedReminders);
      } else {
        for (const folder of payload.folders) {
          if (!(await db.folders.get(folder.id))) await db.folders.put(folder);
        }
        for (const tag of payload.tags) {
          if (!(await db.tags.get(tag.id))) await db.tags.put(tag);
        }
        for (const note of payload.notes) {
          const existing = await db.notes.get(note.id);
          // Deterministic conflict handling: newest updatedAt wins.
          if (!existing || note.updatedAt > existing.updatedAt) await db.notes.put(note);
        }
        for (const attachment of payload.attachments) {
          if (!(await db.attachments.get(attachment.id))) await db.attachments.put(attachment);
        }
        for (const reminder of deduplicatedReminders) {
          const existing = await db.reminders.get(reminder.id);
          if (!existing || reminder.updatedAt > existing.updatedAt)
            await db.reminders.put(reminder);
        }
      }
    },
  );

  // Clean up any remaining orphans or duplicate reminders
  await cleanupOrphanedReminders(db);
  await cleanupOrphanedAttachments(db);

  // Re-schedule notifications for active pending reminders after restore.
  // Phone-alarm reminders are excluded: their alerts live in the external
  // Clock app and must never be silently converted into Noma notifications.
  const activeReminders = await db.reminders
    .filter(
      (r) => r.status === "pending" && r.scheduledAt > Date.now() && r.alertType !== "phone-alarm",
    )
    .toArray();

  for (const reminder of activeReminders) {
    const notifId = await scheduleNotification(reminder);
    if (notifId !== undefined && notifId !== reminder.notificationId) {
      await db.reminders.update(reminder.id, { notificationId: notifId });
    }
  }
}

export async function recordBackup(
  db: NomaDatabase,
  source: "local" | "google-drive",
  status: "success" | "failed",
  noteCount: number,
  message?: string,
): Promise<void> {
  await db.backups.put({
    id: newId(),
    createdAt: Date.now(),
    source,
    status,
    noteCount,
    ...(message ? { message } : {}),
  });
}

import JSZip from "jszip";
import {
  BackupKeyNeededError,
  getBackupDeviceKey,
  getBackupEncryptionRecord,
  openArchive,
  sealArchive,
  type BackupEncryptionHeader,
} from "./backup-crypto";
import { type NomaDatabase, newId } from "./db";
import { cleanupOrphanedReminders } from "./notes";
import { cleanupOrphanedAttachments } from "./media";
import {
  cancelNotification,
  notificationSnapshotForNote,
  scheduleNotification,
} from "./notifications";
import { sanitizeHtml } from "./sanitize";
import { invalidateMismatchedVectors } from "./semantic";
import { getDeviceId } from "./sync";
import {
  BACKUP_FORMAT_VERSION,
  NOMA_VERSION,
  type AttachmentMeta,
  type BackupManifest,
  type Folder,
  type Note,
  type Reminder,
  type SyncTombstone,
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
  /**
   * Archive encryption for the built ZIP:
   * - an object seals the archive with that header + key;
   * - `null` forces a plaintext archive;
   * - `undefined` (the default) resolves the account's stored encryption
   *   record: when one exists the archive is sealed with this device's
   *   key, and when the record exists but no key is held a
   *   BackupKeyNeededError is thrown — an enabled archive is NEVER
   *   silently written in plaintext.
   */
  encryption?: { header: BackupEncryptionHeader; keyBytes: Uint8Array } | null;
}

export interface BackupPayload {
  manifest: BackupManifest;
  notes: Note[];
  folders: Folder[];
  tags: Tag[];
  attachments: AttachmentMeta[];
  reminders: Reminder[];
  settings: Record<string, unknown> | null;
  /** Hard-deletion markers from the writer's `sync.json` (empty for
   * backups made before multi-device sync existed). */
  tombstones: SyncTombstone[];
  /** Device that wrote the snapshot, when known. */
  deviceId: string | null;
}

/** What a merge did, for sync status and restore feedback. */
export interface MergeCounts {
  added: number;
  updated: number;
  deleted: number;
  conflicts: number;
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
  // Tombstones are sync state, not content: every snapshot carries all of
  // them regardless of the export filters, so deletions keep propagating
  // even through partial exports.
  const tombstones = db.tombstones ? await db.tombstones.toArray() : [];
  const deviceId = getDeviceId();
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
      deviceId,
    },
    notes,
    folders,
    tags,
    attachments,
    reminders,
    settings: sanitizedSettings as unknown as Record<string, unknown> | null,
    tombstones,
    deviceId,
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
  // Sync metadata is additive (format stays v2): older Noma versions
  // restoring this backup simply ignore the extra file.
  zip.file(
    "sync.json",
    JSON.stringify(
      {
        deviceId: payload.deviceId,
        syncedAt: new Date().toISOString(),
        tombstones: payload.tombstones,
      },
      null,
      2,
    ),
  );

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

  let blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });

  // Whole-archive encryption (see backup-crypto.ts): the ZIP payload is
  // unchanged (format stays v2); only the stored bytes are sealed.
  const encryption =
    options.encryption !== undefined
      ? options.encryption
      : resolveStoredEncryption(ownerId);
  if (encryption) {
    const zipBytes = new Uint8Array(await blob.arrayBuffer());
    const sealed = await sealArchive(zipBytes, encryption.header, encryption.keyBytes);
    blob = new Blob([sealed as BlobPart], { type: "application/zip" });
  }
  return { blob, payload };
}

/**
 * The default encryption resolution for a build: the account's stored
 * record, when one exists. Throws BackupKeyNeededError when encryption
 * is enabled but this device doesn't hold the key — callers surface an
 * unlock prompt; the archive is never downgraded to plaintext instead.
 */
function resolveStoredEncryption(
  ownerId: string | null,
): { header: BackupEncryptionHeader; keyBytes: Uint8Array } | null {
  const record = getBackupEncryptionRecord(ownerId);
  if (!record) return null;
  const keyBytes = getBackupDeviceKey(ownerId);
  if (!keyBytes) {
    throw new BackupKeyNeededError(
      "Backup encryption is on, but this device doesn't hold the key. Enter your backup passphrase to continue.",
      record,
    );
  }
  return { header: record, keyBytes };
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
  keyBytes?: Uint8Array | null,
): Promise<BackupPayload> {
  return (await readBackupArchive(file, ownerId, keyBytes)).payload;
}

/**
 * Reads a backup archive (plaintext ZIP or sealed envelope) and also
 * reports the encryption header it carried, so sync can adopt the
 * fleet's wrap parameters after a successful pull. Encrypted archives
 * require `keyBytes`: BackupKeyNeededError without one,
 * BackupUnlockError when it doesn't fit. Legacy plaintext archives are
 * always readable.
 */
async function archiveToBytes(file: Blob): Promise<Uint8Array> {
  // Production callers pass real Blobs/Files; the extra branches keep the
  // reader usable with raw buffers (tests, non-DOM callers).
  if (file instanceof Uint8Array) return file;
  if (file instanceof ArrayBuffer) return new Uint8Array(file);
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Uint8Array(await new Response(file).arrayBuffer());
}

export async function readBackupArchive(
  file: Blob,
  ownerId: string | null = null,
  keyBytes?: Uint8Array | null,
): Promise<{ payload: BackupPayload; encryption: BackupEncryptionHeader | null }> {
  const bytes = await archiveToBytes(file);
  const { zipBytes, header } = await openArchive(bytes, keyBytes);
  const payload = await readBackupZipBytes(zipBytes, ownerId);
  return { payload, encryption: header };
}

async function readBackupZipBytes(
  bytes: Uint8Array,
  ownerId: string | null,
): Promise<BackupPayload> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes as unknown as ArrayBuffer);
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

  // Sync metadata is optional and non-critical: a malformed sync.json
  // must never make an otherwise valid backup unreadable.
  let tombstones: SyncTombstone[] = [];
  let deviceId: string | null = manifest.deviceId ?? null;
  const syncFile = zip.file("sync.json");
  if (syncFile) {
    try {
      const parsed = JSON.parse(await syncFile.async("string")) as {
        deviceId?: string | null;
        tombstones?: SyncTombstone[];
      };
      if (Array.isArray(parsed.tombstones)) {
        tombstones = parsed.tombstones.filter(
          (t) =>
            t &&
            typeof t.id === "string" &&
            typeof t.deletedAt === "number" &&
            typeof t.entity === "string",
        );
      }
      if (typeof parsed.deviceId === "string") deviceId = parsed.deviceId;
    } catch {
      /* ignore — sync metadata is additive */
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
    tombstones,
    deviceId,
  };
}

/**
 * Applies deletion tombstones to the local library. A tombstone deletes
 * its entity only when the local copy hasn't been edited after the
 * deletion (`deletedAt >= entity timestamp`); a newer local edit revives
 * the entity and the tombstone is ignored. Note deletions cascade to
 * attachments and reminders (mirroring `deleteNoteForever`), folder
 * deletions unassign their notes (mirroring `deleteFolder`), and tag
 * deletions strip the tag from notes (mirroring `deleteTag`). Returns the
 * number of rows deleted, cascades included.
 */
export async function applyTombstones(
  db: NomaDatabase,
  tombstones: SyncTombstone[],
): Promise<number> {
  if (!tombstones.length) return 0;
  // Newest marker per entity wins.
  const byKey = new Map<string, SyncTombstone>();
  for (const tombstone of tombstones) {
    const key = `${tombstone.entity}:${tombstone.id}`;
    const existing = byKey.get(key);
    if (!existing || tombstone.deletedAt > existing.deletedAt) byKey.set(key, tombstone);
  }

  let deleted = 0;
  for (const tombstone of byKey.values()) {
    const { entity, id, deletedAt } = tombstone;
    if (entity === "note") {
      const note = await db.notes.get(id);
      if (!note || deletedAt < note.updatedAt) continue;
      const reminders = await db.reminders.where("noteId").equals(id).toArray();
      for (const reminder of reminders) {
        await cancelNotification(reminder.id, reminder.notificationId);
      }
      const attachmentCount = await db.attachments.where("noteId").equals(id).count();
      await db.transaction(
        "rw",
        db.notes,
        db.attachments,
        db.reminders,
        db.noteEmbeddings,
        async () => {
          await db.attachments.where("noteId").equals(id).delete();
          await db.reminders.where("noteId").equals(id).delete();
          // The note's semantic vector dies with it (semantic.ts).
          if (db.noteEmbeddings) await db.noteEmbeddings.delete(id);
          await db.notes.delete(id);
        },
      );
      deleted += 1 + reminders.length + attachmentCount;
    } else if (entity === "folder") {
      const folder = await db.folders.get(id);
      if (!folder || deletedAt < folder.updatedAt) continue;
      await db.transaction("rw", db.folders, db.notes, async () => {
        const notes = await db.notes.where("folderId").equals(id).toArray();
        for (const note of notes) {
          await db.notes.update(note.id, { folderId: null, updatedAt: Date.now() });
        }
        await db.folders.delete(id);
      });
      deleted += 1;
    } else if (entity === "tag") {
      const tag = await db.tags.get(id);
      if (!tag || deletedAt < (tag.updatedAt ?? tag.createdAt)) continue;
      await db.transaction("rw", db.tags, db.notes, async () => {
        const notes = await db.notes.filter((n) => n.tagIds.includes(id)).toArray();
        for (const note of notes) {
          await db.notes.update(note.id, {
            tagIds: note.tagIds.filter((t) => t !== id),
            updatedAt: Date.now(),
          });
        }
        await db.tags.delete(id);
      });
      deleted += 1;
    } else if (entity === "attachment") {
      const attachment = await db.attachments.get(id);
      if (!attachment || deletedAt < (attachment.updatedAt ?? attachment.createdAt)) continue;
      await db.attachments.delete(id);
      deleted += 1;
    } else if (entity === "reminder") {
      const reminder = await db.reminders.get(id);
      if (!reminder || deletedAt < reminder.updatedAt) continue;
      await cancelNotification(reminder.id, reminder.notificationId);
      await db.reminders.delete(id);
      deleted += 1;
    }
  }
  return deleted;
}

/** Unions a payload's tombstones into the local tombstone table (newest
 * per id wins), so deletions keep propagating through later snapshots. */
async function recordPayloadTombstones(
  db: NomaDatabase,
  tombstones: SyncTombstone[],
): Promise<void> {
  if (!db.tombstones || !tombstones.length) return;
  for (const tombstone of tombstones) {
    const existing = await db.tombstones.get(tombstone.id);
    if (!existing || tombstone.deletedAt > existing.deletedAt) {
      await db.tombstones.put(tombstone);
    }
  }
}

export async function applyBackup(
  db: NomaDatabase,
  payload: BackupPayload,
  mode: "merge" | "replace",
): Promise<MergeCounts> {
  const counts: MergeCounts = { added: 0, updated: 0, deleted: 0, conflicts: 0 };
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
        counts.added =
          payload.folders.length +
          payload.tags.length +
          payload.notes.length +
          payload.attachments.length +
          deduplicatedReminders.length;
      } else {
        // Merge resolves every entity kind the same way now: the newest
        // version wins. (Folders/tags/attachments used to be insert-only,
        // which silently dropped renames and note-lock re-encryption.)
        for (const folder of payload.folders) {
          const existing = await db.folders.get(folder.id);
          if (!existing) {
            await db.folders.put(folder);
            counts.added++;
          } else if (folder.updatedAt > existing.updatedAt) {
            await db.folders.put(folder);
            counts.updated++;
          }
        }
        for (const tag of payload.tags) {
          const existing = await db.tags.get(tag.id);
          if (!existing) {
            await db.tags.put(tag);
            counts.added++;
          } else if (
            (tag.updatedAt ?? tag.createdAt) > (existing.updatedAt ?? existing.createdAt)
          ) {
            await db.tags.put(tag);
            counts.updated++;
          }
        }
        for (const note of payload.notes) {
          const existing = await db.notes.get(note.id);
          // Deterministic conflict handling: newest updatedAt wins.
          if (!existing) {
            await db.notes.put(note);
            counts.added++;
          } else if (note.updatedAt > existing.updatedAt) {
            await db.notes.put(note);
            counts.updated++;
          }
        }
        for (const attachment of payload.attachments) {
          const existing = await db.attachments.get(attachment.id);
          if (!existing) {
            await db.attachments.put(attachment);
            counts.added++;
          } else if (
            (attachment.updatedAt ?? attachment.createdAt) >
            (existing.updatedAt ?? existing.createdAt)
          ) {
            await db.attachments.put(attachment);
            counts.updated++;
          }
        }
        for (const reminder of deduplicatedReminders) {
          const existing = await db.reminders.get(reminder.id);
          if (!existing) {
            await db.reminders.put(reminder);
            counts.added++;
          } else if (reminder.updatedAt > existing.updatedAt) {
            await db.reminders.put(reminder);
            counts.updated++;
          }
        }
      }
    },
  );

  // Deletions travel with the snapshot: apply them after the puts (so a
  // tombstone beats a stale copy shipped in the same payload) and keep
  // them locally so they propagate onward. Replace mode already took the
  // payload as the whole truth, so it only records them.
  if (payload.tombstones?.length) {
    if (mode === "merge") counts.deleted += await applyTombstones(db, payload.tombstones);
    await recordPayloadTombstones(db, payload.tombstones);
  }

  // These bulk writes bypass updateNote's semantic save hook: drop any
  // stored vector that no longer tells the truth about its note after
  // the restore/merge — content replaced, the note now locked,
  // trashed, or gone entirely. Local-only invalidation (semantic.ts):
  // nothing is re-embedded here, so an affected note simply reads as
  // stale until its next save or an Update index tap.
  if (db.noteEmbeddings) {
    const vectorRows = await db.noteEmbeddings.toArray();
    const affected = new Set<string>(payload.notes.map((note) => note.id));
    for (const row of vectorRows) affected.add(row.noteId);
    await invalidateMismatchedVectors(db, affected);
  }

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

  // One bulk fetch for every referenced note: notification text needs each
  // note's title + lock state, never its content.
  const restoredNoteIds = [...new Set(activeReminders.map((r) => r.noteId))];
  const restoredNotes = restoredNoteIds.length ? await db.notes.bulkGet(restoredNoteIds) : [];
  const restoredSnapshots = new Map(
    restoredNoteIds.map((noteId, index) => [
      noteId,
      notificationSnapshotForNote(restoredNotes[index]),
    ]),
  );

  for (const reminder of activeReminders) {
    const notifId = await scheduleNotification(reminder, restoredSnapshots.get(reminder.noteId));
    if (notifId !== undefined && notifId !== reminder.notificationId) {
      await db.reminders.update(reminder.id, { notificationId: notifId });
    }
  }

  return counts;
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

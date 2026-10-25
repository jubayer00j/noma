import Dexie, { type Table } from "dexie";
import {
  DEFAULT_SETTINGS,
  withBackupModeMigration,
  type AppSettings,
  type AttachmentMeta,
  type BackupRecord,
  type Folder,
  type Note,
  type NoteEmbedding,
  type NoteVersion,
  type Reminder,
  type SyncState,
  type SyncTombstone,
  type Tag,
} from "./types";

export class NomaDatabase extends Dexie {
  notes!: Table<Note, string>;
  folders!: Table<Folder, string>;
  tags!: Table<Tag, string>;
  attachments!: Table<AttachmentMeta, string>;
  settings!: Table<AppSettings, string>;
  backups!: Table<BackupRecord, string>;
  reminders!: Table<Reminder, string>;
  tombstones!: Table<SyncTombstone, string>;
  syncMeta!: Table<SyncState, string>;
  noteVersions!: Table<NoteVersion, string>;
  noteEmbeddings!: Table<NoteEmbedding, string>;

  constructor(databaseName: string) {
    super(databaseName);

    // v1 — initial schema. Add new versions below, never mutate this one.
    this.version(1).stores({
      notes: "id, updatedAt, createdAt, folderId, pinned, favorite, archived, deleted, *tagIds",
      folders: "id, name, parentId",
      tags: "id, name",
      attachments: "id, noteId",
      settings: "id",
      backups: "id, createdAt",
    });

    // v2 — Add note reminders schema.
    this.version(2).stores({
      notes: "id, updatedAt, createdAt, folderId, pinned, favorite, archived, deleted, *tagIds",
      folders: "id, name, parentId",
      tags: "id, name",
      attachments: "id, noteId",
      settings: "id",
      backups: "id, createdAt",
      reminders: "id, noteId, scheduledAt, status, createdAt, updatedAt",
    });

    // v3 — Multi-device sync: deletion tombstones + sync bookkeeping.
    this.version(3).stores({
      notes: "id, updatedAt, createdAt, folderId, pinned, favorite, archived, deleted, *tagIds",
      folders: "id, name, parentId",
      tags: "id, name",
      attachments: "id, noteId",
      settings: "id",
      backups: "id, createdAt",
      reminders: "id, noteId, scheduledAt, status, createdAt, updatedAt",
      tombstones: "id, entity, deletedAt",
      syncMeta: "id",
    });

    // v4 — Per-note version history: local-only snapshots of replaced
    // note states (see versions.ts). Never part of backups or sync.
    this.version(4).stores({
      notes: "id, updatedAt, createdAt, folderId, pinned, favorite, archived, deleted, *tagIds",
      folders: "id, name, parentId",
      tags: "id, name",
      attachments: "id, noteId",
      settings: "id",
      backups: "id, createdAt",
      reminders: "id, noteId, scheduledAt, status, createdAt, updatedAt",
      tombstones: "id, entity, deletedAt",
      syncMeta: "id",
      noteVersions: "id, noteId",
    });

    // v5 — Semantic search index: one embedding vector per note (see
    // semantic.ts). Derived data, local-only like the version history:
    // never part of backups or sync, and deliberately NOT copied by
    // copyDatabase — each database/device rebuilds its own index.
    this.version(5).stores({
      notes: "id, updatedAt, createdAt, folderId, pinned, favorite, archived, deleted, *tagIds",
      folders: "id, name, parentId",
      tags: "id, name",
      attachments: "id, noteId",
      settings: "id",
      backups: "id, createdAt",
      reminders: "id, noteId, scheduledAt, status, createdAt, updatedAt",
      tombstones: "id, entity, deletedAt",
      syncMeta: "id",
      noteVersions: "id, noteId",
      noteEmbeddings: "noteId",
    });
  }
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function getSettings(db: NomaDatabase): Promise<AppSettings> {
  const existing = await db.settings.get("app");
  if (existing)
    return withBackupModeMigration({ ...DEFAULT_SETTINGS, ...existing }, existing);
  await db.settings.put(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export async function saveSettings(
  db: NomaDatabase,
  patch: Partial<AppSettings>,
): Promise<AppSettings> {
  const next = { ...(await getSettings(db)), ...patch, id: "app" as const };

  await db.settings.put(next);
  return next;
}

export async function copyDatabase(source: NomaDatabase, target: NomaDatabase): Promise<void> {
  // SECURITY INVARIANT: Never copy the `settings` table during database migrations.
  // Settings contains account-specific security controls (appLockEnabled, unlockMethods,
  // passwordHash, passwordSalt, patternHash, patternSalt, failedAttempts, lockoutUntil).
  // The destination database's existing security settings must remain authoritative.
  // The same deliberate omission covers `noteVersions` and `noteEmbeddings`:
  // both are local-only derived data (history snapshots, search vectors)
  // that a destination database rebuilds for itself — see db versions
  // v4/v5. The explicit table list below is what enforces all of this.
  const [notes, folders, tags, attachments, backups, reminders] = await Promise.all([
    source.notes.toArray(),
    source.folders.toArray(),
    source.tags.toArray(),
    source.attachments.toArray(),
    source.backups.toArray(),
    source.reminders ? source.reminders.toArray() : Promise.resolve([]),
  ]);

  await target.transaction(
    "rw",
    [
      target.notes,
      target.folders,
      target.tags,
      target.attachments,
      target.backups,
      target.reminders,
    ],
    async () => {
      if (notes.length) await target.notes.bulkPut(notes);
      if (folders.length) await target.folders.bulkPut(folders);
      if (tags.length) await target.tags.bulkPut(tags);
      if (attachments.length) await target.attachments.bulkPut(attachments);
      if (backups.length) await target.backups.bulkPut(backups);
      if (reminders.length) await target.reminders.bulkPut(reminders);
    },
  );
}

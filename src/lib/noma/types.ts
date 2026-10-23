export type ContentFormat = "tiptap-html";

/** Credential methods that can protect a single note. Fingerprint is an
 * additional convenience method and always requires one of these as backup. */
export type NoteLockMethod = "password" | "pin" | "pattern";

/** One wrapped copy of the note encryption key, sealed by a single credential. */
export interface NoteLockSlot {
  /** Base64 PBKDF2 salt for this slot's credential. */
  salt: string;
  /** PBKDF2-HMAC-SHA256 iterations used to derive this slot's key. */
  iterations: number;
  /** Base64 (IV || AES-256-GCM ciphertext) of the note encryption key. */
  wrappedKey: string;
}

/**
 * Per-note lock record. While a note is locked, its `content` holds an
 * AES-256-GCM envelope (see note-lock-crypto) and its attachments' `data`
 * fields hold envelopes too — only the title stays readable, by design.
 * There is deliberately no recovery path: a forgotten credential means the
 * note cannot be decrypted again.
 */
export interface NoteLock {
  v: 1;
  slots: Partial<Record<NoteLockMethod, NoteLockSlot>>;
  /** Fingerprint unlock enabled. The key copy it releases lives on-device
   * only (never in backups); a credential slot above is always required. */
  biometric: boolean;
  failedAttempts: number;
  lockoutUntil: number | null;
  lockedAt: number;
}

/** User-selectable appearance. "nature" is a standalone warm light theme. "amoled" is pure black. */
export type ThemeSetting = "light" | "dark" | "system" | "nature" | "amoled";

/** Automatic backup strategy: never, sync shortly after changes, or on a schedule. */
export type BackupMode = "off" | "sync" | "scheduled";

export interface Note {
  id: string;
  title: string;
  content: string;
  contentFormat: ContentFormat;
  createdAt: number;
  updatedAt: number;
  folderId: string | null;
  tagIds: string[];
  pinned: boolean;
  favorite: boolean;
  archived: boolean;
  deleted: boolean;
  deletedAt: number | null;
  reminderAt: number | null;
  wordCount: number;
  /** Per-note encryption lock; absent/null means the note is not locked. */
  lock?: NoteLock | null;
  /** Local calendar day (`YYYY-MM-DD`) this note journals; null/absent for
   * ordinary notes. Built from local date components, never UTC. */
  dailyDate?: string | null;
  /** True when this note is a template: excluded from normal views and
   * search, listed only in the Templates view. Templates ride the note
   * record, so backup and sync carry them like any other note. */
  isTemplate?: boolean;
  /** On a template: its content seeds each new daily note. At most one
   * template carries this at a time. */
  dailyDefault?: boolean;
}

/**
 * One earlier state of a note's title + content, kept by the version
 * history (see versions.ts). `createdAt` is the replaced state's own
 * `updatedAt` — when that text was current. Versions are local to the
 * device: they are not part of the backup payload and never sync.
 */
export interface NoteVersion {
  id: string;
  noteId: string;
  title: string;
  content: string;
  createdAt: number;
}

export interface Folder {
  id: string;
  name: string;
  /** Reserved for future nested folders. */
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Tag {
  id: string;
  name: string;
  createdAt: number;
  /** Bumped on rename so sync can propagate it. Absent on pre-sync rows —
   * merge logic falls back to `createdAt` for those. */
  updatedAt?: number;
}

export interface AttachmentMeta {
  id: string;
  noteId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  /** Bumped whenever `data` changes (including note lock/unlock
   * re-encryption) so sync can propagate the new payload. Absent on
   * pre-sync rows — merge logic falls back to `createdAt` for those. */
  updatedAt?: number;
  /** Data URL kept locally so attachments survive offline + export.
   * When the owning note is locked this holds an encryption envelope instead. */
  data: string;
  /** True while `data` is an AES-GCM envelope sealed by the note's lock key. */
  encrypted?: boolean;
}

export interface AppSettings {
  id: "app";
  theme: ThemeSetting;
  fontSize: number;
  editorWidth: number;
  lineHeight: number;
  autoBackup: boolean;
  /** Automatic backup strategy (supersedes the legacy `autoBackup` toggle). */
  backupMode: BackupMode;
  /** Scheduled-mode interval in minutes — a preset or a custom value. */
  backupIntervalMinutes: number;
  sidebarCollapsed: boolean;
  /** Subtle haptic feedback for swipe commits and unlock outcomes (native-feel #4). */
  hapticsEnabled: boolean;
  /** Firebase uid that has completed the first-run welcome on this device. */
  onboardedFor: string | null;
  displayName: string;

  // App Lock Security Settings
  appLockEnabled: boolean;
  lockTimeout: number; // Seconds: 0 (Immediately), 10, 60, 300, 900, 1800, 3600
  unlockMethods: {
    biometric: boolean;
    pattern: boolean;
    password: boolean;
  };
  passwordHash: string | null;
  passwordSalt: string | null;
  patternHash: string | null;
  patternSalt: string | null;
  failedAttempts: number;
  lockoutUntil: number | null;
}

export type ReminderStatus = "pending" | "completed" | "dismissed";

/** How a reminder should alert the user. Absent (older reminders) resolves to "notification". */
export type ReminderAlertType = "notification" | "phone-alarm";

/** Alarm-tone selection mode for phone-alarm reminders. */
export type AlarmToneMode = "system" | "system-picker" | "custom";

export interface Reminder {
  id: string;
  noteId: string;
  scheduledAt: number;
  status: ReminderStatus;
  createdAt: number;
  updatedAt: number;
  notificationId?: number | undefined;
  /** Android-only. When "phone-alarm", the alert is handed to the device Clock app. */
  alertType?: ReminderAlertType | undefined;
  /** Alarm tone mode; defaults to "system" when phone-alarm is selected. */
  alarmToneMode?: AlarmToneMode | undefined;
  /** content:// URI of the chosen ringtone/audio (system-picker or custom). */
  alarmToneUri?: string | undefined;
  /** Lightweight display name for the chosen tone, e.g. "My Alarm.mp3". */
  alarmToneName?: string | undefined;
  /** Whether vibration was requested for the phone alarm. Defaults to true. */
  alarmVibrate?: boolean | undefined;
}

export interface BackupRecord {
  id: string;
  createdAt: number;
  source: "local" | "google-drive";
  status: "success" | "failed";
  noteCount: number;
  message?: string;
}

export interface BackupManifest {
  backupFormatVersion: number;
  nomaVersion: string;
  createdAt: string;
  noteCount: number;
  folderCount: number;
  tagCount: number;
  attachmentCount: number;
  reminderCount?: number;
  ownerId?: string | null;
  libraryId?: string | null;
  /** Device that wrote this snapshot (see sync.ts device identity). Additive —
   * older readers ignore it. */
  deviceId?: string | null;
}

/** Entity kinds that participate in multi-device sync. */
export type SyncEntity = "note" | "folder" | "tag" | "attachment" | "reminder";

/**
 * A hard-deletion marker that travels inside backups (`sync.json`) so a
 * "delete forever" on one device propagates to the others instead of the
 * item resurrecting from their next snapshot. Kept for 90 days.
 */
export interface SyncTombstone {
  entity: SyncEntity;
  id: string;
  deletedAt: number;
  deviceId: string;
}

/**
 * Per-database sync bookkeeping (single row, id "state", in the `syncMeta`
 * table). `hashes` is the three-way merge base: content hash of every
 * entity — plus `tombstone:<entity>:<id>` entries — as of the last
 * successful merge. `lastRemoteSignature` is the sync signature of the
 * snapshot Drive is known to hold, which is what push decisions compare
 * against (the base alone can't serve: a pull-only merge advances it
 * without anything reaching Drive).
 */
export interface SyncState {
  id: "state";
  lastSyncAt: number | null;
  lastRemoteModifiedTime: number | null;
  lastRemoteChecksum: string | null;
  lastRemoteSignature: string | null;
  hashes: Record<string, string>;
}

/**
 * One-way migration for the legacy `autoBackup` toggle: a stored settings row
 * written before backup modes existed has no `backupMode`, so a user who had
 * automatic backup ON gets its closest modern equivalent — sync on change.
 * Rows that already carry a `backupMode` are returned untouched.
 */
export function withBackupModeMigration(
  merged: AppSettings,
  stored: Partial<AppSettings> | undefined,
): AppSettings {
  if (stored && stored.backupMode === undefined && stored.autoBackup === true) {
    return { ...merged, backupMode: "sync", autoBackup: true };
  }
  return merged;
}

export const NOMA_VERSION = "1.0.1";
export const BACKUP_FORMAT_VERSION = 2;

export const DEFAULT_SETTINGS: AppSettings = {
  id: "app",
  theme: "system",
  fontSize: 17,
  editorWidth: 720,
  lineHeight: 1.7,
  autoBackup: false,
  backupMode: "off",
  backupIntervalMinutes: 1440,
  sidebarCollapsed: false,
  hapticsEnabled: true,
  onboardedFor: null,
  displayName: "",

  appLockEnabled: false,
  lockTimeout: 0,
  unlockMethods: {
    biometric: false,
    pattern: false,
    password: false,
  },
  passwordHash: null,
  passwordSalt: null,
  patternHash: null,
  patternSalt: null,
  failedAttempts: 0,
  lockoutUntil: null,
};

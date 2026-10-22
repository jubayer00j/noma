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
}

export interface AttachmentMeta {
  id: string;
  noteId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
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

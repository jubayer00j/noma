/**
 * Pure summary builders for the Settings root list (settings
 * restructure). Each Settings category row shows its current state as
 * a one-line summary; the derivations live here — free of React, the
 * database and storage — so they can be unit-tested across every
 * state combination. The Settings page gathers the raw inputs from
 * the existing records (Drive connection, backup-encryption record,
 * AI record, AppSettings, auth) and passes plain values in.
 */
import { formatBackupInterval } from "./backup-scheduler";
import type { BackupMode, ThemeSetting } from "./types";

/* ---------------- Sync & backup ---------------- */

export interface SyncSummaryInput {
  /** A Drive connection record exists for the current account. */
  connected: boolean;
  backupMode: BackupMode;
  backupIntervalMinutes: number;
}

/**
 * Drive state + automatic-backup mode, using the Drive card's own
 * mode titles ("Off" / "Sync" / "Scheduled"). A backup mode left set
 * while Drive is disconnected must never claim "Connected".
 */
export function syncSummary(input: SyncSummaryInput): string {
  if (!input.connected) return "Not connected";
  switch (input.backupMode) {
    case "sync":
      return "Connected · Sync";
    case "scheduled":
      return `Connected · Scheduled · ${formatBackupInterval(input.backupIntervalMinutes)}`;
    case "off":
      return "Connected · Off";
  }
}

/* ---------------- Security ---------------- */

export interface SecuritySummaryInput {
  appLockEnabled: boolean;
  /** A backup-encryption record exists for the current account. */
  encryptionEnabled: boolean;
}

/** Each half reflects its own state, shown plainly either way. */
export function securitySummary(input: SecuritySummaryInput): string {
  const appLock = input.appLockEnabled ? "on" : "off";
  const encryption = input.encryptionEnabled ? "on" : "off";
  return `App lock ${appLock} · Encryption ${encryption}`;
}

/* ---------------- Appearance ---------------- */

/**
 * The theme's display name. The options list is passed in (the
 * ThemePicker owns the canonical names) so this module stays free of
 * component imports.
 */
export function appearanceSummary(
  theme: ThemeSetting,
  options: ReadonlyArray<{ id: string; name: string }>,
): string {
  return options.find((option) => option.id === theme)?.name ?? theme;
}

/* ---------------- Writing ---------------- */

export interface WritingSummaryInput {
  fontSize: number;
  lineHeight: number;
}

/** "17px · 1.7" — font size and line height, as the sliders show them. */
export function writingSummary(input: WritingSummaryInput): string {
  return `${input.fontSize}px · ${input.lineHeight.toFixed(1)}`;
}

/* ---------------- AI features ---------------- */

/** Key presence only — the key itself never reaches a summary. */
export function aiSummary(input: { hasKey: boolean }): string {
  return input.hasKey ? "Gemini key saved" : "Not set up";
}

/* ---------------- Data ---------------- */

export function dataSummary(noteCount: number): string {
  return noteCount === 1 ? "1 note on this device" : `${noteCount} notes on this device`;
}

/* ---------------- Account ---------------- */

export interface AccountSummaryInput {
  email: string | null;
  signedIn: boolean;
}

export function accountSummary(input: AccountSummaryInput): string {
  if (input.email) return input.email;
  return input.signedIn ? "Signed in" : "Local Mode";
}

/* ---------------- About ---------------- */

/** Normalizes a bare version ("1.0.1") to the display form ("v1.0.1"). */
export function aboutSummary(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

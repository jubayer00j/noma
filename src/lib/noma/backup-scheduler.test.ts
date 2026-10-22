import { describe, expect, it } from "vitest";
import {
  clampBackupIntervalMinutes,
  formatBackupInterval,
  isScheduledBackupDue,
  nextScheduledBackupAt,
} from "./backup-scheduler";
import { DEFAULT_SETTINGS, withBackupModeMigration, type AppSettings } from "./types";

describe("clampBackupIntervalMinutes", () => {
  it("clamps to the one-hour floor and thirty-day ceiling", () => {
    expect(clampBackupIntervalMinutes(5)).toBe(60);
    expect(clampBackupIntervalMinutes(999_999)).toBe(43_200);
    expect(clampBackupIntervalMinutes(720)).toBe(720);
  });

  it("falls back to daily for non-finite input and rounds fractions", () => {
    expect(clampBackupIntervalMinutes(Number.NaN)).toBe(1440);
    expect(clampBackupIntervalMinutes(90.6)).toBe(91);
  });
});

describe("formatBackupInterval", () => {
  it("labels the presets the way the settings UI does", () => {
    expect(formatBackupInterval(360)).toBe("Every 6 hours");
    expect(formatBackupInterval(720)).toBe("Every 12 hours");
    expect(formatBackupInterval(1440)).toBe("Daily");
    expect(formatBackupInterval(2880)).toBe("Every 2 days");
    expect(formatBackupInterval(10_080)).toBe("Every 7 days");
  });

  it("labels custom values plainly", () => {
    expect(formatBackupInterval(60)).toBe("Every 1 hour");
    expect(formatBackupInterval(90)).toBe("Every 90 minutes");
    expect(formatBackupInterval(4320)).toBe("Every 3 days");
  });
});

describe("isScheduledBackupDue / nextScheduledBackupAt", () => {
  const now = 1_760_000_000_000;

  it("is due immediately when no backup has ever succeeded", () => {
    expect(isScheduledBackupDue(null, 1440, now)).toBe(true);
    expect(nextScheduledBackupAt(null, 1440)).toBeNull();
  });

  it("is due exactly at the interval boundary, not before", () => {
    const last = now - 1440 * 60_000;
    expect(isScheduledBackupDue(last, 1440, now)).toBe(true);
    expect(isScheduledBackupDue(last + 1, 1440, now)).toBe(false);
    expect(nextScheduledBackupAt(last, 1440)).toBe(now);
  });
});

describe("withBackupModeMigration", () => {
  it("maps the legacy auto-backup toggle to sync mode", () => {
    const stored: Partial<AppSettings> = { autoBackup: true };
    delete stored.backupMode;
    const migrated = withBackupModeMigration({ ...DEFAULT_SETTINGS }, stored);
    expect(migrated.backupMode).toBe("sync");
  });

  it("leaves rows that already chose a mode — or never opted in — untouched", () => {
    const chosen: Partial<AppSettings> = { autoBackup: true, backupMode: "scheduled" };
    expect(withBackupModeMigration({ ...DEFAULT_SETTINGS }, chosen).backupMode).toBe("off");
    // merged value already reflects the stored mode in real callers; the helper
    // must not resurrect sync for a stored "off".
    const off: Partial<AppSettings> = { autoBackup: false };
    delete off.backupMode;
    expect(withBackupModeMigration({ ...DEFAULT_SETTINGS }, off).backupMode).toBe("off");
    expect(withBackupModeMigration({ ...DEFAULT_SETTINGS }, undefined).backupMode).toBe("off");
  });
});

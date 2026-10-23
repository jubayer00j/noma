import { describe, expect, it, vi } from "vitest";
import type { BackupSchedulerState } from "./backup-scheduler";
import type { NomaDatabase } from "./db";

/**
 * The scheduler treats sync's `locked` outcome (encrypted remote, no key
 * on this device) as a quiet skip: the state exposes syncLocked so
 * Settings can show the paused line, and nothing surfaces as an error.
 * Drive + sync are mocked at the module boundary so the test drives the
 * real scheduler engine only.
 */

vi.mock("./drive", () => ({
  getConnection: () => ({
    email: "a@example.com",
    connectedAt: 1,
    lastBackupAt: Date.now(),
    folderId: "folder1",
    backupFileId: "file1",
    lastSignature: null,
  }),
  hasUnbackedChanges: async () => false,
}));

vi.mock("./sync", () => ({
  syncNow: async () => ({ status: "locked", reason: "Sync is paused" }),
}));

describe("backup scheduler with a locked remote", () => {
  it("exposes syncLocked in its state without surfacing an error", async () => {
    vi.stubGlobal("navigator", { onLine: true });
    Object.defineProperty(globalThis, "window", {
      value: {
        localStorage: undefined,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: {
        addEventListener: () => {},
        removeEventListener: () => {},
        visibilityState: "visible",
      },
      configurable: true,
      writable: true,
    });
    const { startBackupScheduler } = await import("./backup-scheduler");

    const hook = Object.assign(() => {}, {
      creating: { unsubscribe: () => {} },
      updating: { unsubscribe: () => {} },
      deleting: { unsubscribe: () => {} },
    });
    const table = () => ({ hook });
    const db = {
      notes: table(),
      folders: table(),
      tags: table(),
      attachments: table(),
      reminders: table(),
      tombstones: table(),
    } as unknown as NomaDatabase;

    const states: BackupSchedulerState[] = [];
    vi.useFakeTimers();
    try {
      const stop = startBackupScheduler({
        db,
        ownerId: "user-1",
        getConfig: () => ({ mode: "sync", intervalMinutes: 1440 }),
        onStateChange: (state) => states.push(state),
      });
      // The start attempt fires after 2s; the mocked syncNow resolves locked.
      await vi.advanceTimersByTimeAsync(2_500);
      stop();
    } finally {
      vi.useRealTimers();
    }
    const last = states[states.length - 1];
    expect(last?.syncLocked).toBe(true);
    expect(last?.mode).toBe("sync");
  });
});

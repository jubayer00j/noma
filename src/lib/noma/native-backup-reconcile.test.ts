import { beforeEach, describe, expect, it } from "vitest";
import type { NomaDatabase } from "./db";
import { getConnection, reconcileNativeBackup } from "./drive";

/* Minimal browser stand-ins: drive.ts keeps the connection in localStorage. */
class MemoryStorage {
  map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const storage = new MemoryStorage();
(globalThis as { window?: unknown }).window = {
  localStorage: storage,
  dispatchEvent: () => true,
};

function fakeDb(latestUpdatedAt: number, noteCount = 1): NomaDatabase {
  const notes = Array.from({ length: noteCount }, (_, i) => ({
    updatedAt: i === 0 ? latestUpdatedAt : 1,
  }));
  return {
    notes: { toArray: async () => notes },
    folders: { count: async () => 0 },
    tags: { count: async () => 0 },
    attachments: { count: async () => 0 },
  } as unknown as NomaDatabase;
}

function seedConnection(lastBackupAt: number | null): void {
  storage.setItem(
    "noma-drive-v1",
    JSON.stringify({
      email: "a@example.com",
      connectedAt: 1,
      lastBackupAt,
      folderId: "folder1",
      backupFileId: "file1",
      lastSignature: "0:0:0:0:0",
    }),
  );
}

describe("reconcileNativeBackup", () => {
  beforeEach(() => {
    storage.map.clear();
  });

  it("adopts a newer native upload whose signature matches the library", async () => {
    seedConnection(1_000);
    const db = fakeDb(5_000); // signature "1:0:0:0:5000"
    const applied = await reconcileNativeBackup(db, null, {
      lastBackupAt: 2_000,
      signature: "1:0:0:0:5000",
    });
    expect(applied).toBe(true);
    const connection = getConnection(null);
    expect(connection?.lastBackupAt).toBe(2_000);
    expect(connection?.lastSignature).toBe("1:0:0:0:5000");
  });

  it("ignores a native record older than the web layer's own backup", async () => {
    seedConnection(3_000);
    const applied = await reconcileNativeBackup(fakeDb(5_000), null, {
      lastBackupAt: 2_000,
      signature: "1:0:0:0:5000",
    });
    expect(applied).toBe(false);
    expect(getConnection(null)?.lastBackupAt).toBe(3_000);
  });

  it("ignores a native upload when the library has since moved on", async () => {
    seedConnection(1_000);
    const applied = await reconcileNativeBackup(fakeDb(9_000), null, {
      lastBackupAt: 2_000,
      signature: "1:0:0:0:5000",
    });
    expect(applied).toBe(false);
    expect(getConnection(null)?.lastSignature).toBe("0:0:0:0:0");
  });

  it("does nothing without a connection or a native upload", async () => {
    expect(
      await reconcileNativeBackup(fakeDb(5_000), null, {
        lastBackupAt: 2_000,
        signature: "1:0:0:0:5000",
      }),
    ).toBe(false);
    seedConnection(1_000);
    expect(
      await reconcileNativeBackup(fakeDb(5_000), null, { lastBackupAt: 0, signature: "" }),
    ).toBe(false);
  });
});

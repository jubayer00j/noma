import { beforeEach, describe, expect, it } from "vitest";
import { applyBackup, buildBackupZip, readBackupZip, readBackupArchive } from "./backup";
import {
  BackupKeyNeededError,
  BackupUnlockError,
  createEncryptionRecord,
  getBackupDeviceKey,
  getBackupEncryptionRecord,
  isEncryptedArchive,
  openArchive,
  parseHeader,
  rewrapRecord,
  saveBackupEncryptionRecord,
  sealArchive,
  unlockWithPassphrase,
} from "./backup-crypto";
import { type NomaDatabase } from "./db";
import { disconnectDrive, getConnection } from "./drive";
import type {
  AppSettings,
  AttachmentMeta,
  Folder,
  Note,
  Reminder,
  SyncTombstone,
  Tag,
} from "./types";

/* ---------------- Storage stand-in (same pattern as native-backup tests) ---------------- */

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  clear(): void {
    this.values.clear();
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: new MemoryStorage(), dispatchEvent: () => true },
    configurable: true,
    writable: true,
  });
});

/* ---------------- Fake Dexie surface (mirrors sync.test.ts) ---------------- */

type Row = { id: string };

class FakeTable<T extends Row> {
  rows = new Map<string, T>();
  async get(id: string): Promise<T | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }
  async put(row: T): Promise<string> {
    this.rows.set(row.id, structuredClone(row));
    return row.id;
  }
  async bulkPut(rows: T[]): Promise<void> {
    for (const row of rows) this.rows.set(row.id, structuredClone(row));
  }
  async update(id: string, patch: Partial<T>): Promise<number> {
    const current = this.rows.get(id);
    if (!current) return 0;
    this.rows.set(id, { ...current, ...patch });
    return 1;
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
  async bulkDelete(ids: string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
  async clear(): Promise<void> {
    this.rows.clear();
  }
  async count(): Promise<number> {
    return this.rows.size;
  }
  async toArray(): Promise<T[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
  filter(fn: (row: T) => boolean) {
    return {
      toArray: async () => [...this.rows.values()].filter(fn).map((row) => structuredClone(row)),
    };
  }
  where(field: string) {
    const matches = (value: unknown) =>
      [...this.rows.values()].filter(
        (row) => (row as unknown as Record<string, unknown>)[field] === value,
      );
    return {
      equals: (value: unknown) => ({
        toArray: async () => matches(value).map((row) => structuredClone(row)),
        count: async () => matches(value).length,
        delete: async () => {
          const found = matches(value);
          for (const row of found) this.rows.delete(row.id);
          return found.length;
        },
      }),
    };
  }
}

class FakeDb {
  name = "noma_test";
  notes = new FakeTable<Note>();
  folders = new FakeTable<Folder>();
  tags = new FakeTable<Tag>();
  attachments = new FakeTable<AttachmentMeta>();
  reminders = new FakeTable<Reminder>();
  settings = new FakeTable<AppSettings>();
  backups = new FakeTable<Row & { createdAt: number }>();
  tombstones = new FakeTable<SyncTombstone>();

  async transaction(...args: unknown[]): Promise<void> {
    const fn = args[args.length - 1] as () => Promise<void>;
    await fn();
  }
}

function asDb(fake: FakeDb): NomaDatabase {
  return fake as unknown as NomaDatabase;
}

const T0 = 1_700_000_000_000;

async function seedDb(): Promise<FakeDb> {
  const db = new FakeDb();
  await db.notes.put({
    id: "n1",
    title: "Secret plans",
    content: "<p>meet at dawn</p>",
    contentFormat: "tiptap-html",
    createdAt: T0,
    updatedAt: T0,
    folderId: null,
    tagIds: [],
    pinned: false,
    favorite: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    reminderAt: null,
    wordCount: 3,
  });
  return db;
}

const OWNER = "user-1";
const PASSPHRASE = "correct horse battery";

/* ---------------- Envelope + key hierarchy ---------------- */

describe("backup-crypto envelope", () => {
  it("seals and reopens an archive byte-identically", async () => {
    const { record, keyBytes } = await createEncryptionRecord(PASSPHRASE);
    const zipBytes = new TextEncoder().encode("PK fake zip contents");
    const sealed = await sealArchive(zipBytes, record, keyBytes);

    expect(isEncryptedArchive(sealed)).toBe(true);
    expect(new TextDecoder().decode(sealed.subarray(0, 8))).toBe("NOMAENC1");
    // The sealed file must not open as a ZIP.
    expect(new TextDecoder().decode(sealed.subarray(0, 2))).not.toBe("PK");

    const header = parseHeader(sealed);
    expect(header).toEqual({
      salt: record.salt,
      iterations: record.iterations,
      wrappedKey: record.wrappedKey,
    });

    const opened = await openArchive(sealed, keyBytes);
    expect(opened.header).toEqual(header);
    expect(opened.zipBytes).toEqual(zipBytes);
  });

  it("passes plaintext archives through untouched (legacy readability)", async () => {
    const zipBytes = new TextEncoder().encode("PK legacy backup");
    expect(isEncryptedArchive(zipBytes)).toBe(false);
    expect(parseHeader(zipBytes)).toBeNull();
    const opened = await openArchive(zipBytes);
    expect(opened.header).toBeNull();
    expect(opened.zipBytes).toEqual(zipBytes);
  });

  it("requires a key for encrypted archives, with the header attached", async () => {
    const { record, keyBytes } = await createEncryptionRecord(PASSPHRASE);
    const sealed = await sealArchive(new TextEncoder().encode("PK data"), record, keyBytes);
    const error = await openArchive(sealed).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackupKeyNeededError);
    expect((error as BackupKeyNeededError).header?.wrappedKey).toBe(record.wrappedKey);
  });

  it("rejects a wrong key with a typed BackupUnlockError", async () => {
    const { record, keyBytes } = await createEncryptionRecord(PASSPHRASE);
    const sealed = await sealArchive(new TextEncoder().encode("PK data"), record, keyBytes);
    const other = await createEncryptionRecord("a different passphrase");
    await expect(openArchive(sealed, other.keyBytes)).rejects.toBeInstanceOf(BackupUnlockError);
  });

  it("detects a tampered ciphertext (GCM failure)", async () => {
    const { record, keyBytes } = await createEncryptionRecord(PASSPHRASE);
    const sealed = await sealArchive(new TextEncoder().encode("PK data"), record, keyBytes);
    // Flip one base64 character inside the envelope's ciphertext.
    const text = new TextDecoder().decode(sealed);
    const marker = '"ct":"';
    const at = text.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const pos = at + marker.length + 4;
    const replacement = text[pos] === "A" ? "B" : "A";
    const tampered = new TextEncoder().encode(
      text.slice(0, pos) + replacement + text.slice(pos + 1),
    );
    expect(isEncryptedArchive(tampered)).toBe(true);
    await expect(openArchive(tampered, keyBytes)).rejects.toBeInstanceOf(BackupUnlockError);
  });

  it("unlocks with the right passphrase and rejects the wrong one cleanly", async () => {
    const { record, keyBytes } = await createEncryptionRecord(PASSPHRASE);
    const unlocked = await unlockWithPassphrase(record, PASSPHRASE);
    expect(unlocked).toEqual(keyBytes);
    await expect(unlockWithPassphrase(record, "wrong passphrase")).rejects.toBeInstanceOf(
      BackupUnlockError,
    );
    // A failed unlock stores nothing.
    expect(getBackupEncryptionRecord(OWNER)).toBeNull();
  });

  it("rewrap keeps the same master key, so older archives stay openable", async () => {
    const first = await createEncryptionRecord("first passphrase");
    const sealed = await sealArchive(
      new TextEncoder().encode("PK archive under v1"),
      first.record,
      first.keyBytes,
    );

    const newHeader = await rewrapRecord(first.keyBytes, "second passphrase");
    const unlocked = await unlockWithPassphrase(newHeader, "second passphrase");
    expect(unlocked).toEqual(first.keyBytes);

    // The archive sealed before the change still opens with the same BMK.
    const opened = await openArchive(sealed, unlocked);
    expect(new TextDecoder().decode(opened.zipBytes)).toBe("PK archive under v1");

    // And the new passphrase does NOT unwrap the old header.
    await expect(unlockWithPassphrase(first.record, "second passphrase")).rejects.toBeInstanceOf(
      BackupUnlockError,
    );
  });
});

/* ---------------- Record storage ---------------- */

describe("backup encryption record storage", () => {
  it("round-trips through localStorage keyed per account", async () => {
    const { record, keyBytes } = await createEncryptionRecord(PASSPHRASE);
    saveBackupEncryptionRecord(OWNER, record);
    expect(getBackupEncryptionRecord(OWNER)).toEqual(record);
    expect(getBackupDeviceKey(OWNER)).toEqual(keyBytes);
    expect(getBackupEncryptionRecord("someone-else")).toBeNull();
    expect(getBackupEncryptionRecord(null)).toBeNull();
  });

  it("is cleared when Drive disconnects (the sign-out path shares it)", async () => {
    const { record } = await createEncryptionRecord(PASSPHRASE);
    saveBackupEncryptionRecord(OWNER, record);
    // Seed a Drive connection record the way drive.ts stores it.
    const store = (globalThis as unknown as { window: { localStorage: MemoryStorage } }).window
      .localStorage;
    store.setItem(
      `noma-drive-v1-${OWNER}`,
      JSON.stringify({
        email: "a@example.com",
        connectedAt: 1,
        folderId: "folder1",
        backupFileId: "file1",
        lastBackupAt: 1,
        lastSignature: null,
      }),
    );
    expect(getConnection(OWNER)).not.toBeNull();
    await disconnectDrive(OWNER);
    expect(getConnection(OWNER)).toBeNull();
    expect(getBackupEncryptionRecord(OWNER)).toBeNull();
  });
});

/* ---------------- buildBackupZip / readBackupZip integration ---------------- */

describe("encrypted backup build + read", () => {
  it("build → seal → read returns the identical payload, and applyBackup restores it", async () => {
    const db = await seedDb();
    const { record, keyBytes } = await createEncryptionRecord(PASSPHRASE);
    const { blob, payload } = await buildBackupZip(asDb(db), OWNER, {
      encryption: { header: record, keyBytes },
    });

    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(isEncryptedArchive(bytes)).toBe(true);

    const { payload: parsed, encryption } = await readBackupArchive(blob, OWNER, keyBytes);
    expect(encryption).toEqual({
      salt: record.salt,
      iterations: record.iterations,
      wrappedKey: record.wrappedKey,
    });
    expect(parsed.notes.map((n) => n.id)).toEqual(payload.notes.map((n) => n.id));
    expect(parsed.notes[0]?.title).toBe("Secret plans");
    expect(parsed.manifest.noteCount).toBe(1);
    expect(parsed.deviceId).toBe(payload.deviceId);

    const target = new FakeDb();
    const counts = await applyBackup(asDb(target), parsed, "replace");
    expect(counts.added).toBe(1);
    const restored = await target.notes.get("n1");
    expect(restored?.title).toBe("Secret plans");
    expect(restored?.content).toContain("meet at dawn");
  });

  it("reading an encrypted archive without a key throws the needs-key error", async () => {
    const db = await seedDb();
    const { record, keyBytes } = await createEncryptionRecord(PASSPHRASE);
    const { blob } = await buildBackupZip(asDb(db), OWNER, {
      encryption: { header: record, keyBytes },
    });
    await expect(readBackupZip(blob, OWNER)).rejects.toBeInstanceOf(BackupKeyNeededError);
    const other = await createEncryptionRecord("another passphrase");
    await expect(readBackupZip(blob, OWNER, other.keyBytes)).rejects.toBeInstanceOf(
      BackupUnlockError,
    );
  });

  it("auto-seals from the stored record, and refuses to build plaintext while keyless", async () => {
    const db = await seedDb();
    const { record, keyBytes } = await createEncryptionRecord(PASSPHRASE);
    saveBackupEncryptionRecord(OWNER, record);

    // Record + device key: a plain build (the backupNow / staging path)
    // seals automatically.
    const { blob } = await buildBackupZip(asDb(db), OWNER);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(isEncryptedArchive(bytes)).toBe(true);
    const parsed = await readBackupZip(blob, OWNER, keyBytes);
    expect(parsed.notes).toHaveLength(1);

    // Record without the device key: the builder must throw rather than
    // ever fall back to a plaintext archive.
    saveBackupEncryptionRecord(OWNER, {
      salt: record.salt,
      iterations: record.iterations,
      wrappedKey: record.wrappedKey,
    });
    await expect(buildBackupZip(asDb(db), OWNER)).rejects.toBeInstanceOf(BackupKeyNeededError);
  });

  it("a plaintext build from before setup still reads after encryption is set up", async () => {
    const db = await seedDb();
    const { blob, payload } = await buildBackupZip(asDb(db), OWNER, { encryption: null });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(isEncryptedArchive(bytes)).toBe(false);
    expect(new TextDecoder().decode(bytes.subarray(0, 2))).toBe("PK");

    const { record } = await createEncryptionRecord(PASSPHRASE);
    saveBackupEncryptionRecord(OWNER, record);
    const parsed = await readBackupZip(blob, OWNER);
    expect(parsed.notes.map((n) => n.id)).toEqual(payload.notes.map((n) => n.id));
  });
});

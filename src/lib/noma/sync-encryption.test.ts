import { beforeEach, describe, expect, it } from "vitest";
import type { BackupPayload } from "./backup";
import { buildBackupZip, readBackupArchive } from "./backup";
import {
  BackupKeyNeededError,
  getBackupEncryptionRecord,
  isEncryptedArchive,
  saveBackupEncryptionRecord,
  unlockWithPassphrase,
  type BackupEncryptionHeader,
  type BackupEncryptionRecord,
} from "./backup-crypto";
import { type NomaDatabase } from "./db";
import { getSyncState, syncNow, type SyncDriveDeps } from "./sync";
import { deriveKeyHash, generateSalt } from "./app-lock-crypto";
import {
  base64ToBytes,
  bytesToBase64,
  encryptBytes,
  generateNoteKey,
} from "./note-lock-crypto";
import type {
  AppSettings,
  AttachmentMeta,
  Folder,
  Note,
  Reminder,
  SyncState,
  SyncTombstone,
  Tag,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

/* ---------------- Storage stand-in ---------------- */

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
    value: {
      localStorage: new MemoryStorage(),
      dispatchEvent: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
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
  syncMeta = new FakeTable<SyncState>();

  async transaction(...args: unknown[]): Promise<void> {
    const fn = args[args.length - 1] as () => Promise<void>;
    await fn();
  }
}

function asDb(fake: FakeDb): NomaDatabase {
  return fake as unknown as NomaDatabase;
}

const T0 = 1_700_000_000_000;
const OWNER = "user-1";

function makeNote(id: string): Note {
  return {
    id,
    title: `Note ${id}`,
    content: `<p>content ${id}</p>`,
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
    wordCount: 2,
  };
}

function makePayload(notes: Note[]): BackupPayload {
  return {
    manifest: {
      backupFormatVersion: 2,
      nomaVersion: "1.2.0",
      createdAt: new Date(T0).toISOString(),
      noteCount: notes.length,
      folderCount: 0,
      tagCount: 0,
      attachmentCount: 0,
      ownerId: OWNER,
      libraryId: "noma_test",
      deviceId: "device-b",
    },
    notes,
    folders: [],
    tags: [],
    attachments: [],
    reminders: [],
    settings: null,
    tombstones: [],
    deviceId: "device-b",
  };
}

/**
 * A wrap record built with a low iteration count: adoption and unlock
 * semantics don't depend on the KDF cost, and the real 600k path is
 * covered by backup-encryption.test.ts.
 */
async function makeRecord(
  passphrase: string,
  withDeviceKey: boolean,
): Promise<{ record: BackupEncryptionRecord; keyBytes: Uint8Array }> {
  const keyBytes = generateNoteKey();
  const salt = generateSalt();
  const iterations = 1000;
  // deriveKeyHash returns the derived key base64-encoded (app-lock style).
  const kek = base64ToBytes(await deriveKeyHash(passphrase, salt, iterations));
  const parsed = JSON.parse(await encryptBytes(kek, keyBytes)) as { iv: string; ct: string };
  const iv = Buffer.from(parsed.iv, "base64");
  const ct = Buffer.from(parsed.ct, "base64");
  const combined = Buffer.concat([iv, ct]);
  return {
    record: {
      salt,
      iterations,
      wrappedKey: combined.toString("base64"),
      ...(withDeviceKey ? { deviceKey: bytesToBase64(keyBytes) } : {}),
    },
    keyBytes,
  };
}

/* ---------------- Fake Drive deps ---------------- */

interface FakeRemoteState {
  payload: BackupPayload | null;
  encryption: BackupEncryptionHeader | null;
  fetchError: Error | null;
  modifiedTime: number;
  checksum: string | null;
  uploads: number;
}

function makeDeps(remote: FakeRemoteState): SyncDriveDeps {
  return {
    getConnection: () => ({
      email: "a@example.com",
      connectedAt: 1,
      lastBackupAt: null,
      folderId: "folder1",
      backupFileId: remote.payload || remote.fetchError ? "file1" : null,
      lastSignature: null,
    }),
    getCanonicalFileMeta: async () =>
      remote.payload || remote.fetchError
        ? {
            id: "file1",
            modifiedTime: remote.modifiedTime,
            md5Checksum: remote.checksum,
            size: null,
          }
        : null,
    fetchCanonicalBackup: async () => {
      if (remote.fetchError) throw remote.fetchError;
      if (!remote.payload) return null;
      return {
        payload: structuredClone(remote.payload),
        meta: {
          id: "file1",
          modifiedTime: remote.modifiedTime,
          md5Checksum: remote.checksum,
          size: null,
        },
        encryption: remote.encryption,
      };
    },
    backupNow: async () => {
      remote.uploads++;
      return {
        connection: {
          email: "a@example.com",
          connectedAt: 1,
          lastBackupAt: Date.now(),
          folderId: "folder1",
          backupFileId: "file1",
          lastSignature: null,
        },
        manifest: makePayload([]).manifest,
      };
    },
  };
}

async function seedDb(): Promise<FakeDb> {
  const db = new FakeDb();
  await db.settings.put({ ...DEFAULT_SETTINGS, backupMode: "sync" });
  return db;
}

/* ---------------- Sync + encryption ---------------- */

describe("sync with an encrypted remote", () => {
  it("returns a calm `locked` outcome — no throw, no merge, no state written", async () => {
    const db = await seedDb();
    const remote: FakeRemoteState = {
      payload: makePayload([makeNote("remote-1")]),
      encryption: null,
      fetchError: new BackupKeyNeededError("encrypted, no key"),
      modifiedTime: T0 + 1000,
      checksum: "abc",
      uploads: 0,
    };
    const result = await syncNow(asDb(db), OWNER, "manual", { deps: makeDeps(remote) });
    expect(result.status).toBe("locked");
    expect(result.reason).toContain("passphrase");
    // Nothing merged, nothing pushed, sync state untouched.
    expect(await db.notes.count()).toBe(0);
    expect(remote.uploads).toBe(0);
    const state = await getSyncState(asDb(db));
    expect(state.lastSyncAt).toBeNull();
    expect(state.lastRemoteSignature).toBeNull();
  });

  it("unlock-then-sync: after the key is stored, the next cycle merges and adopts the header", async () => {
    const db = await seedDb();
    const { record, keyBytes } = await makeRecord("fleet passphrase", false);
    const remote: FakeRemoteState = {
      payload: null,
      encryption: null,
      fetchError: new BackupKeyNeededError("encrypted, no key", record),
      modifiedTime: T0 + 1000,
      checksum: "abc",
      uploads: 0,
    };
    const deps = makeDeps(remote);
    const locked = await syncNow(asDb(db), OWNER, "manual", { deps });
    expect(locked.status).toBe("locked");

    // The user unlocks: the dialog unwraps the master key with the
    // passphrase against the archive header and stores the device key.
    const unlockedKey = await unlockWithPassphrase(record, "fleet passphrase");
    expect(unlockedKey).toEqual(keyBytes);
    saveBackupEncryptionRecord(OWNER, { ...record, deviceKey: bytesToBase64(unlockedKey) });
    remote.fetchError = null;
    remote.payload = makePayload([makeNote("remote-1")]);
    remote.encryption = record;

    const synced = await syncNow(asDb(db), OWNER, "manual", { deps });
    expect(synced.status).toBe("synced");
    expect((await db.notes.get("remote-1"))?.title).toBe("Note remote-1");
    // The archive header was adopted; the device key survived adoption.
    const stored = getBackupEncryptionRecord(OWNER);
    expect(stored?.wrappedKey).toBe(record.wrappedKey);
    expect(stored?.deviceKey).toBe(bytesToBase64(keyBytes));
  });

  it("adopts a peer's new wrap parameters after a passphrase change, keeping the device key", async () => {
    const db = await seedDb();
    const mine = await makeRecord("old passphrase", true);
    saveBackupEncryptionRecord(OWNER, mine.record);
    // Same BMK, re-wrapped under the peer's new passphrase.
    const peerHeader: BackupEncryptionHeader = {
      salt: generateSalt(),
      iterations: 1000,
      wrappedKey: (await makeRecord("new passphrase", false)).record.wrappedKey,
    };
    const remote: FakeRemoteState = {
      payload: makePayload([makeNote("remote-1")]),
      encryption: peerHeader,
      fetchError: null,
      modifiedTime: T0 + 1000,
      checksum: "abc",
      uploads: 0,
    };
    const result = await syncNow(asDb(db), OWNER, "manual", { deps: makeDeps(remote) });
    expect(result.status).toBe("synced");
    const stored = getBackupEncryptionRecord(OWNER);
    expect(stored?.salt).toBe(peerHeader.salt);
    expect(stored?.wrappedKey).toBe(peerHeader.wrappedKey);
    expect(stored?.deviceKey).toBe(mine.record.deviceKey);
  });

  it("a plaintext pull clears the local record (fleet turn-off propagates)", async () => {
    const db = await seedDb();
    const mine = await makeRecord("passphrase", true);
    saveBackupEncryptionRecord(OWNER, mine.record);
    const remote: FakeRemoteState = {
      payload: makePayload([makeNote("remote-1")]),
      encryption: null,
      fetchError: null,
      modifiedTime: T0 + 1000,
      checksum: "abc",
      uploads: 0,
    };
    const result = await syncNow(asDb(db), OWNER, "manual", { deps: makeDeps(remote) });
    expect(result.status).toBe("synced");
    expect(getBackupEncryptionRecord(OWNER)).toBeNull();
  });

  it("pushes a sealed archive through the real builder when encryption is on", async () => {
    const db = await seedDb();
    await db.notes.put(makeNote("local-1"));
    const mine = await makeRecord("push passphrase", true);
    saveBackupEncryptionRecord(OWNER, mine.record);

    let pushedBytes: Uint8Array | null = null;
    const deps = makeDeps({
      payload: null,
      encryption: null,
      fetchError: null,
      modifiedTime: 0,
      checksum: null,
      uploads: 0,
    });
    // The push half of a cycle is backupNow, which builds via
    // buildBackupZip — run the real builder here and capture the bytes
    // that would land in Drive.
    deps.backupNow = async (dbArg) => {
      const { blob, payload } = await buildBackupZip(dbArg, OWNER);
      pushedBytes = new Uint8Array(await blob.arrayBuffer());
      return {
        connection: {
          email: "a@example.com",
          connectedAt: 1,
          lastBackupAt: Date.now(),
          folderId: "folder1",
          backupFileId: "file1",
          lastSignature: null,
        },
        manifest: payload.manifest,
      };
    };

    const result = await syncNow(asDb(db), OWNER, "manual", { deps });
    expect(result.status).toBe("synced");
    expect(result.pushed).toBe(true);
    expect(pushedBytes).not.toBeNull();
    expect(isEncryptedArchive(pushedBytes!)).toBe(true);

    // And the sealed push opens with the master key to the local library.
    const { payload, encryption } = await readBackupArchive(
      new Blob([pushedBytes! as BlobPart]),
      OWNER,
      mine.keyBytes,
    );
    expect(encryption?.wrappedKey).toBe(mine.record.wrappedKey);
    expect(payload.notes.map((n) => n.id)).toContain("local-1");
  });
});


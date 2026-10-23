import {
  base64ToBytes,
  bytesToBase64,
  decryptBytes,
  encryptBytes,
  generateNoteKey,
  unwrapNoteKey,
  wrapNoteKey,
} from "./note-lock-crypto";

/**
 * Encrypted backup archives.
 *
 * The whole backup ZIP is sealed with AES-256-GCM under a random Backup
 * Master Key (BMK). The BMK is wrapped by a key derived from the user's
 * backup passphrase via PBKDF2-HMAC-SHA256 (600,000 iterations — the note
 * password strength), reusing the note-lock wrap/unwrap primitives, so a
 * passphrase change only re-wraps the same BMK and older archives stay
 * openable. There is no recovery: a forgotten passphrase means encrypted
 * archives cannot be opened, by anyone.
 *
 * File layout (the canonical "Noma Backup.zip" name does not change):
 *
 *   "NOMAENC1" (8 bytes) || uint32BE header length || header JSON ||
 *   note-lock style envelope JSON ({"nomaEnc":1,"iv":…,"ct":…})
 *
 * The header carries the portable wrap parameters ({ v, salt, iterations,
 * wrappedKey }) so any device with the passphrase can join from the file
 * alone. Legacy plaintext ZIPs (starting with "PK") are always readable.
 */

/** Thrown when a passphrase (or held key) fails to open an archive. */
export class BackupUnlockError extends Error {
  constructor(message = "Incorrect passphrase") {
    super(message);
    this.name = "BackupUnlockError";
  }
}

/** Thrown when an archive is encrypted but no key is available. Carries
 * the archive's header (when known) so an unlock prompt can unwrap
 * against it without downloading the file again. */
export class BackupKeyNeededError extends Error {
  header: BackupEncryptionHeader | null;
  constructor(
    message = "This backup is encrypted. Enter your backup passphrase to continue.",
    header: BackupEncryptionHeader | null = null,
  ) {
    super(message);
    this.name = "BackupKeyNeededError";
    this.header = header;
  }
}

/** The portable wrap parameters — everything a passphrase needs. */
export interface BackupEncryptionHeader {
  salt: string;
  iterations: number;
  wrappedKey: string;
}

/**
 * Per-account, per-device state (localStorage, never synced or backed
 * up). Presence of the record means backup encryption is enabled for
 * the account. `deviceKey` is this device's convenience copy of the
 * BMK so automatic backups and sync can run unattended; removing it
 * pauses those flows until the passphrase is re-entered.
 */
export interface BackupEncryptionRecord extends BackupEncryptionHeader {
  deviceKey?: string;
}

const MAGIC = "NOMAENC1";
const MAGIC_BYTES = new TextEncoder().encode(MAGIC);

/* ---------------- Key hierarchy ---------------- */

/** Creates a fresh BMK + wrap record for a new passphrase (setup). */
export async function createEncryptionRecord(
  passphrase: string,
): Promise<{ record: BackupEncryptionRecord; keyBytes: Uint8Array }> {
  const keyBytes = generateNoteKey();
  const slot = await wrapNoteKey(keyBytes, "password", passphrase);
  const record: BackupEncryptionRecord = {
    salt: slot.salt,
    iterations: slot.iterations,
    wrappedKey: slot.wrappedKey,
    deviceKey: bytesToBase64(keyBytes),
  };
  return { record, keyBytes };
}

/**
 * Unwraps the BMK with a passphrase. Throws BackupUnlockError on a wrong
 * passphrase — the GCM authentication check is the verdict, so there is
 * exactly one clean failure and no partial state.
 */
export async function unlockWithPassphrase(
  source: BackupEncryptionHeader,
  passphrase: string,
): Promise<Uint8Array> {
  const keyBytes = await unwrapNoteKey(
    { salt: source.salt, iterations: source.iterations, wrappedKey: source.wrappedKey },
    "password",
    passphrase,
  );
  if (!keyBytes) throw new BackupUnlockError("Incorrect passphrase");
  return keyBytes;
}

/** Re-wraps the same BMK under a new passphrase (passphrase change). */
export async function rewrapRecord(
  keyBytes: Uint8Array,
  newPassphrase: string,
): Promise<BackupEncryptionHeader> {
  const slot = await wrapNoteKey(keyBytes, "password", newPassphrase);
  return { salt: slot.salt, iterations: slot.iterations, wrappedKey: slot.wrappedKey };
}

/* ---------------- Archive envelope ---------------- */

export function isEncryptedArchive(bytes: Uint8Array): boolean {
  if (bytes.byteLength < MAGIC_BYTES.byteLength) return false;
  for (let i = 0; i < MAGIC_BYTES.byteLength; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) return false;
  }
  return true;
}

interface ParsedEnvelope {
  header: BackupEncryptionHeader;
  envelopeJson: string;
}

function parseEnvelope(bytes: Uint8Array): ParsedEnvelope {
  const corrupt = () =>
    new BackupUnlockError(
      "This encrypted backup couldn't be read — the file looks damaged.",
    );
  if (bytes.byteLength < MAGIC_BYTES.byteLength + 4) throw corrupt();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(MAGIC_BYTES.byteLength, false);
  const headerStart = MAGIC_BYTES.byteLength + 4;
  if (headerLength <= 0 || headerStart + headerLength > bytes.byteLength) throw corrupt();
  let header: BackupEncryptionHeader;
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength)),
    ) as { v?: number; salt?: string; iterations?: number; wrappedKey?: string };
    if (
      parsed.v !== 1 ||
      typeof parsed.salt !== "string" ||
      typeof parsed.iterations !== "number" ||
      typeof parsed.wrappedKey !== "string"
    ) {
      throw new Error("bad header");
    }
    header = {
      salt: parsed.salt,
      iterations: parsed.iterations,
      wrappedKey: parsed.wrappedKey,
    };
  } catch {
    throw corrupt();
  }
  return {
    header,
    envelopeJson: new TextDecoder().decode(bytes.subarray(headerStart + headerLength)),
  };
}

/** The wrap parameters of an encrypted archive, or null for a plaintext one. */
export function parseHeader(bytes: Uint8Array): BackupEncryptionHeader | null {
  if (!isEncryptedArchive(bytes)) return null;
  return parseEnvelope(bytes).header;
}

/** Seals ZIP bytes under the BMK, prefixed with the magic + header. */
export async function sealArchive(
  zipBytes: Uint8Array,
  header: BackupEncryptionHeader,
  keyBytes: Uint8Array,
): Promise<Uint8Array> {
  const envelopeJson = await encryptBytes(keyBytes, zipBytes);
  const headerBytes = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      salt: header.salt,
      iterations: header.iterations,
      wrappedKey: header.wrappedKey,
    }),
  );
  const envelopeBytes = new TextEncoder().encode(envelopeJson);
  const out = new Uint8Array(8 + 4 + headerBytes.byteLength + envelopeBytes.byteLength);
  const view = new DataView(out.buffer);
  out.set(MAGIC_BYTES, 0);
  view.setUint32(8, headerBytes.byteLength, false);
  out.set(headerBytes, 12);
  out.set(envelopeBytes, 12 + headerBytes.byteLength);
  return out;
}

/**
 * Opens an archive: plaintext bytes pass through untouched; encrypted
 * bytes require `keyBytes` (throws BackupKeyNeededError without one,
 * BackupUnlockError when the key doesn't fit).
 */
export async function openArchive(
  bytes: Uint8Array,
  keyBytes?: Uint8Array | null,
): Promise<{ zipBytes: Uint8Array; header: BackupEncryptionHeader | null }> {
  if (!isEncryptedArchive(bytes)) return { zipBytes: bytes, header: null };
  const { header, envelopeJson } = parseEnvelope(bytes);
  if (!keyBytes) {
    throw new BackupKeyNeededError(
      "This backup is encrypted. Enter your backup passphrase to continue.",
      header,
    );
  }
  try {
    const zipBytes = await decryptBytes(keyBytes, envelopeJson);
    return { zipBytes, header };
  } catch {
    throw new BackupUnlockError(
      "This encrypted backup couldn't be opened — the passphrase may be wrong or the file is damaged.",
    );
  }
}

/* ---------------- Local record (per account, this device only) ---------------- */

function localStore(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    /* storage unavailable (private mode, tests) */
  }
  return null;
}

/** Mirrors the Drive connection record's keying (`noma-drive-v1[-<uid>]`). */
function recordKey(ownerId: string | null): string {
  return ownerId ? `noma-backup-encryption-v1-${ownerId}` : "noma-backup-encryption-v1";
}

export function getBackupEncryptionRecord(
  ownerId: string | null,
): BackupEncryptionRecord | null {
  const store = localStore();
  if (!store) return null;
  try {
    const raw = store.getItem(recordKey(ownerId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BackupEncryptionRecord>;
    if (
      typeof parsed.salt !== "string" ||
      typeof parsed.iterations !== "number" ||
      typeof parsed.wrappedKey !== "string"
    ) {
      return null;
    }
    return {
      salt: parsed.salt,
      iterations: parsed.iterations,
      wrappedKey: parsed.wrappedKey,
      ...(typeof parsed.deviceKey === "string" ? { deviceKey: parsed.deviceKey } : {}),
    };
  } catch {
    return null;
  }
}

export function saveBackupEncryptionRecord(
  ownerId: string | null,
  record: BackupEncryptionRecord | null,
): void {
  const store = localStore();
  if (!store) return;
  try {
    if (record) store.setItem(recordKey(ownerId), JSON.stringify(record));
    else store.removeItem(recordKey(ownerId));
  } catch {
    /* storage unavailable — encryption state simply doesn't persist */
  }
}

export function clearBackupEncryptionRecord(ownerId: string | null): void {
  saveBackupEncryptionRecord(ownerId, null);
}

/** This device's BMK copy, decoded — null when not held (or not enabled). */
export function getBackupDeviceKey(ownerId: string | null): Uint8Array | null {
  const record = getBackupEncryptionRecord(ownerId);
  if (!record?.deviceKey) return null;
  try {
    return base64ToBytes(record.deviceKey);
  } catch {
    return null;
  }
}

/**
 * Adopts wrap parameters seen in a pulled archive (spec D6): the BMK is
 * unchanged by passphrase changes, so a held device key keeps working;
 * only the wrap parameters are replaced. Creates a keyless record when
 * this device had none — that is how a second device learns encryption
 * is on and can offer unlock.
 */
export function adoptBackupEncryptionHeader(
  ownerId: string | null,
  header: BackupEncryptionHeader,
): void {
  const existing = getBackupEncryptionRecord(ownerId);
  saveBackupEncryptionRecord(ownerId, {
    salt: header.salt,
    iterations: header.iterations,
    wrappedKey: header.wrappedKey,
    ...(existing?.deviceKey ? { deviceKey: existing.deviceKey } : {}),
  });
}

/** Stores (or replaces) this device's BMK copy on the current record. */
export function storeBackupDeviceKey(ownerId: string | null, keyBytes: Uint8Array): void {
  const existing = getBackupEncryptionRecord(ownerId);
  if (!existing) return;
  saveBackupEncryptionRecord(ownerId, { ...existing, deviceKey: bytesToBase64(keyBytes) });
}

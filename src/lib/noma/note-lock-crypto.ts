import { canonicalizePattern, deriveKeyHash, generateSalt } from "./app-lock-crypto";
import type { NoteLockMethod, NoteLockSlot } from "./types";

/**
 * Per-note encryption primitives.
 *
 * Each locked note gets a random 32-byte Note Encryption Key (NEK). The note
 * body and every attachment payload are sealed with AES-256-GCM under the
 * NEK. The NEK itself is never stored: each credential method (password,
 * PIN, pattern) stores a "slot" — the NEK wrapped by a key derived from
 * that credential via PBKDF2-HMAC-SHA256. A wrong credential fails the GCM
 * authentication check on unwrap, so no separate verifier hash is needed.
 *
 * Fingerprint unlock is a convenience gate, not a key slot: the native
 * biometric plugin only reports success/failure (it cannot hold keys), so
 * the NEK copy it releases is wrapped by a random per-device key kept in
 * localStorage — the same trust posture as the app lock's biometric unlock.
 * That copy never leaves the device (backups only carry credential slots),
 * and a backup credential is always required alongside it.
 */

export const NOTE_LOCK_ITERATIONS: Record<NoteLockMethod, number> = {
  password: 600000,
  pin: 300000,
  pattern: 100000,
};

/** Canonical secret string fed into PBKDF2 for a credential. */
export function canonicalNoteSecret(
  method: NoteLockMethod,
  secret: string | number[],
): string {
  if (method === "pattern") {
    return canonicalizePattern(Array.isArray(secret) ? secret : []);
  }
  const value = typeof secret === "string" ? secret : "";
  if (method === "pin") return `noma_pin_v1:${value}`;
  return value;
}

export function isValidPin(pin: string): boolean {
  return /^\d{4,6}$/.test(pin);
}

/* ---------------- Base64 helpers ---------------- */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    const byte = bytes[i];
    if (byte !== undefined) binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i) || 0;
  }
  return bytes;
}

/* ---------------- Content envelopes ---------------- */

interface NoteEnvelope {
  nomaEnc: 1;
  iv: string;
  ct: string;
}

/** True when a stored content/attachment payload is an encryption envelope. */
export function isEncryptedContent(value: string): boolean {
  if (typeof value !== "string" || !value.startsWith('{"nomaEnc":1')) return false;
  try {
    const parsed = JSON.parse(value) as Partial<NoteEnvelope>;
    return parsed.nomaEnc === 1 && typeof parsed.iv === "string" && typeof parsed.ct === "string";
  } catch {
    return false;
  }
}

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptBytes(keyBytes: Uint8Array, data: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(keyBytes);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data as BufferSource);
  const envelope: NoteEnvelope = {
    nomaEnc: 1,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ct)),
  };
  return JSON.stringify(envelope);
}

/** Decrypts an envelope produced by encryptBytes. Throws on a wrong key or tampering. */
export async function decryptBytes(keyBytes: Uint8Array, envelopeJson: string): Promise<Uint8Array> {
  const envelope = JSON.parse(envelopeJson) as NoteEnvelope;
  const key = await importAesKey(keyBytes);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv) as BufferSource },
    key,
    base64ToBytes(envelope.ct) as BufferSource,
  );
  return new Uint8Array(plain);
}

export async function encryptText(keyBytes: Uint8Array, plaintext: string): Promise<string> {
  return encryptBytes(keyBytes, new TextEncoder().encode(plaintext));
}

export async function decryptText(keyBytes: Uint8Array, envelopeJson: string): Promise<string> {
  return new TextDecoder().decode(await decryptBytes(keyBytes, envelopeJson));
}

/* ---------------- Note key + credential slots ---------------- */

export function generateNoteKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Wraps the NEK under a key derived from one credential, producing a slot. */
export async function wrapNoteKey(
  nek: Uint8Array,
  method: NoteLockMethod,
  secret: string | number[],
): Promise<NoteLockSlot> {
  const salt = generateSalt();
  const iterations = NOTE_LOCK_ITERATIONS[method];
  const kekBits = base64ToBytes(
    await deriveKeyHash(canonicalNoteSecret(method, secret), salt, iterations),
  );
  // Reuse the content envelope: wrappedKey stores iv || ct packed into one
  // envelope JSON's fields, base64-wrapped for a compact single string.
  const envelopeJson = await encryptBytes(kekBits, nek);
  const envelope = JSON.parse(envelopeJson) as NoteEnvelope;
  const packed = new Uint8Array([
    ...base64ToBytes(envelope.iv),
    ...base64ToBytes(envelope.ct),
  ]);
  return { salt, iterations, wrappedKey: bytesToBase64(packed) };
}

/**
 * Unwraps the NEK with one credential. Returns null when the credential is
 * wrong (AES-GCM authentication failure) — never throws for a bad secret.
 */
export async function unwrapNoteKey(
  slot: NoteLockSlot,
  method: NoteLockMethod,
  secret: string | number[],
): Promise<Uint8Array | null> {
  try {
    const kekBits = base64ToBytes(
      await deriveKeyHash(canonicalNoteSecret(method, secret), slot.salt, slot.iterations),
    );
    const packed = base64ToBytes(slot.wrappedKey);
    const envelope: NoteEnvelope = {
      nomaEnc: 1,
      iv: bytesToBase64(packed.slice(0, 12)),
      ct: bytesToBase64(packed.slice(12)),
    };
    return await decryptBytes(kekBits, JSON.stringify(envelope));
  } catch {
    return null;
  }
}

/* ---------------- Fingerprint device copy ---------------- */

const DEVICE_KEY_STORAGE = "noma.notelock.deviceKey";
const bioStorageKey = (noteId: string) => `noma.notelock.bio.${noteId}`;

function localStore(): Storage | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) return window.localStorage;
  } catch {
    /* storage unavailable (private mode, tests) */
  }
  return null;
}

async function getOrCreateDeviceKey(store: Storage): Promise<Uint8Array> {
  const existing = store.getItem(DEVICE_KEY_STORAGE);
  if (existing) return base64ToBytes(existing);
  const key = crypto.getRandomValues(new Uint8Array(32));
  store.setItem(DEVICE_KEY_STORAGE, bytesToBase64(key));
  return key;
}

/**
 * Stores the on-device NEK copy that a successful fingerprint prompt may
 * release. Returns false when device storage is unavailable (fingerprint
 * unlock then simply stays unavailable on this device).
 */
export async function storeBiometricCopy(noteId: string, nek: Uint8Array): Promise<boolean> {
  const store = localStore();
  if (!store) return false;
  try {
    const deviceKey = await getOrCreateDeviceKey(store);
    store.setItem(bioStorageKey(noteId), await encryptBytes(deviceKey, nek));
    return true;
  } catch {
    return false;
  }
}

export async function readBiometricCopy(noteId: string): Promise<Uint8Array | null> {
  const store = localStore();
  if (!store) return null;
  try {
    const envelope = store.getItem(bioStorageKey(noteId));
    const deviceKeyB64 = store.getItem(DEVICE_KEY_STORAGE);
    if (!envelope || !deviceKeyB64) return null;
    return await decryptBytes(base64ToBytes(deviceKeyB64), envelope);
  } catch {
    return null;
  }
}

export function hasBiometricCopy(noteId: string): boolean {
  const store = localStore();
  if (!store) return false;
  try {
    return store.getItem(bioStorageKey(noteId)) !== null;
  } catch {
    return false;
  }
}

export function removeBiometricCopy(noteId: string): void {
  const store = localStore();
  if (!store) return;
  try {
    store.removeItem(bioStorageKey(noteId));
  } catch {
    /* ignore */
  }
}

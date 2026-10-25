import { getLockoutDurationMs } from "./app-lock-crypto";
import type { NomaDatabase } from "./db";
import {
  decryptText,
  encryptText,
  generateNoteKey,
  isEncryptedContent,
  readBiometricCopy,
  removeBiometricCopy,
  storeBiometricCopy,
  unwrapNoteKey,
  wrapNoteKey,
} from "./note-lock-crypto";
import { countWords } from "./sanitize";
import { invalidateNoteVector, maintainSemanticIndexForNote } from "./semantic";
import { clearVersions } from "./versions";
import type { Note, NoteLock, NoteLockMethod } from "./types";

export const NOTE_LOCK_METHOD_LABEL: Record<NoteLockMethod, string> = {
  password: "password",
  pin: "PIN",
  pattern: "pattern",
};

export type UnlockResult =
  | { ok: true; nek: Uint8Array }
  | { ok: false; error: string; lockoutSeconds?: number };

/** Seconds left in the note's lockout window (0 when not locked out). */
export function noteLockoutSeconds(lock: NoteLock, now = Date.now()): number {
  if (!lock.lockoutUntil || lock.lockoutUntil <= now) return 0;
  return Math.ceil((lock.lockoutUntil - now) / 1000);
}

async function recordFailedAttempt(
  db: NomaDatabase,
  note: Note,
  lock: NoteLock,
): Promise<{ attempts: number; lockoutSeconds: number }> {
  const now = Date.now();
  const attempts = lock.failedAttempts + 1;
  const durationMs = getLockoutDurationMs(attempts);
  const next: NoteLock = {
    ...lock,
    failedAttempts: attempts,
    lockoutUntil: durationMs > 0 ? now + durationMs : lock.lockoutUntil,
  };
  await db.notes.update(note.id, { lock: next });
  return { attempts, lockoutSeconds: Math.ceil(durationMs / 1000) };
}

async function resetAttempts(db: NomaDatabase, note: Note, lock: NoteLock): Promise<void> {
  if (lock.failedAttempts === 0 && lock.lockoutUntil === null) return;
  await db.notes.update(note.id, { lock: { ...lock, failedAttempts: 0, lockoutUntil: null } });
}

/**
 * Locks a note: generates its encryption key, seals the body and every
 * attachment, and stores the key wrapped by the chosen credential.
 * Fingerprint can be enabled alongside — never instead of — the credential.
 */
export async function lockNote(
  db: NomaDatabase,
  noteId: string,
  method: NoteLockMethod,
  secret: string | number[],
  options: { biometric?: boolean } = {},
): Promise<Note> {
  const note = await db.notes.get(noteId);
  if (!note) throw new Error("Note not found.");
  if (note.lock) throw new Error("This note is already locked.");

  const nek = generateNoteKey();
  const slot = await wrapNoteKey(nek, method, secret);
  const wordCount = countWords(note.content);
  const encryptedContent = await encryptText(nek, note.content);

  const attachments = await db.attachments.where("noteId").equals(noteId).toArray();
  for (const attachment of attachments) {
    if (attachment.data && !attachment.encrypted) {
      await db.attachments.update(attachment.id, {
        data: await encryptText(nek, attachment.data),
        encrypted: true,
        // Bump so sync's newest-wins merge propagates the sealed payload.
        updatedAt: Date.now(),
      });
    }
  }

  const lock: NoteLock = {
    v: 1,
    slots: { [method]: slot },
    biometric: false,
    failedAttempts: 0,
    lockoutUntil: null,
    lockedAt: Date.now(),
  };

  if (options.biometric) {
    lock.biometric = await storeBiometricCopy(noteId, nek);
  }

  await db.notes.update(noteId, {
    content: encryptedContent,
    lock,
    wordCount,
    updatedAt: Date.now(),
  });

  // Version history is stored in the note's own (plaintext) storage
  // form — keeping it would defeat the seal. Locking purges it, and no
  // new snapshots are taken while the note stays locked (versions.ts).
  await clearVersions(db, noteId);

  // The semantic-search vector is likewise derived from the plaintext:
  // it must not survive the seal at rest. This write is direct (not
  // updateNote), so the save hook never sees it — delete the vector
  // here, locally, with no provider call (semantic.ts).
  await invalidateNoteVector(db, noteId);

  const updated = await db.notes.get(noteId);
  if (!updated) throw new Error("Note not found after locking.");
  return updated;
}

/** Verifies one credential against the note's slots, enforcing lockout. */
export async function verifyNoteCredential(
  db: NomaDatabase,
  note: Note,
  method: NoteLockMethod,
  secret: string | number[],
): Promise<UnlockResult> {
  const lock = note.lock;
  if (!lock) return { ok: false, error: "This note is not locked." };

  const lockout = noteLockoutSeconds(lock);
  if (lockout > 0) {
    return {
      ok: false,
      error: `Too many attempts. Try again in ${lockout}s.`,
      lockoutSeconds: lockout,
    };
  }

  const slot = lock.slots[method];
  if (!slot) {
    return {
      ok: false,
      error: `${NOTE_LOCK_METHOD_LABEL[method]} isn't set up for this note.`,
    };
  }

  const nek = await unwrapNoteKey(slot, method, secret);
  if (nek) {
    await resetAttempts(db, note, lock);
    return { ok: true, nek };
  }

  const { attempts, lockoutSeconds } = await recordFailedAttempt(db, note, lock);
  if (lockoutSeconds > 0) {
    return {
      ok: false,
      error: `Incorrect ${NOTE_LOCK_METHOD_LABEL[method]}. Locked out for ${lockoutSeconds}s.`,
      lockoutSeconds,
    };
  }
  return {
    ok: false,
    error: `Incorrect ${NOTE_LOCK_METHOD_LABEL[method]}. ${5 - attempts} attempt${5 - attempts === 1 ? "" : "s"} left before lockout.`,
  };
}

/**
 * Releases the note key from the on-device fingerprint copy. Callers must
 * have completed a successful native biometric prompt first — this function
 * performs no authentication itself.
 */
export async function unlockNoteWithBiometricCopy(
  db: NomaDatabase,
  note: Note,
): Promise<UnlockResult> {
  const lock = note.lock;
  if (!lock?.biometric) {
    return { ok: false, error: "Fingerprint unlock isn't enabled for this note." };
  }
  const lockout = noteLockoutSeconds(lock);
  if (lockout > 0) {
    return {
      ok: false,
      error: `Too many attempts. Try again in ${lockout}s.`,
      lockoutSeconds: lockout,
    };
  }
  const nek = await readBiometricCopy(note.id);
  if (!nek) {
    return {
      ok: false,
      error:
        "Fingerprint unlock isn't available on this device for this note. Use your backup credential.",
    };
  }
  await resetAttempts(db, note, lock);
  return { ok: true, nek };
}

export interface UnlockedNoteData {
  /** Decrypted Tiptap HTML. */
  content: string;
  /** Decrypted attachment payloads by attachment id (encrypted ones only). */
  attachments: Map<string, string>;
}

/** Decrypts a locked note's body and attachments into memory for a session. */
export async function decryptNoteData(
  db: NomaDatabase,
  note: Note,
  nek: Uint8Array,
): Promise<UnlockedNoteData> {
  const content =
    note.content && isEncryptedContent(note.content)
      ? await decryptText(nek, note.content)
      : note.content;

  const attachments = new Map<string, string>();
  const rows = await db.attachments.where("noteId").equals(note.id).toArray();
  for (const attachment of rows) {
    if (attachment.encrypted && attachment.data) {
      attachments.set(attachment.id, await decryptText(nek, attachment.data));
    }
  }
  return { content, attachments };
}

/** Seals any still-plaintext attachments of a locked note (e.g. images added during an unlocked session). */
export async function encryptPlaintextAttachments(
  db: NomaDatabase,
  noteId: string,
  nek: Uint8Array,
): Promise<number> {
  const rows = await db.attachments.where("noteId").equals(noteId).toArray();
  let sealed = 0;
  for (const attachment of rows) {
    if (attachment.data && !attachment.encrypted) {
      await db.attachments.update(attachment.id, {
        data: await encryptText(nek, attachment.data),
        encrypted: true,
        updatedAt: Date.now(),
      });
      sealed++;
    }
  }
  return sealed;
}

/** Persists edits made during an unlocked session, re-sealing body + new attachments. */
export async function saveLockedNoteContent(
  db: NomaDatabase,
  note: Note,
  nek: Uint8Array,
  html: string,
): Promise<void> {
  await db.notes.update(note.id, {
    content: await encryptText(nek, html),
    wordCount: countWords(html),
    updatedAt: Date.now(),
  });
  await encryptPlaintextAttachments(db, note.id, nek);
  // The note stays locked and its content just changed under the seal:
  // no vector may exist for it (see lockNote).
  await invalidateNoteVector(db, note.id);
}

/** Permanently removes a note's lock, decrypting body and attachments back to plaintext. */
export async function removeNoteLock(
  db: NomaDatabase,
  noteId: string,
  nek: Uint8Array,
): Promise<void> {
  const note = await db.notes.get(noteId);
  if (!note?.lock) return;

  const data = await decryptNoteData(db, note, nek);
  const rows = await db.attachments.where("noteId").equals(noteId).toArray();
  for (const attachment of rows) {
    if (attachment.encrypted) {
      const plain = data.attachments.get(attachment.id);
      if (plain !== undefined) {
        await db.attachments.update(attachment.id, {
          data: plain,
          encrypted: false,
          updatedAt: Date.now(),
        });
      }
    }
  }
  removeBiometricCopy(noteId);
  await db.notes.update(noteId, {
    content: data.content,
    lock: null,
    wordCount: countWords(data.content),
    updatedAt: Date.now(),
  });

  // The note is plaintext and eligible again: refresh its vector the
  // same way the updateNote save hook does (a no-op unless a valid
  // index already exists — the user's Settings build was the opt-in).
  await maintainSemanticIndexForNote(db, noteId);
}

/** Adds or replaces one credential slot (used to change a note's credential). */
export async function setNoteLockSlot(
  db: NomaDatabase,
  note: Note,
  nek: Uint8Array,
  method: NoteLockMethod,
  secret: string | number[],
): Promise<void> {
  const lock = note.lock;
  if (!lock) throw new Error("This note is not locked.");
  const slot = await wrapNoteKey(nek, method, secret);
  await db.notes.update(note.id, {
    lock: { ...lock, slots: { ...lock.slots, [method]: slot } },
  });
  // The note remains locked — guarantee no vector sits at rest for it.
  await invalidateNoteVector(db, note.id);
}

/** Removes a credential slot. Refuses to remove the last one — a note must always keep a backup credential. */
export async function removeNoteLockSlot(
  db: NomaDatabase,
  note: Note,
  method: NoteLockMethod,
): Promise<boolean> {
  const lock = note.lock;
  if (!lock?.slots[method]) return false;
  if (Object.keys(lock.slots).length <= 1) return false;
  const slots = { ...lock.slots };
  delete slots[method];
  await db.notes.update(note.id, { lock: { ...lock, slots } });
  // The note remains locked — guarantee no vector sits at rest for it.
  await invalidateNoteVector(db, note.id);
  return true;
}

/** Enables/disables fingerprint unlock for a locked note (requires the session key). */
export async function setNoteLockBiometric(
  db: NomaDatabase,
  note: Note,
  nek: Uint8Array,
  enabled: boolean,
): Promise<boolean> {
  const lock = note.lock;
  if (!lock) return false;
  if (enabled) {
    const stored = await storeBiometricCopy(note.id, nek);
    if (!stored) return false;
    await db.notes.update(note.id, { lock: { ...lock, biometric: true } });
    return true;
  }
  removeBiometricCopy(note.id);
  await db.notes.update(note.id, { lock: { ...lock, biometric: false } });
  return true;
}

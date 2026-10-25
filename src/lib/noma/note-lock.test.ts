import { describe, expect, it } from "vitest";
import type { NomaDatabase } from "./db";
import {
  decryptNoteData,
  lockNote,
  removeNoteLock,
  verifyNoteCredential,
} from "./note-lock";
import {
  decryptText,
  encryptText,
  generateNoteKey,
  isEncryptedContent,
  unwrapNoteKey,
  wrapNoteKey,
} from "./note-lock-crypto";
import { notePreview } from "./notes";
import { searchNotes } from "./search";
import type { AttachmentMeta, Note, NoteEmbedding } from "./types";

/* ---------------- Minimal in-memory stand-ins for the Dexie tables ---------------- */

class FakeTable<T extends { id: string }> {
  rows = new Map<string, T>();
  async get(id: string): Promise<T | undefined> {
    return this.rows.get(id);
  }
  async put(row: T): Promise<string> {
    this.rows.set(row.id, row);
    return row.id;
  }
  async update(id: string, patch: Partial<T>): Promise<number> {
    const row = this.rows.get(id);
    if (!row) return 0;
    Object.assign(row, patch);
    return 1;
  }
  where(field: string) {
    return {
      equals: (value: unknown) => ({
        toArray: async () =>
          [...this.rows.values()].filter(
            (r) => (r as unknown as Record<string, unknown>)[field] === value,
          ),
      }),
    };
  }
}

/** Stand-in for the v5 noteEmbeddings table (keyed by noteId, not id). */
class FakeEmbeddingTable {
  rows = new Map<string, NoteEmbedding>();
  async get(noteId: string): Promise<NoteEmbedding | undefined> {
    return this.rows.get(noteId);
  }
  async put(row: NoteEmbedding): Promise<string> {
    this.rows.set(row.noteId, row);
    return row.noteId;
  }
  async delete(noteId: string): Promise<void> {
    this.rows.delete(noteId);
  }
  async toArray(): Promise<NoteEmbedding[]> {
    return [...this.rows.values()];
  }
  async count(): Promise<number> {
    return this.rows.size;
  }
}

function makeDb() {
  const notes = new FakeTable<Note>();
  const attachments = new FakeTable<AttachmentMeta>();
  const noteEmbeddings = new FakeEmbeddingTable();
  return {
    notes,
    attachments,
    noteEmbeddings,
    db: { notes, attachments, noteEmbeddings } as unknown as NomaDatabase,
  };
}

function makeNote(patch: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    title: "Bank details",
    content: '<p>Account 12345678</p><img src="noma-attachment://att-1" />',
    contentFormat: "tiptap-html",
    createdAt: 1,
    updatedAt: 1,
    folderId: null,
    tagIds: [],
    pinned: false,
    favorite: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    reminderAt: null,
    wordCount: 2,
    ...patch,
  };
}

const ATTACHMENT: AttachmentMeta = {
  id: "att-1",
  noteId: "note-1",
  name: "card.png",
  mimeType: "image/png",
  size: 4,
  createdAt: 1,
  data: "data:image/png;base64,AAAA",
};

/* ---------------- Envelope primitives ---------------- */

describe("note-lock envelope", () => {
  it("round-trips text and detects envelopes", async () => {
    const key = generateNoteKey();
    const envelope = await encryptText(key, "<p>secret</p>");
    expect(isEncryptedContent(envelope)).toBe(true);
    expect(isEncryptedContent("<p>secret</p>")).toBe(false);
    await expect(decryptText(key, envelope)).resolves.toBe("<p>secret</p>");
  });

  it("rejects decryption with a different key", async () => {
    const envelope = await encryptText(generateNoteKey(), "secret");
    await expect(decryptText(generateNoteKey(), envelope)).rejects.toThrow();
  });
});

/* ---------------- Credential slots ---------------- */

describe("note-lock credential slots", () => {
  it("every method unwraps the same note key; wrong secrets fail", async () => {
    const nek = generateNoteKey();
    const passwordSlot = await wrapNoteKey(nek, "password", "correct horse battery");
    const pinSlot = await wrapNoteKey(nek, "pin", "135790");
    const patternSlot = await wrapNoteKey(nek, "pattern", [0, 1, 2, 5]);

    await expect(unwrapNoteKey(passwordSlot, "password", "correct horse battery")).resolves.toEqual(nek);
    await expect(unwrapNoteKey(pinSlot, "pin", "135790")).resolves.toEqual(nek);
    await expect(unwrapNoteKey(patternSlot, "pattern", [0, 1, 2, 5])).resolves.toEqual(nek);

    await expect(unwrapNoteKey(passwordSlot, "password", "wrong password")).resolves.toBeNull();
    await expect(unwrapNoteKey(pinSlot, "pin", "000000")).resolves.toBeNull();
    await expect(unwrapNoteKey(patternSlot, "pattern", [0, 4, 8])).resolves.toBeNull();
  });
});

/* ---------------- Full lock / unlock / remove flow ---------------- */

describe("note lock lifecycle", () => {
  it("locks content + attachments, stays title-only, unlocks, and removes cleanly", async () => {
    const { db, notes, attachments } = makeDb();
    const note = makeNote();
    const originalContent = note.content;
    await notes.put(note);
    await attachments.put({ ...ATTACHMENT });

    const locked = await lockNote(db, note.id, "pin", "135790");
    expect(locked.lock).toBeTruthy();
    expect(isEncryptedContent(locked.content)).toBe(true);
    expect(locked.content).not.toContain("12345678");

    const sealedAttachment = await attachments.get("att-1");
    expect(sealedAttachment?.encrypted).toBe(true);
    expect(isEncryptedContent(sealedAttachment?.data ?? "")).toBe(true);

    // Title-only surfaces: no preview text, body not searchable, title is.
    expect(notePreview(locked)).toBe("");
    const byTitle = searchNotes("bank", [locked], [], []);
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0]?.snippet).toBe("");
    expect(searchNotes("account", [locked], [], [])).toHaveLength(0);

    // Wrong credential is rejected.
    const wrong = await verifyNoteCredential(db, locked, "pin", "000000");
    expect(wrong.ok).toBe(false);

    // Right credential unlocks the original data.
    const right = await verifyNoteCredential(db, locked, "pin", "135790");
    expect(right.ok).toBe(true);
    if (!right.ok) throw new Error("unlock failed");
    const data = await decryptNoteData(db, locked, right.nek);
    expect(data.content).toBe(originalContent);
    expect(data.attachments.get("att-1")).toBe(ATTACHMENT.data);

    // Removing the lock restores plaintext storage.
    await removeNoteLock(db, note.id, right.nek);
    const restored = await notes.get(note.id);
    expect(restored?.lock).toBeNull();
    expect(restored?.content).toBe(originalContent);
    const restoredAttachment = await attachments.get("att-1");
    expect(restoredAttachment?.encrypted).toBe(false);
    expect(restoredAttachment?.data).toBe(ATTACHMENT.data);
  });

  it("enforces lockout after 5 failed attempts, even for the right credential", async () => {
    const { db, notes } = makeDb();
    const note = makeNote({ id: "note-lockout", content: "<p>x</p>" });
    await notes.put(note);
    const locked = await lockNote(db, note.id, "pattern", [0, 1, 2, 5]);

    let current = locked;
    for (let i = 0; i < 5; i++) {
      const res = await verifyNoteCredential(db, current, "pattern", [0, 4, 8]);
      expect(res.ok).toBe(false);
      current = (await notes.get(note.id))!;
    }
    expect(current.lock?.failedAttempts).toBe(5);
    expect(current.lock?.lockoutUntil).toBeGreaterThan(Date.now());

    const duringLockout = await verifyNoteCredential(db, current, "pattern", [0, 1, 2, 5]);
    expect(duringLockout.ok).toBe(false);
    if (!duringLockout.ok) expect(duringLockout.lockoutSeconds).toBeGreaterThan(0);
  });

  it("duplicate-protection: a locked note cannot be verified with an unset method", async () => {
    const { db, notes } = makeDb();
    const note = makeNote({ id: "note-methods", content: "<p>x</p>" });
    await notes.put(note);
    const locked = await lockNote(db, note.id, "password", "a long password");
    const res = await verifyNoteCredential(db, locked, "pin", "123456");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("isn't set up");
  });
});

/* ---------------- Semantic vector maintenance (#8.5) ----------------
 * Locking writes db.notes directly, bypassing updateNote's save hook,
 * so note-lock itself owns the semantic invariant: a locked note never
 * keeps a plaintext-derived vector at rest. */

describe("note-lock semantic vectors", () => {
  const VECTOR_ROW: NoteEmbedding = {
    noteId: "note-1",
    providerKey: "gemini|native|gemini-embedding-001|2",
    dims: 2,
    vector: new Float32Array([1, 0]),
    contentHash: "abc123",
    updatedAt: 1,
  };

  it("lockNote deletes the note's stored vector — nothing plaintext-derived survives the seal", async () => {
    const { db, notes, attachments, noteEmbeddings } = makeDb();
    await notes.put(makeNote());
    await attachments.put(ATTACHMENT);
    await noteEmbeddings.put(VECTOR_ROW);
    expect(await noteEmbeddings.count()).toBe(1);

    const locked = await lockNote(db, "note-1", "pin", "135790");
    expect(locked.lock).not.toBeNull();
    expect(isEncryptedContent(locked.content)).toBe(true);
    expect(await noteEmbeddings.get("note-1")).toBeUndefined();
  });

  it("removeNoteLock leaves no stale vector behind", async () => {
    const { db, notes, noteEmbeddings } = makeDb();
    await notes.put(makeNote());
    await noteEmbeddings.put(VECTOR_ROW);
    const locked = await lockNote(db, "note-1", "pin", "135790");
    expect(await noteEmbeddings.count()).toBe(0);

    const right = await verifyNoteCredential(db, locked, "pin", "135790");
    if (!right.ok) throw new Error("expected the PIN to verify");
    await removeNoteLock(db, "note-1", right.nek);
    // This fake db carries no account name, so maintenance cannot
    // re-embed here — the guarantee under test is that nothing stale
    // survives: the row deleted at lock time stays gone.
    expect(await noteEmbeddings.get("note-1")).toBeUndefined();
    expect((await notes.get("note-1"))?.lock).toBeNull();
  });
});

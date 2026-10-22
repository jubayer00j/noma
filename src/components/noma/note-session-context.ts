import { createContext, useContext } from "react";

/**
 * Decrypted attachment payloads (attachment id → data URL) for the locked
 * note currently open in an unlocked session. Attachment rows of a locked
 * note store ciphertext in IndexedDB, so the read view and the editor
 * resolve image data from this in-memory map instead. Null when no locked
 * note is open (ordinary notes resolve straight from IndexedDB).
 */
export const NoteSessionAttachmentsContext = createContext<Map<string, string> | null>(null);

export function useNoteSessionAttachments(): Map<string, string> | null {
  return useContext(NoteSessionAttachmentsContext);
}

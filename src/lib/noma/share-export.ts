import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { exportBackupAndroid } from "./android-backup";
import { downloadBlob } from "./backup";
import type { NoteExportArtifact } from "./note-export";

/**
 * Delivery for per-note export files (see note-export.ts): hand a built
 * file to the platform share sheet, or save it where the user picks.
 *
 * Native: the file is written to the app cache and shared via Capacitor
 * Share; saving reuses the backup export's SAF plumbing
 * (exportBackupAndroid), which streams any Blob to a user-picked
 * location — no separate save plugin needed.
 *
 * Web/PWA: saving is a plain Blob download (downloadBlob, as backups
 * do); sharing uses the Web Share API with a real File, and only when
 * the browser says it can share files — there is no text-only fallback,
 * because sharing a note's text is not sharing the note file.
 */

function exportBlob(file: NoteExportArtifact): Blob {
  return new Blob([file.content], { type: `${file.mimeType};charset=utf-8` });
}

/** True when "Share…" can actually hand over a file on this platform. */
export function canShareExportFile(): boolean {
  if (Capacitor.isNativePlatform()) return true;
  if (typeof navigator === "undefined" || !navigator.share || !navigator.canShare) return false;
  try {
    const probe = new File(["noma"], "noma.txt", { type: "text/plain" });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/** True when a share failure is just the user backing out of the sheet. */
export function isShareCancelled(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && /cancel/i.test(error.message);
}

/** Opens the platform share sheet with the export file attached. */
export async function shareExportFile(file: NoteExportArtifact): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { uri } = await Filesystem.writeFile({
      path: file.fileName,
      data: file.content,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    });
    await Share.share({ title: file.fileName, files: [uri], dialogTitle: "Share note" });
    return;
  }
  const blob = exportBlob(file);
  const webFile = new File([blob], file.fileName, { type: blob.type });
  await navigator.share({ files: [webFile], title: file.fileName });
}

export interface SaveExportResult {
  saved: boolean;
  /** Display path of the saved file (native SAF saves only). */
  fullDisplayPath?: string;
}

/** Saves the export file: SAF picker on native, download on web. */
export async function saveExportFile(file: NoteExportArtifact): Promise<SaveExportResult> {
  if (Capacitor.isNativePlatform()) {
    const result = await exportBackupAndroid(exportBlob(file), file.fileName);
    return { saved: result.saved, fullDisplayPath: result.fullDisplayPath };
  }
  downloadBlob(exportBlob(file), file.fileName);
  return { saved: true };
}

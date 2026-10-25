import { Download, Loader2, Share2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useDatabase } from "@/lib/noma/DatabaseContext";
import {
  buildNoteExport,
  collectAttachmentIds,
  exportFilename,
  type AttachmentResolver,
  type ExportFormat,
} from "@/lib/noma/note-export";
import { noteTitle } from "@/lib/noma/notes";
import {
  canShareExportFile,
  isShareCancelled,
  saveExportFile,
  shareExportFile,
} from "@/lib/noma/share-export";
import type { Note } from "@/lib/noma/types";

interface NoteExportDialogProps {
  note: Note;
  /**
   * Decrypted attachment payloads when the note is a locked note open in
   * an unlocked session; its attachment rows hold ciphertext, so image
   * data comes from this map (the same rule the Read View follows).
   * Null for ordinary notes, which resolve straight from IndexedDB.
   */
  sessionAttachments: Map<string, string> | null;
  onClose: () => void;
}

const FORMAT_OPTIONS: { value: ExportFormat; label: string; hint: string }[] = [
  {
    value: "html",
    label: "HTML",
    hint: "Looks like the note, images included. Opens in any browser.",
  },
  {
    value: "markdown",
    label: "Markdown",
    hint: "For other notes apps — and Noma can import it back.",
  },
  { value: "text", label: "Plain text", hint: "Just the words. Works everywhere." },
];

/**
 * Share / Export for one note: pick a format, then share the file via
 * the platform share sheet or save it. The workspace only mounts this
 * dialog once the note is exportable — a locked note arrives already
 * unlocked in session, with decrypted content — so nothing here ever
 * touches ciphertext.
 */
export function NoteExportDialog({ note, sessionAttachments, onClose }: NoteExportDialogProps) {
  const { db } = useDatabase();
  const [format, setFormat] = useState<ExportFormat>("html");
  const [busy, setBusy] = useState<"share" | "save" | null>(null);
  const shareAvailable = useMemo(() => canShareExportFile(), []);
  const fileName = exportFilename(note, format);

  /** Pre-resolves every attachment the note references into a sync lookup. */
  const buildResolver = async (): Promise<AttachmentResolver> => {
    const resolved = new Map<string, string>();
    if (db) {
      await Promise.all(
        collectAttachmentIds(note.content).map(async (id) => {
          const att = await db.attachments.get(id);
          const data = att?.encrypted ? sessionAttachments?.get(id) : att?.data;
          if (data) resolved.set(id, data);
        }),
      );
    }
    return (id) => resolved.get(id) ?? null;
  };

  const run = async (kind: "share" | "save") => {
    if (busy) return;
    setBusy(kind);
    try {
      const resolver = await buildResolver();
      const file = buildNoteExport(note, format, resolver);
      if (kind === "share") {
        await shareExportFile(file);
        onClose();
      } else {
        const result = await saveExportFile(file);
        if (!result.saved) {
          toast.error("Couldn't save the file.");
        } else if (result.fullDisplayPath) {
          toast.success(`Saved to ${result.fullDisplayPath}`);
        } else {
          toast.success("Note downloaded");
        }
      }
    } catch (error) {
      // Backing out of the share sheet is not an error worth surfacing.
      if (kind === "share" && isShareCancelled(error)) return;
      toast.error(error instanceof Error ? error.message : "Export failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif">Share / Export</DialogTitle>
          <DialogDescription className="line-clamp-2">{noteTitle(note)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Label className="text-xs font-medium text-muted-foreground">Format</Label>
          <RadioGroup value={format} onValueChange={(value) => setFormat(value as ExportFormat)}>
            {FORMAT_OPTIONS.map((option) => (
              <div key={option.value} className="flex items-start gap-3">
                <RadioGroupItem value={option.value} id={`export-format-${option.value}`} />
                <div className="grid gap-0.5 leading-none">
                  <Label htmlFor={`export-format-${option.value}`} className="font-medium">
                    {option.label}
                  </Label>
                  <p className="text-xs text-muted-foreground">{option.hint}</p>
                </div>
              </div>
            ))}
          </RadioGroup>
          <p className="text-xs text-muted-foreground">
            File: <span className="font-medium text-foreground">{fileName}</span>
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => void run("save")} disabled={busy !== null}>
            {busy === "save" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Save file
          </Button>
          {shareAvailable && (
            <Button onClick={() => void run("share")} disabled={busy !== null}>
              {busy === "share" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Share2 className="size-4" />
              )}
              Share…
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

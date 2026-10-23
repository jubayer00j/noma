import { ArrowLeft, History, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
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
import { useDatabase } from "@/lib/noma/DatabaseContext";
import { noteTitle } from "@/lib/noma/notes";
import type { Note, NoteVersion } from "@/lib/noma/types";
import { clearVersions, listVersions } from "@/lib/noma/versions";
import { NoteReadContent } from "./note-read-content";

/** "23 Oct 2026, 4:12 pm" — the absolute stamp shown on each version row. */
function formatAbsolute(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

/** Compact relative stamp ("just now", "5 minutes ago", "3 days ago"). */
function formatRelative(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

interface VersionHistoryDialogProps {
  note: Note;
  onClose: () => void;
  /**
   * Restores a version, host-orchestrated: the workspace flushes any
   * pending editor autosave first (so the state restoreVersion
   * force-snapshots is the user's actual current text) and drops the
   * draft overlay afterwards. Resolves true on success.
   */
  onRestore: (versionId: string) => Promise<boolean>;
}

/**
 * Browses a note's earlier states (see versions.ts). List → preview →
 * restore, with restore itself undoable: the current text is kept as
 * the newest version before the older one is applied. History lives on
 * this device only — stated in the footer, per the v1 scope.
 */
export function VersionHistoryDialog({ note, onClose, onRestore }: VersionHistoryDialogProps) {
  const { db } = useDatabase();
  const [versions, setVersions] = useState<NoteVersion[] | null>(null);
  const [selected, setSelected] = useState<NoteVersion | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setVersions(null);
    setSelected(null);
    setConfirmingRestore(false);
    setConfirmingClear(false);
    if (!db) return;
    let cancelled = false;
    void listVersions(db, note.id).then((rows) => {
      if (!cancelled) setVersions(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [db, note.id]);

  const handleRestore = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const ok = await onRestore(selected.id);
      if (ok) {
        toast.success("Version restored");
        onClose();
      } else {
        toast.error("That version couldn't be restored.");
        setConfirmingRestore(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    if (!db) return;
    setBusy(true);
    try {
      await clearVersions(db, note.id);
      setVersions([]);
      setSelected(null);
      setConfirmingClear(false);
      toast.success("Version history cleared");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif text-lg">
            <History className="size-5 text-primary" />
            Version history
          </DialogTitle>
          <DialogDescription className="truncate">
            For note: <span className="font-medium text-foreground">“{noteTitle(note)}”</span>
          </DialogDescription>
        </DialogHeader>

        {selected ? (
          <div className="space-y-4 py-2">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setConfirmingRestore(false);
                }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="size-3.5" /> All versions
              </button>
              <span className="text-xs text-muted-foreground">
                {formatAbsolute(selected.createdAt)} · {formatRelative(selected.createdAt)}
              </span>
            </div>

            <div className="max-h-[50vh] overflow-y-auto rounded-md border p-4">
              <h3 className="mb-2 font-serif text-base font-semibold">
                {selected.title.trim() || "Untitled"}
              </h3>
              <NoteReadContent content={selected.content} />
            </div>

            {confirmingRestore ? (
              <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
                <p className="font-medium">Replace the current text with this version?</p>
                <p className="text-muted-foreground">
                  Your current text will be kept as the newest version, so this can be undone.
                </p>
                <div className="flex gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handleRestore()}
                    disabled={busy}
                  >
                    <RotateCcw className="size-3.5" /> {busy ? "Restoring…" : "Restore"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmingRestore(false)}
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex justify-end">
                <Button type="button" size="sm" onClick={() => setConfirmingRestore(true)}>
                  <RotateCcw className="size-4" /> Restore this version
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4 py-2">
            {versions === null ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
            ) : versions.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No earlier versions yet — versions appear as you edit, once a draft has had a moment
                to settle.
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {versions.map((version) => (
                  <li key={version.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(version)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {version.title.trim() || "Untitled"}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {formatAbsolute(version.createdAt)}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatRelative(version.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <DialogFooter className="flex-row items-center justify-between gap-3 sm:justify-between">
          <span className="text-xs text-muted-foreground">History is kept on this device.</span>
          {!selected && versions && versions.length > 0 ? (
            confirmingClear ? (
              <span className="flex items-center gap-2">
                <span className="text-xs font-medium text-destructive">Clear all versions?</span>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => void handleClear()}
                  disabled={busy}
                >
                  Clear
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmingClear(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => setConfirmingClear(true)}
              >
                <Trash2 className="size-4" /> Clear history
              </Button>
            )
          ) : (
            <div />
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

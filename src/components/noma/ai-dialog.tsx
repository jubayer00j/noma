import { Check, Copy, Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { cn } from "@/lib/utils";
import {
  AiError,
  getAiSettings,
  parseSummaryBlocks,
  suggestTags,
  summarizeNote,
  summaryTextToHtml,
  type SuggestTagsResult,
  type SummarizeResult,
} from "@/lib/noma/ai";
import type { NomaDatabase } from "@/lib/noma/db";
import { createTag, noteTitle, setNoteTags, updateNote } from "@/lib/noma/notes";
import { htmlToPlainText } from "@/lib/noma/sanitize";
import type { Note, Tag } from "@/lib/noma/types";

export type AiDialogMode = "summarize" | "tags";

interface AiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: AiDialogMode;
  note: Note;
  db: NomaDatabase;
  ownerId: string | null;
  allTags: Tag[];
}

type RunState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "summary"; result: SummarizeResult }
  | { kind: "tags"; result: SuggestTagsResult };

/**
 * The two opt-in AI actions (see ai.ts). One user tap → one call about
 * this one note → a result the user can apply or discard. A failed
 * call never mutates the note; model output is rendered as escaped
 * text (React children / summaryTextToHtml), never raw HTML.
 */
export function AiDialog({ open, onOpenChange, mode, note, db, ownerId, allTags }: AiDialogProps) {
  const [state, setState] = useState<RunState>({ kind: "loading" });
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const runKeyRef = useRef<string | null>(null);

  const currentTagNames = allTags
    .filter((tag) => note.tagIds.includes(tag.id))
    .map((tag) => tag.name);
  const libraryNames = new Set(allTags.map((tag) => tag.name.toLowerCase()));

  async function run() {
    setState({ kind: "loading" });
    setApplying(false);
    const settings = getAiSettings(ownerId);
    const apiKey = settings?.apiKey ?? "";
    try {
      // The predicate in the menu already excluded locked notes, so this
      // text extraction never sees ciphertext.
      const text = htmlToPlainText(note.content);
      if (mode === "summarize") {
        const result = await summarizeNote(apiKey, { title: noteTitle(note), text }, settings);
        setState({ kind: "summary", result });
      } else {
        const result = await suggestTags(
          apiKey,
          {
            title: noteTitle(note),
            text,
            existingTagNames: allTags.map((tag) => tag.name),
            currentTagNames,
          },
          settings,
        );
        setSelectedTags(new Set(result.tags));
        setState({ kind: "tags", result });
      }
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof AiError ? error.message : "Something went wrong. Try again.",
      });
    }
  }

  useEffect(() => {
    if (!open) {
      runKeyRef.current = null;
      return;
    }
    const key = `${note.id}:${mode}`;
    if (runKeyRef.current === key) return;
    runKeyRef.current = key;
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, note.id, mode]);

  async function insertSummary() {
    if (state.kind !== "summary" || applying) return;
    setApplying(true);
    try {
      const html = summaryTextToHtml(state.result.summary);
      await updateNote(db, note.id, { content: `${html}<hr>${note.content}` });
      toast.success("Summary added to the top of the note");
      onOpenChange(false);
    } catch {
      toast.error("The summary couldn't be added. Try again.");
      setApplying(false);
    }
  }

  async function copySummary() {
    if (state.kind !== "summary") return;
    try {
      await navigator.clipboard.writeText(state.result.summary);
      toast.success("Summary copied");
    } catch {
      toast.error("Copying didn't work on this device.");
    }
  }

  async function addSelectedTags() {
    if (state.kind !== "tags" || applying) return;
    const chosen = state.result.tags.filter((name) => selectedTags.has(name));
    if (chosen.length === 0) return;
    setApplying(true);
    try {
      const ids: string[] = [];
      for (const name of chosen) {
        const tag = await createTag(db, name);
        if (!note.tagIds.includes(tag.id) && !ids.includes(tag.id)) ids.push(tag.id);
      }
      if (ids.length) await setNoteTags(db, note.id, [...note.tagIds, ...ids]);
      toast.success(ids.length === 1 ? "Tag added" : `${ids.length} tags added`);
      onOpenChange(false);
    } catch {
      toast.error("The tags couldn't be added. Try again.");
      setApplying(false);
    }
  }

  function toggleTag(name: string) {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const title = mode === "summarize" ? "Summarize with AI" : "Suggest tags with AI";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-serif">
            <Sparkles className="size-4 text-primary" aria-hidden="true" /> {title}
          </DialogTitle>
          <DialogDescription>
            {mode === "summarize"
              ? "Gemini reads this note and drafts a short summary. Nothing is saved until you add it."
              : "Gemini suggests tags for this note, preferring ones already in your library."}
          </DialogDescription>
        </DialogHeader>

        {state.kind === "loading" && (
          <div className="flex items-center gap-2.5 py-6 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {mode === "summarize" ? "Summarizing with Gemini…" : "Thinking of tags…"}
          </div>
        )}

        {state.kind === "error" && (
          <>
            <p className="py-2 text-sm text-destructive" role="alert">
              {state.message}
            </p>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                type="button"
                onClick={() => {
                  runKeyRef.current = null;
                  void run();
                }}
              >
                Retry
              </Button>
            </DialogFooter>
          </>
        )}

        {state.kind === "summary" && (
          <>
            <div className="max-h-[50dvh] space-y-3 overflow-y-auto py-1 text-sm leading-relaxed">
              {parseSummaryBlocks(state.result.summary).map((block, index) =>
                block.type === "paragraph" ? (
                  <p key={index}>{block.text}</p>
                ) : (
                  <ul key={index} className="list-disc space-y-1 pl-5">
                    {block.items.map((item, itemIndex) => (
                      <li key={itemIndex}>{item}</li>
                    ))}
                  </ul>
                ),
              )}
              {state.result.truncated && (
                <p className="text-xs text-muted-foreground">
                  This is a long note — the middle was shortened for length before summarizing.
                </p>
              )}
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Discard
              </Button>
              <Button type="button" variant="outline" className="gap-2" onClick={() => void copySummary()}>
                <Copy className="size-4" aria-hidden="true" /> Copy
              </Button>
              <Button type="button" disabled={applying} onClick={() => void insertSummary()}>
                {applying && <Loader2 className="size-4 animate-spin" aria-hidden="true" />} Insert
                at top
              </Button>
            </DialogFooter>
          </>
        )}

        {state.kind === "tags" && (
          <>
            {state.result.tags.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                No new tags to suggest for this note.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 py-1">
                  {state.result.tags.map((name) => {
                    const selected = selectedTags.has(name);
                    const existing = libraryNames.has(name.toLowerCase());
                    return (
                      <button
                        key={name}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleTag(name)}
                        className={cn(
                          "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors",
                          selected
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {selected && <Check className="size-3.5" aria-hidden="true" />}#{name}
                        {existing && (
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            in library
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {state.result.truncated && (
                  <p className="text-xs text-muted-foreground">
                    This is a long note — the middle was shortened for length first.
                  </p>
                )}
              </>
            )}
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {state.result.tags.length === 0 ? "Close" : "Discard"}
              </Button>
              {state.result.tags.length > 0 && (
                <Button
                  type="button"
                  disabled={applying || selectedTags.size === 0}
                  onClick={() => void addSelectedTags()}
                >
                  {applying && <Loader2 className="size-4 animate-spin" aria-hidden="true" />} Add
                  selected
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

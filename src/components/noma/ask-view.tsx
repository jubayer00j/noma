import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "@tanstack/react-router";
import { Copy, Loader2, RotateCcw, Send, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AiError,
  askNotes,
  getAiEmbeddingTarget,
  getAiSettings,
  parseSummaryBlocks,
  type AiSettings,
} from "@/lib/noma/ai";
import { buildAskPrompt, retrieveChunks } from "@/lib/noma/ask";
import {
  askDisclosureLine,
  askIndexStale,
  askProviderName,
  askThreadReducer,
  citationSegments,
  deriveAskGate,
  initialAskThreadState,
  previousTurnOf,
  sourceCardsFor,
  type AskAnswerEntry,
  type AskGate,
} from "@/lib/noma/ask-view";
import type { NomaDatabase } from "@/lib/noma/db";
import { noteTitle } from "@/lib/noma/notes";
import {
  buildIndex,
  getIndexStatus,
  reconcileIndex,
  type IndexProgress,
  type SemanticIndexStatus,
} from "@/lib/noma/semantic";
import type { Note } from "@/lib/noma/types";

const tap =
  "transition-transform active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100";

export interface AskViewProps {
  db: NomaDatabase;
  ownerId: string | null;
  aiSettings: AiSettings | null;
  notes: Note[];
  /** True while the Ask surface is the visible one (vs. hidden under a note or the list). */
  active: boolean;
  /** A question carried over from the Search screen, consumed exactly once. */
  initialQuestion: string | null;
  onConsumeInitialQuestion: () => void;
  onOpenNote: (note: Note) => void;
}

/**
 * The Ask Noma screen (spec §4): grounded Q&A over the user's own notes.
 *
 * Everything testable about which state shows and how the thread evolves
 * lives in the pure helpers of lib/noma/ask-view.ts; this component wires
 * them to the PR-A index controls (the same buildIndex / reconcileIndex /
 * getIndexStatus the Settings screen uses) and the PR-B seams
 * (retrieveChunks → buildAskPrompt → askNotes, called exactly like the
 * AI dialog calls summarizeNote: fresh settings, (apiKey, input,
 * settings)). The thread lives in reducer state only — nothing is
 * persisted anywhere, and the workspace keeps this component mounted for
 * the session so leaving the view doesn't lose the conversation.
 */
export function AskView({
  db,
  ownerId,
  aiSettings,
  notes,
  active,
  initialQuestion,
  onConsumeInitialQuestion,
  onOpenNote,
}: AskViewProps) {
  const [thread, dispatch] = useReducer(askThreadReducer, initialAskThreadState);
  const [input, setInput] = useState("");
  const [indexStatus, setIndexStatus] = useState<SemanticIndexStatus | null>(null);
  const [indexBusy, setIndexBusy] = useState<"build" | "update" | null>(null);
  const [indexProgress, setIndexProgress] = useState<IndexProgress | null>(null);
  const [indexMessage, setIndexMessage] = useState<string | null>(null);
  const [pendingDisclosure, setPendingDisclosure] = useState<string | null>(null);
  const indexAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const askBusyRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingInitialRef = useRef<string | null>(null);

  const target = useMemo(() => getAiEmbeddingTarget(ownerId), [ownerId, aiSettings]);
  const gate = deriveAskGate({ settings: aiSettings, target, indexStatus });
  const staleNotice = gate === "ready" && askIndexStale(indexStatus);
  const notesById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  const providerName = askProviderName(aiSettings);
  const firstDisclosureId = thread.entries.find(
    (entry) => entry.kind === "answer" && entry.disclosure,
  )?.id;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const status = await getIndexStatus(db, getAiEmbeddingTarget(ownerId));
      if (mountedRef.current) setIndexStatus(status);
    } catch {
      if (mountedRef.current) setIndexStatus(null);
    }
  }, [db, ownerId, aiSettings]);

  // Load the index status when the surface appears (and re-derive it when
  // the saved AI settings change): notes may have been edited while a
  // source note sat open above this view.
  useEffect(() => {
    if (active) void refreshStatus();
  }, [active, refreshStatus]);

  /* ---------------- Index build / update (same controls as Settings) ---------------- */

  async function runBuildIndex() {
    if (indexBusy) return;
    const liveTarget = getAiEmbeddingTarget(ownerId);
    if (!liveTarget) return;
    const controller = new AbortController();
    indexAbortRef.current = controller;
    setIndexBusy("build");
    setIndexMessage(null);
    setIndexProgress({ done: 0, total: 0 });
    try {
      const { indexed } = await buildIndex(db, liveTarget, {
        signal: controller.signal,
        onProgress: setIndexProgress,
      });
      if (!mountedRef.current) return;
      setIndexMessage(
        indexed > 0
          ? `Index built — ${indexed} note${indexed === 1 ? "" : "s"} indexed. Ask away.`
          : "No notes to index yet.",
      );
    } catch (err) {
      if (!mountedRef.current) return;
      setIndexMessage(
        (err as Error | null)?.name === "AbortError"
          ? "Build cancelled — Update can finish it later."
          : err instanceof AiError
            ? err.message
            : "Something went wrong. Try again.",
      );
    } finally {
      indexAbortRef.current = null;
      if (mountedRef.current) {
        setIndexBusy(null);
        setIndexProgress(null);
      }
      await refreshStatus();
    }
  }

  async function runUpdateIndex() {
    if (indexBusy) return;
    const liveTarget = getAiEmbeddingTarget(ownerId);
    if (!liveTarget) return;
    setIndexBusy("update");
    setIndexMessage(null);
    try {
      const result = await reconcileIndex(db, liveTarget);
      if (!mountedRef.current) return;
      setIndexMessage(
        result.embedded === 0 && result.deleted === 0
          ? "Index is up to date."
          : `Index updated — ${result.embedded} embedded, ${result.deleted} removed.`,
      );
    } catch (err) {
      if (!mountedRef.current) return;
      setIndexMessage(err instanceof AiError ? err.message : "Something went wrong. Try again.");
    } finally {
      if (mountedRef.current) setIndexBusy(null);
      await refreshStatus();
    }
  }

  /* ---------------- Ask flow ---------------- */

  const runAsk = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!question || askBusyRef.current) return;
      // Fresh settings at call time, exactly like the AI dialog: the
      // saved record is the truth, not a possibly-stale render prop.
      const settings = getAiSettings(ownerId);
      const liveTarget = getAiEmbeddingTarget(ownerId);
      if (!settings || !liveTarget) return;
      askBusyRef.current = true;
      pendingInitialRef.current = null;
      const previousTurn = previousTurnOf(thread.entries);
      dispatch({ type: "submitted", question });
      setInput("");
      setPendingDisclosure(null);
      let disclosure: string | null = null;
      try {
        const excerpts = await retrieveChunks(db, question, liveTarget, notesById);
        if (!mountedRef.current) return;
        if (excerpts.length === 0) {
          // Nothing eligible cleared the floor — no provider call is
          // spent (askNotes would refuse to make one too).
          dispatch({
            type: "answered",
            entry: {
              status: "no-evidence",
              text: "",
              citations: [],
              sentExcerpts: [],
              disclosure: null,
              errorMessage: null,
            },
          });
          return;
        }
        // The exact excerpts the prompt will carry — askNotes rebuilds
        // the same list deterministically from the same inputs, so the
        // disclosure and the source cards describe the real prompt.
        const { excerpts: sent } = buildAskPrompt(question, excerpts, previousTurn);
        disclosure = askDisclosureLine(sent, askProviderName(settings));
        setPendingDisclosure(disclosure);
        const result = await askNotes(
          settings.apiKey ?? "",
          { question, excerpts, ...(previousTurn ? { previousTurn } : {}) },
          settings,
        );
        if (!mountedRef.current) return;
        if (result.status === "answer") {
          dispatch({
            type: "answered",
            entry: {
              status: "answer",
              text: result.text,
              citations: result.citations,
              sentExcerpts: sent,
              disclosure,
              errorMessage: null,
            },
          });
        } else if (result.status === "refusal") {
          dispatch({
            type: "answered",
            entry: {
              status: "refusal",
              text: "",
              citations: [],
              sentExcerpts: sent,
              disclosure,
              errorMessage: null,
            },
          });
        } else {
          dispatch({
            type: "answered",
            entry: {
              status: "no-evidence",
              text: "",
              citations: [],
              sentExcerpts: [],
              disclosure: null,
              errorMessage: null,
            },
          });
        }
      } catch (error) {
        if (!mountedRef.current) return;
        dispatch({
          type: "answered",
          entry: {
            status: "error",
            text: "",
            citations: [],
            sentExcerpts: [],
            disclosure,
            errorMessage:
              error instanceof AiError ? error.message : "Something went wrong. Try again.",
          },
        });
      } finally {
        askBusyRef.current = false;
        if (mountedRef.current) setPendingDisclosure(null);
      }
    },
    [db, notesById, ownerId, thread.entries],
  );

  /* ---------------- Search carry-over ---------------- */

  useEffect(() => {
    if (!initialQuestion) return;
    pendingInitialRef.current = initialQuestion;
    setInput(initialQuestion);
    onConsumeInitialQuestion();
  }, [initialQuestion, onConsumeInitialQuestion]);

  // Ask the carried question as soon as the thread can take it; if a
  // gate is in the way the text simply waits in the input, and one tap
  // on Build/Update (which flips the gate to ready) lets it through.
  useEffect(() => {
    const pending = pendingInitialRef.current;
    if (pending && active && gate === "ready" && !thread.busy && thread.entries.length === 0) {
      void runAsk(pending);
    }
  }, [active, gate, runAsk, thread.busy, thread.entries.length]);

  /* ---------------- Scroll ---------------- */

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.entries, thread.busy, pendingDisclosure]);

  /* ---------------- Render helpers ---------------- */

  const openCitation = (noteId: string) => {
    const note = notesById.get(noteId);
    if (note) onOpenNote(note);
  };

  const settingsButton = (
    <Button asChild className={`h-11 ${tap}`}>
      <Link to="/settings">Open AI settings</Link>
    </Button>
  );

  const indexControls = (mode: "build" | "update") => (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          className={`h-11 ${tap}`}
          disabled={indexBusy !== null}
          onClick={() => void (mode === "build" ? runBuildIndex() : runUpdateIndex())}
        >
          {indexBusy === mode && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}{" "}
          {mode === "build"
            ? gate === "needs-rebuild"
              ? "Rebuild index"
              : "Build index"
            : "Update index"}
        </Button>
        {indexBusy === "build" && (
          <Button
            variant="outline"
            className={`h-11 ${tap}`}
            onClick={() => indexAbortRef.current?.abort()}
          >
            Cancel
          </Button>
        )}
      </div>
      {indexBusy === "build" && indexProgress && indexProgress.total > 0 && (
        <p className="text-xs text-muted-foreground" role="status">
          Indexing {indexProgress.done} of {indexProgress.total}…
        </p>
      )}
      {indexMessage && (
        <p className="text-sm text-muted-foreground" role="status">
          {indexMessage}
        </p>
      )}
    </div>
  );

  const gateCard = (title: string, body: ReactNode, actions?: ReactNode) => (
    <div className="rounded-2xl border border-border bg-card p-5 shadow-xs">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-primary" aria-hidden="true" />
        <h2 className="font-serif text-base font-medium text-card-foreground">{title}</h2>
      </div>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-muted-foreground">
        <p>{body}</p>
        {actions}
      </div>
    </div>
  );

  const renderGate = (current: AskGate) => {
    switch (current) {
      case "loading":
        return (
          <p className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Checking your index…
          </p>
        );
      case "ai-off":
        return gateCard(
          "Ask Noma",
          "Ask questions about your notes and get answers grounded in them, with sources you can open. Ask Noma runs on your own AI key — Noma has no server and sees nothing.",
          settingsButton,
        );
      case "no-embeddings":
        return gateCard(
          "Ask Noma",
          `Ask Noma isn't available with ${providerName} — it has no embeddings service. Switch to a provider with embeddings to use it.`,
          settingsButton,
        );
      case "needs-embedding-model":
        return gateCard(
          "Ask Noma",
          `${providerName} has no default embedding model, and Ask Noma needs one to find the right passages. Add an embedding model in AI settings to switch Ask on.`,
          settingsButton,
        );
      case "needs-index":
        return gateCard(
          "Ask needs your semantic index",
          `Building one sends each note's text to ${providerName} under your key — once per note, and again in small overlapping chunks so Ask can cite the exact passage it used — and keeps the index on this device only. Locked notes are never indexed.`,
          indexControls("build"),
        );
      case "needs-rebuild":
        return gateCard(
          "Ask needs your semantic index",
          `The index on this device was built with ${indexStatus?.embeddingModel ?? "a different embedding model"} — rebuild it to ask with the current provider.`,
          indexControls("build"),
        );
      case "chunks-pending":
        return gateCard(
          "Ask needs your semantic index",
          "Your search index predates Ask Noma's passage index. One update adds the passages Ask cites — notes whose vectors still match aren't re-embedded, so it only does the missing work.",
          indexControls("update"),
        );
      case "ready":
        return null;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="noma-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 sm:px-6 sm:py-6">
          {gate !== "ready" ? (
            renderGate(gate)
          ) : (
            <>
              {staleNotice && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-accent/50 px-3.5 py-2.5 text-xs text-muted-foreground">
                    <span>Index is behind — answers may miss your latest edits.</span>
                    <button
                      type="button"
                      className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-50"
                      disabled={indexBusy !== null}
                      onClick={() => void runUpdateIndex()}
                    >
                      {indexBusy === "update" ? "Updating…" : "Update"}
                    </button>
                  </div>
                  {indexMessage && (
                    <p className="px-1 text-xs text-muted-foreground" role="status">
                      {indexMessage}
                    </p>
                  )}
                </div>
              )}

              {thread.entries.length === 0 && !thread.busy && (
                <p className="px-1 pt-6 text-center text-sm leading-relaxed text-muted-foreground">
                  Ask anything about your notes. Answers come only from what's in them — and every
                  answer shows the passages it used.
                </p>
              )}

              {thread.entries.map((entry) =>
                entry.kind === "question" ? (
                  <div key={entry.id} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-primary-foreground">
                      {entry.text}
                    </div>
                  </div>
                ) : (
                  <AnswerEntryView
                    key={entry.id}
                    entry={entry}
                    notesById={notesById}
                    onOpenNote={onOpenNote}
                    showDisclosure={entry.id === firstDisclosureId}
                  />
                ),
              )}

              {thread.busy && (
                <div className="rounded-2xl border border-border bg-card p-4 shadow-xs">
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Reading your
                    notes…
                  </p>
                  {pendingDisclosure && (
                    <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                      {pendingDisclosure}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {gate === "ready" && (
        <div className="shrink-0 border-t border-border px-4 pt-3 pb-safe sm:px-6">
          <div className="mx-auto w-full max-w-3xl">
            {thread.entries.length > 0 && (
              <div className="mb-2 flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-xs text-muted-foreground"
                  disabled={thread.busy}
                  onClick={() => dispatch({ type: "cleared" })}
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" /> New chat
                </Button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (!thread.busy && input.trim()) void runAsk(input);
                  }
                }}
                placeholder="Ask your notes…"
                aria-label="Ask your notes"
                rows={1}
                autoFocus={active}
                className="max-h-36 min-h-11 flex-1 resize-none py-2.5"
              />
              <Button
                className={`h-11 shrink-0 gap-1.5 ${tap}`}
                disabled={thread.busy || !input.trim()}
                onClick={() => void runAsk(input)}
              >
                {thread.busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="size-4" aria-hidden="true" />
                )}
                Ask
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- One answer entry ---------------- */

function AnswerEntryView({
  entry,
  notesById,
  onOpenNote,
  showDisclosure,
}: {
  entry: AskAnswerEntry;
  notesById: ReadonlyMap<string, Note>;
  onOpenNote: (note: Note) => void;
  showDisclosure: boolean;
}) {
  const disclosureLine =
    showDisclosure && entry.disclosure ? (
      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">{entry.disclosure}</p>
    ) : null;

  if (entry.status === "error") {
    return (
      <div className="space-y-2">
        <div
          role="alert"
          className="rounded-2xl border border-destructive/40 bg-destructive/5 p-4 text-sm leading-relaxed text-destructive"
        >
          {entry.errorMessage}
        </div>
        {disclosureLine}
      </div>
    );
  }

  if (entry.status === "refusal" || entry.status === "no-evidence") {
    // The UI's own honest empty states — never the model's wording
    // dressed up as an answer. A refusal made a real provider call, so
    // its disclosure still shows; no-evidence spent nothing and has none.
    const refusal = entry.status === "refusal";
    return (
      <div className="space-y-2">
        <div className="rounded-2xl border border-dashed border-border bg-muted/40 p-4">
          <p className="text-sm font-medium text-foreground">
            {refusal ? "Not in your notes" : "No matching passages"}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {refusal
              ? "Ask Noma couldn't ground an answer to that in your notes. Try different words, or a more specific question."
              : "Nothing in your notes is close enough to that question to ground an answer, so no answer was generated."}
          </p>
        </div>
        {disclosureLine}
      </div>
    );
  }

  const cards = sourceCardsFor(entry.sentExcerpts, entry.citations);
  const renderSegments = (text: string) =>
    citationSegments(text, entry.citations).map((segment, index) =>
      segment.kind === "text" ? (
        <span key={index}>{segment.text}</span>
      ) : (
        <button
          key={index}
          type="button"
          aria-label={`Open source ${segment.n}`}
          onClick={() => {
            const note = notesById.get(segment.noteId);
            if (note) onOpenNote(note);
          }}
          className="mx-0.5 inline-flex size-5 items-center justify-center rounded-full bg-accent align-middle text-[11px] font-semibold text-accent-foreground transition-colors hover:bg-primary hover:text-primary-foreground"
        >
          {segment.n}
        </button>
      ),
    );

  const copyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(entry.text);
      toast.success("Answer copied");
    } catch {
      toast.error("Copying didn't work on this device.");
    }
  };

  return (
    <div className="space-y-2">
      <div className="rounded-2xl border border-border bg-card p-4 shadow-xs">
        <div className="space-y-2.5">
          {parseSummaryBlocks(entry.text).map((block, index) =>
            block.type === "paragraph" ? (
              <p key={index} className="text-sm leading-relaxed text-card-foreground">
                {renderSegments(block.text)}
              </p>
            ) : (
              <ul
                key={index}
                className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-card-foreground"
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderSegments(item)}</li>
                ))}
              </ul>
            ),
          )}
        </div>

        {cards.length > 0 && (
          <div className="mt-3.5 space-y-1.5 border-t border-border pt-3">
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              Sources
            </p>
            {cards.map((card) => {
              const note = notesById.get(card.noteId);
              const inner = (
                <>
                  <span className="block truncate font-serif text-sm font-medium text-foreground">
                    {note ? noteTitle(note) : card.title}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
                    {card.text}
                  </span>
                </>
              );
              return note ? (
                <button
                  key={`${card.noteId}#${card.chunkIndex}`}
                  type="button"
                  onClick={() => onOpenNote(note)}
                  className={`block w-full rounded-xl border border-border bg-background px-3 py-2.5 text-left transition-colors hover:bg-accent/60 ${tap}`}
                >
                  {inner}
                </button>
              ) : (
                <div
                  key={`${card.noteId}#${card.chunkIndex}`}
                  className="block w-full rounded-xl border border-border bg-background px-3 py-2.5 opacity-60"
                >
                  {inner}
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-2 flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs text-muted-foreground"
            onClick={() => void copyAnswer()}
          >
            <Copy className="size-3.5" aria-hidden="true" /> Copy answer
          </Button>
        </div>
      </div>
      {disclosureLine}
    </div>
  );
}

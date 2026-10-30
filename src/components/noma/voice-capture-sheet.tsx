import { Loader2, Mic } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { plainTextToNoteHtml } from "@/lib/noma/capture";
import {
  createSpeechSession,
  defaultSpeechEngine,
  resolveSpeechLanguageTag,
  segmentsToParagraphs,
  voiceNoteTitle,
  type SpeechErrorKind,
  type SpeechSession,
  type SpeechSessionSnapshot,
} from "@/lib/noma/speech";
import type { SpeechLanguageSetting } from "@/lib/noma/types";
import { cn } from "@/lib/utils";

/**
 * Voice quick capture (voice capture PR-C): the listening sheet every
 * voice door opens — the QS tile, the launcher shortcut, the PWA
 * shortcut and the sidebar's Voice note button all land here, under
 * the workspace's DB-ready + unlocked gate (shortcut.ts). Speak, tap
 * Done, and the transcript becomes a note: one paragraph per spoken
 * segment, titled by its first segment. Nothing is written before
 * Done — Cancel discards the whole session, and an empty session
 * creates no note, offering Retry or Type instead.
 *
 * The sheet owns one PR-A speech session per opening; closing the
 * sheet (any path) cancels it, so a dismissed sheet can never leave a
 * recogniser running behind the app.
 */

const ERROR_LINES: Partial<Record<SpeechErrorKind, string>> = {
  permission: "Microphone access was denied — you can allow it in your device settings.",
  network: "The speech service needs a connection on this device.",
  unavailable: "Voice capture isn't available on this device.",
  "no-speech": "Didn't catch that.",
};

interface VoiceCaptureSheetProps {
  open: boolean;
  speechLanguage: SpeechLanguageSetting;
  onOpenChange: (open: boolean) => void;
  /** Persist the finished voice note (the workspace creates + opens it). */
  onSave: (title: string, contentHtml: string) => void;
  /** Give up on voice here: close and open a blank note in the editor. */
  onTypeInstead: () => void;
}

function formatElapsed(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function VoiceCaptureSheet({
  open,
  speechLanguage,
  onOpenChange,
  onSave,
  onTypeInstead,
}: VoiceCaptureSheetProps) {
  const [availability, setAvailability] = useState<"checking" | "ok" | "unavailable">("checking");
  const [blockedApp, setBlockedApp] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SpeechSessionSnapshot | null>(null);
  const [pendingSave, setPendingSave] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [emptyNotice, setEmptyNotice] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const sessionRef = useRef<SpeechSession | null>(null);
  const submittedRef = useRef(false);
  const listeningSinceRef = useRef<number | null>(null);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  /* One session per opening: probe, subscribe, auto-start listening. */
  useEffect(() => {
    if (!open) return;
    setAvailability("checking");
    setBlockedApp(null);
    setSnapshot(null);
    setPendingSave(false);
    setSubmitted(false);
    submittedRef.current = false;
    setEmptyNotice(false);
    setElapsed(0);
    listeningSinceRef.current = null;

    const engine = defaultSpeechEngine();
    if (!engine) {
      setAvailability("unavailable");
      return;
    }
    const session = createSpeechSession(engine);
    sessionRef.current = session;
    const unsubscribe = session.subscribe(setSnapshot);
    let live = true;
    engine
      .probe()
      .then((probe) => {
        if (!live) return;
        if (!probe.available) {
          if (probe.reason === "service-disabled") setBlockedApp(probe.serviceApp ?? "");
          setAvailability("unavailable");
          return;
        }
        setAvailability("ok");
        void session.start(resolveSpeechLanguageTag(speechLanguage, navigator.language));
      })
      .catch(() => {
        if (live) setAvailability("unavailable");
      });
    return () => {
      live = false;
      unsubscribe();
      session.cancel();
      sessionRef.current = null;
    };
    // speechLanguage is read at open time; a mid-session settings
    // change applies to the next opening, never restarts this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* Elapsed timer: runs while the session is live. */
  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.state === "listening" && listeningSinceRef.current === null) {
      listeningSinceRef.current = Date.now();
    }
    if (snapshot.state !== "listening" && snapshot.state !== "stopping") return;
    const startedAt = listeningSinceRef.current;
    if (startedAt === null) return;
    const update = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [snapshot]);

  const finishAndSave = () => {
    // Repeat-submission guard: the workspace's save is async (it
    // awaits the note write before closing the sheet), so without
    // this a quick second tap in that window would create the note
    // twice. The ref makes the guard synchronous, not render-timed.
    if (submittedRef.current) return;
    const session = sessionRef.current;
    if (!session) return;
    const segments = session.getSnapshot().committed;
    if (segments.length === 0) {
      setEmptyNotice(true);
      return;
    }
    submittedRef.current = true;
    setSubmitted(true);
    onSaveRef.current(
      voiceNoteTitle(segments),
      plainTextToNoteHtml(segmentsToParagraphs(segments)),
    );
  };

  /* Done while listening: stop first, save when the session settles —
   * finals landing during "stopping" still count. */
  useEffect(() => {
    if (!pendingSave || !snapshot) return;
    if (snapshot.state === "idle" || snapshot.state === "error") {
      setPendingSave(false);
      finishAndSave();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSave, snapshot]);

  const handleDone = () => {
    if (submittedRef.current) return;
    const session = sessionRef.current;
    if (!session) return;
    const state = session.getSnapshot().state;
    if (state === "listening") {
      setPendingSave(true);
      session.stop();
    } else if (state !== "stopping" && state !== "requesting-permission") {
      finishAndSave();
    }
  };

  const handleRetry = () => {
    const session = sessionRef.current;
    if (!session) return;
    setEmptyNotice(false);
    session.reset();
    void session.start(resolveSpeechLanguageTag(speechLanguage, navigator.language));
  };

  const handleTypeInstead = () => {
    sessionRef.current?.cancel();
    onTypeInstead();
  };

  const state = snapshot?.state ?? "idle";
  const committed = snapshot?.committed ?? [];
  const hasTranscript = committed.length > 0;
  const isError = state === "error";
  const errorLine = isError
    ? (ERROR_LINES[snapshot?.errorKind ?? "client"] ?? "Voice capture stopped unexpectedly.")
    : undefined;
  const showEmpty =
    emptyNotice || (isError && snapshot?.errorKind === "no-speech" && !hasTranscript);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg font-semibold">
            <Mic className="size-5" />
            Voice note
          </DialogTitle>
        </DialogHeader>

        {availability === "checking" ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Preparing the microphone…
          </div>
        ) : availability === "unavailable" ? (
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              {blockedApp !== null ? (
                <>
                  Your phone&apos;s speech service{blockedApp ? ` — ${blockedApp} —` : ""} is
                  disabled, so dictation can&apos;t run. Enable it, or choose a different voice
                  input in your system settings, to use voice capture.
                </>
              ) : (
                <>
                  No speech recogniser is available on this device or browser, so voice capture
                  can&apos;t run here.
                </>
              )}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button className="noma-cta" onClick={handleTypeInstead}>
                Type instead
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 py-2">
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              aria-live="polite"
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  state === "listening" ? "animate-pulse bg-destructive" : "bg-muted-foreground/50",
                )}
              />
              {state === "listening" ? (
                <span>
                  Listening… <span className="tabular-nums">{formatElapsed(elapsed)}</span>
                </span>
              ) : state === "requesting-permission" ? (
                <span>Waiting for microphone permission…</span>
              ) : state === "stopping" ? (
                <span>Finishing…</span>
              ) : isError ? (
                <span className="text-destructive">{errorLine ?? "Voice capture stopped."}</span>
              ) : (
                <span>Ready</span>
              )}
            </div>

            <div className="noma-scroll max-h-56 min-h-24 space-y-2 overflow-y-auto rounded-lg border border-border/70 bg-muted/30 p-3 text-sm">
              {hasTranscript || snapshot?.partial ? (
                <>
                  {committed.map((segment, index) => (
                    <p key={index}>{segment}</p>
                  ))}
                  {snapshot?.partial ? (
                    <p className="text-muted-foreground italic">{snapshot.partial}</p>
                  ) : null}
                </>
              ) : (
                <p className="text-muted-foreground italic">
                  {showEmpty
                    ? "Didn't catch that — try again, a little closer to the mic."
                    : "Start talking — your words will appear here."}
                </p>
              )}
            </div>

            {showEmpty ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button variant="outline" onClick={handleTypeInstead}>
                  Type instead
                </Button>
                <Button className="noma-cta" onClick={handleRetry}>
                  Try again
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitted}>
                  Cancel
                </Button>
                <Button variant="outline" onClick={handleTypeInstead} disabled={submitted}>
                  Type instead
                </Button>
                <Button
                  className="noma-cta"
                  onClick={handleDone}
                  disabled={
                    submitted ||
                    state === "requesting-permission" ||
                    state === "stopping" ||
                    pendingSave
                  }
                >
                  {state === "listening" ? "Done" : "Save note"}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

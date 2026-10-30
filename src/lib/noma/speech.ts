import { Capacitor, registerPlugin } from "@capacitor/core";
import type { SpeechLanguageSetting } from "./types";

export type { SpeechLanguageSetting };

/**
 * Voice capture (PR-A: the engine). Everything above the platform
 * recogniser lives here as pure, tested logic; the surfaces (editor
 * dictation in PR-B, voice quick capture in PR-C) consume one session
 * API and never touch a recogniser directly.
 *
 * The shape mirrors the rest of Noma:
 *  - an engine is a replaceable seam (the native NomaSpeech plugin in
 *    the app, the Web Speech API on web, a fake in tests) emitting
 *    partial/final/end/error events for ONE single-utterance
 *    recognition at a time;
 *  - a pure reducer owns the session state — continuous dictation is
 *    the controller restarting a finished utterance while the session
 *    is still live, so a pause between sentences never kills it;
 *  - transcript assembly (spacing, paragraphs) is pure functions.
 *
 * Only transcript text ever exists: no engine records or stores
 * audio. On older Android devices the device's own speech service
 * performs recognition (usually Google's); on Android 12+ an
 * on-device recogniser is preferred when present. Settings copy
 * (PR-B) discloses that split; nothing here phones home either way.
 */

/* ---------------- Language ---------------- */

/** The Settings choice lives in types.ts (AppSettings); resolution here. */

/**
 * Resolve the setting to the BCP-47 tag handed to the recogniser.
 * System falls back to en-US when the platform reports nothing.
 */
export function resolveSpeechLanguageTag(
  setting: SpeechLanguageSetting,
  systemTag: string | undefined,
): string {
  switch (setting) {
    case "en":
      return "en-US";
    case "bn":
      return "bn-BD";
    case "system":
      return systemTag && systemTag.trim() ? systemTag : "en-US";
  }
}

/* ---------------- Transcript assembly ---------------- */

/** Append a final segment; whitespace-only segments never land. */
export function appendFinalSegment(segments: readonly string[], text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [...segments];
  return [...segments, trimmed];
}

/** Quick-capture shape: one paragraph per final segment. */
export function segmentsToParagraphs(segments: readonly string[]): string {
  return segments
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Quick-capture shape: the segments as flowing text. */
export function segmentsToText(segments: readonly string[]): string {
  return segments
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
}

/** Title cap for a voice note — mirrors the share pipeline's title cap. */
export const VOICE_NOTE_TITLE_MAX_CHARS = 200;

/**
 * A voice note's title: its first spoken segment, trimmed and capped —
 * the same "first line names the note" convention typed notes follow.
 * Empty when nothing was recognised (the caller creates no note then).
 */
export function voiceNoteTitle(segments: readonly string[]): string {
  const first = segments.map((s) => s.trim()).find((s) => s.length > 0) ?? "";
  return first.slice(0, VOICE_NOTE_TITLE_MAX_CHARS).trim();
}

/**
 * Editor insertion spacing: joining a dictated segment onto the text
 * before the caret takes exactly one space, and only when the
 * preceding text doesn't already end in whitespace (or is empty).
 */
export function dictationJoin(before: string, segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed) return before;
  if (!before || /\s$/.test(before)) return before + trimmed;
  return `${before} ${trimmed}`;
}

/**
 * The text to insert at the caret for one final segment, given the
 * single character before the caret ("" at a document/block start,
 * where textBetween reports nothing or a block separator — both read
 * as "nothing before", so no leading space). Returns "" when the
 * segment carries no words.
 */
export function dictationInsertionText(beforeChar: string, segment: string): string {
  const probe = beforeChar.slice(-1);
  return dictationJoin(probe, segment).slice(probe.length);
}

/* ---------------- Session state machine ---------------- */

/**
 * Error kinds the UI maps to calm states. "no-match" and
 * "speech-timeout" are SOFT: an utterance window closed with nothing
 * recognised — mid-dictation pauses produce them, so they only end
 * the session after MAX_SOFT_MISSES in a row (surfaced as
 * "no-speech"). Everything else is fatal to the session, with any
 * committed finals preserved.
 */
export type SpeechErrorKind =
  | "unavailable"
  | "service-disabled"
  | "permission"
  | "no-speech"
  | "no-match"
  | "speech-timeout"
  | "network"
  | "audio"
  | "busy"
  | "server"
  | "client";

export const MAX_SOFT_MISSES = 3;

const SOFT_KINDS: ReadonlySet<SpeechErrorKind> = new Set(["no-match", "speech-timeout"]);

export type SpeechSessionState =
  "idle" | "requesting-permission" | "listening" | "stopping" | "error";

export interface SpeechSessionSnapshot {
  state: SpeechSessionState;
  /** Final segments, in order — the transcript so far. Never lost on error. */
  committed: string[];
  /** The in-progress utterance's latest partial text (not committed). */
  partial: string;
  errorKind: SpeechErrorKind | null;
  /** Consecutive soft misses since the last final (drives "no-speech"). */
  softMisses: number;
}

export const INITIAL_SPEECH_SESSION: SpeechSessionSnapshot = {
  state: "idle",
  committed: [],
  partial: "",
  errorKind: null,
  softMisses: 0,
};

export type SpeechSessionEvent =
  | { type: "start-requested" }
  | { type: "unavailable" }
  | { type: "permission-granted" }
  | { type: "permission-denied" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "engine-ended" }
  | { type: "engine-error"; kind: SpeechErrorKind }
  | { type: "stop-requested" }
  | { type: "cancelled" }
  | { type: "reset" };

export function speechSessionReducer(
  session: SpeechSessionSnapshot,
  event: SpeechSessionEvent,
): SpeechSessionSnapshot {
  switch (event.type) {
    case "start-requested":
      if (session.state === "listening" || session.state === "stopping") return session;
      if (session.state === "requesting-permission") return session;
      return { ...session, state: "requesting-permission", errorKind: null, partial: "" };
    case "permission-granted":
      if (session.state !== "requesting-permission") return session;
      return { ...session, state: "listening" };
    case "unavailable":
      if (session.state !== "requesting-permission") return session;
      return { ...session, state: "error", errorKind: "unavailable", partial: "" };
    case "permission-denied":
      if (session.state !== "requesting-permission") return session;
      return { ...session, state: "error", errorKind: "permission", partial: "" };
    case "partial":
      if (session.state !== "listening") return session;
      return { ...session, partial: event.text };
    case "final": {
      if (session.state !== "listening" && session.state !== "stopping") return session;
      return {
        ...session,
        committed: appendFinalSegment(session.committed, event.text),
        partial: "",
        softMisses: 0,
      };
    }
    case "engine-ended":
      if (session.state === "stopping") return { ...session, state: "idle", partial: "" };
      // Listening: the utterance ended; the controller restarts the
      // engine while the session lives. Nothing changes here.
      return session;
    case "engine-error": {
      if (session.state !== "listening" && session.state !== "stopping") return session;
      if (SOFT_KINDS.has(event.kind)) {
        const softMisses = session.softMisses + 1;
        if (softMisses >= MAX_SOFT_MISSES) {
          return { ...session, state: "error", errorKind: "no-speech", partial: "", softMisses };
        }
        return { ...session, state: "listening", partial: "", softMisses };
      }
      return { ...session, state: "error", errorKind: event.kind, partial: "" };
    }
    case "stop-requested":
      if (session.state !== "listening") return session;
      return { ...session, state: "stopping" };
    case "cancelled":
      return { ...session, state: "idle", partial: "", errorKind: null, softMisses: 0 };
    case "reset":
      return INITIAL_SPEECH_SESSION;
  }
}

/* ---------------- Engines ---------------- */

export interface SpeechEngineHandlers {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onEnd: () => void;
  onError: (kind: SpeechErrorKind) => void;
}

/** Why no recogniser can run, when the platform can say (native probe). */
export type SpeechUnavailableReason = "service-disabled";

/** What an engine probe reports. The reason fields are the native
 * probe's honesty pass: a registered-but-disabled default speech
 * service is reported WITH the reason and the app's label. When no
 * on-device recogniser exists that makes the probe unavailable and
 * the UI stops offering the mic; when one does, the mic stays
 * offered and the reason rides along as an advisory, so a runtime
 * fallback failure can still be named honestly. */
export interface SpeechProbe {
  available: boolean;
  onDevice: boolean;
  reason?: SpeechUnavailableReason | null;
  serviceApp?: string | null;
}

/**
 * One engine = one platform recogniser. start() runs a single
 * utterance; the controller restarts it for continuous dictation.
 * stop() asks for the in-flight utterance's final results before the
 * end; cancel() abandons it silently.
 */
export interface SpeechEngine {
  probe: () => Promise<SpeechProbe>;
  ensurePermission: () => Promise<boolean>;
  start: (languageTag: string, handlers: SpeechEngineHandlers) => void | Promise<void>;
  stop: () => void | Promise<void>;
  cancel: () => void | Promise<void>;
}

interface NomaSpeechPluginInterface {
  isAvailable(): Promise<SpeechProbe>;
  ensureMicrophoneAccess(): Promise<{ granted: boolean }>;
  startListening(options: { language: string }): Promise<void>;
  stopListening(): Promise<void>;
  cancelListening(): Promise<void>;
  addListener(
    eventName: "speechPartial" | "speechFinal" | "speechEnd" | "speechError",
    listener: (data: { text?: string; kind?: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

let nativePlugin: NomaSpeechPluginInterface | null = null;
function nomaSpeech(): NomaSpeechPluginInterface {
  nativePlugin ??= registerPlugin<NomaSpeechPluginInterface>("NomaSpeech");
  return nativePlugin;
}

const NATIVE_ERROR_KINDS: ReadonlySet<string> = new Set([
  "no-match",
  "speech-timeout",
  "network",
  "audio",
  "permission",
  "busy",
  "server",
  "client",
]);

function nativeErrorKind(kind: string | undefined): SpeechErrorKind {
  return kind && NATIVE_ERROR_KINDS.has(kind) ? (kind as SpeechErrorKind) : "client";
}

/** The installed app's engine: the NomaSpeech plugin (Android SpeechRecognizer). */
export function createNativeSpeechEngine(): SpeechEngine {
  let handles: Array<{ remove: () => Promise<void> }> = [];
  let handlers: SpeechEngineHandlers | null = null;

  const detach = async () => {
    const current = handles;
    handles = [];
    await Promise.all(current.map((h) => h.remove().catch(() => undefined)));
  };

  return {
    probe: () => nomaSpeech().isAvailable(),
    ensurePermission: async () => {
      try {
        const res = await nomaSpeech().ensureMicrophoneAccess();
        return !!res?.granted;
      } catch {
        return false;
      }
    },
    start: async (languageTag, nextHandlers) => {
      handlers = nextHandlers;
      if (handles.length === 0) {
        const plugin = nomaSpeech();
        handles = await Promise.all([
          plugin.addListener("speechPartial", (d) => {
            if (d.text) handlers?.onPartial(d.text);
          }),
          plugin.addListener("speechFinal", (d) => {
            if (d.text) handlers?.onFinal(d.text);
          }),
          plugin.addListener("speechEnd", () => handlers?.onEnd()),
          plugin.addListener("speechError", (d) => handlers?.onError(nativeErrorKind(d.kind))),
        ]);
      }
      await nomaSpeech().startListening({ language: languageTag });
    },
    stop: () => nomaSpeech().stopListening(),
    cancel: async () => {
      await nomaSpeech().cancelListening();
      handlers = null;
      await detach();
    },
  };
}

/* Minimal Web Speech API surface (the DOM lib types are spotty). */
interface WebSpeechResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface WebSpeechEventLike {
  resultIndex: number;
  results: ArrayLike<WebSpeechResultLike>;
}
interface WebSpeechErrorEventLike {
  error: string;
}
interface WebSpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: WebSpeechEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: WebSpeechErrorEventLike) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function webSpeechConstructor(): (new () => WebSpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => WebSpeechRecognitionLike;
    webkitSpeechRecognition?: new () => WebSpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function webErrorKind(error: string): SpeechErrorKind {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "permission";
    case "no-speech":
      return "no-match";
    case "network":
      return "network";
    case "audio-capture":
      return "audio";
    default:
      return "client";
  }
}

/** The web engine: Web Speech API where the browser offers it. */
export function createWebSpeechEngine(): SpeechEngine {
  let recognition: WebSpeechRecognitionLike | null = null;
  let aborting = false;

  return {
    probe: async () => ({ available: webSpeechConstructor() !== null, onDevice: false }),
    ensurePermission: async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        return true;
      } catch {
        return false;
      }
    },
    start: (languageTag, handlers) => {
      const Ctor = webSpeechConstructor();
      if (!Ctor) {
        handlers.onError("unavailable");
        return;
      }
      aborting = false;
      const rec = new Ctor();
      recognition = rec;
      rec.lang = languageTag;
      rec.continuous = false;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (!result) continue;
          if (result.isFinal) handlers.onFinal(result[0].transcript);
          else interim += result[0].transcript;
        }
        if (interim) handlers.onPartial(interim);
      };
      rec.onerror = (event) => {
        if (aborting) return;
        if (event.error === "aborted") return;
        handlers.onError(webErrorKind(event.error));
      };
      rec.onend = () => {
        if (recognition === rec) recognition = null;
        handlers.onEnd();
      };
      try {
        rec.start();
      } catch {
        handlers.onError("client");
      }
    },
    stop: () => {
      try {
        recognition?.stop();
      } catch {
        // Already stopped — the end event settles the session.
      }
    },
    cancel: () => {
      aborting = true;
      try {
        recognition?.abort();
      } catch {
        // Nothing to abort.
      }
      recognition = null;
    },
  };
}

/** The platform's engine, or null where no recogniser exists at all. */
export function defaultSpeechEngine(): SpeechEngine | null {
  if (Capacitor.isNativePlatform()) return createNativeSpeechEngine();
  return webSpeechConstructor() ? createWebSpeechEngine() : null;
}

/* ---------------- Session controller ---------------- */

export interface SpeechSession {
  getSnapshot: () => SpeechSessionSnapshot;
  subscribe: (listener: (snapshot: SpeechSessionSnapshot) => void) => () => void;
  start: (languageTag: string) => Promise<void>;
  stop: () => void;
  cancel: () => void;
  reset: () => void;
}

/**
 * Wires an engine to the reducer. Continuous dictation lives here:
 * when an utterance ends (or softly misses) and the session is still
 * "listening", the engine is restarted for the next utterance.
 */
export function createSpeechSession(engine: SpeechEngine): SpeechSession {
  let snapshot: SpeechSessionSnapshot = INITIAL_SPEECH_SESSION;
  let languageTag = "en-US";
  // Set by start() from the probe: the platform service is disabled
  // but an on-device recogniser kept the session viable. A generic
  // client/server death under this advisory almost certainly means
  // on-device creation failed and the engine fell back to the dead
  // service — onError names it instead of the generic kind.
  let fallbackServiceDisabled = false;
  let restartQueued = false;
  const listeners = new Set<(snapshot: SpeechSessionSnapshot) => void>();

  const dispatch = (event: SpeechSessionEvent) => {
    const next = speechSessionReducer(snapshot, event);
    if (next !== snapshot) {
      snapshot = next;
      for (const listener of listeners) listener(snapshot);
    }
  };

  const maybeRestart = () => {
    if (snapshot.state !== "listening" || restartQueued) return;
    restartQueued = true;
    // Let the platform fully release the previous utterance first.
    queueMicrotask(() => {
      restartQueued = false;
      if (snapshot.state !== "listening") return;
      void engine.start(languageTag, handlers);
    });
  };

  const handlers: SpeechEngineHandlers = {
    onPartial: (text) => dispatch({ type: "partial", text }),
    onFinal: (text) => dispatch({ type: "final", text }),
    onEnd: () => {
      dispatch({ type: "engine-ended" });
      maybeRestart();
    },
    onError: (kind) => {
      const effective =
        fallbackServiceDisabled && (kind === "client" || kind === "server")
          ? "service-disabled"
          : kind;
      dispatch({ type: "engine-error", kind: effective });
      maybeRestart();
    },
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: async (tag) => {
      if (
        snapshot.state === "listening" ||
        snapshot.state === "stopping" ||
        snapshot.state === "requesting-permission"
      ) {
        return;
      }
      languageTag = tag;
      dispatch({ type: "start-requested" });
      const stillRequesting = () => snapshot.state === "requesting-permission";
      const probe: SpeechProbe = await engine
        .probe()
        .catch((): SpeechProbe => ({ available: false, onDevice: false }));
      if (!stillRequesting()) return;
      if (!probe.available) {
        dispatch({ type: "unavailable" });
        return;
      }
      fallbackServiceDisabled = probe.reason === "service-disabled";
      const granted = await engine.ensurePermission().catch(() => false);
      if (!stillRequesting()) return;
      if (!granted) {
        dispatch({ type: "permission-denied" });
        return;
      }
      dispatch({ type: "permission-granted" });
      void engine.start(languageTag, handlers);
    },
    stop: () => {
      if (snapshot.state !== "listening") return;
      dispatch({ type: "stop-requested" });
      void engine.stop();
    },
    cancel: () => {
      void engine.cancel();
      dispatch({ type: "cancelled" });
    },
    reset: () => dispatch({ type: "reset" }),
  };
}

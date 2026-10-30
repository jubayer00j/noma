// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  appendFinalSegment,
  createSpeechSession,
  dictationInsertionText,
  dictationJoin,
  INITIAL_SPEECH_SESSION,
  MAX_SOFT_MISSES,
  resolveSpeechLanguageTag,
  segmentsToParagraphs,
  segmentsToText,
  speechSessionReducer,
  voiceNoteTitle,
  type SpeechEngine,
  type SpeechEngineHandlers,
  type SpeechSessionSnapshot,
} from "./speech";

/* Voice capture PR-A: the engine's pure logic pinned — language
 * resolution, transcript assembly, the session reducer, and the
 * controller's continuous-dictation restarts, driven by a fake
 * engine (no recogniser exists in a test, by design). */

describe("resolveSpeechLanguageTag", () => {
  it("system passes the platform tag through", () => {
    expect(resolveSpeechLanguageTag("system", "bn-BD")).toBe("bn-BD");
    expect(resolveSpeechLanguageTag("system", "en-GB")).toBe("en-GB");
  });

  it("system falls back to en-US when the platform reports nothing", () => {
    expect(resolveSpeechLanguageTag("system", undefined)).toBe("en-US");
    expect(resolveSpeechLanguageTag("system", "  ")).toBe("en-US");
  });

  it("explicit choices pin their tags", () => {
    expect(resolveSpeechLanguageTag("en", "bn-BD")).toBe("en-US");
    expect(resolveSpeechLanguageTag("bn", "en-US")).toBe("bn-BD");
  });
});

describe("transcript assembly", () => {
  it("appendFinalSegment trims and appends", () => {
    expect(appendFinalSegment([], "  hello world ")).toEqual(["hello world"]);
    expect(appendFinalSegment(["one"], "two")).toEqual(["one", "two"]);
  });

  it("appendFinalSegment drops whitespace-only results", () => {
    expect(appendFinalSegment(["one"], "   ")).toEqual(["one"]);
    expect(appendFinalSegment([], "")).toEqual([]);
  });

  it("segments join as paragraphs or flowing text", () => {
    const segments = ["First thought.", "Second thought."];
    expect(segmentsToParagraphs(segments)).toBe("First thought.\n\nSecond thought.");
    expect(segmentsToText(segments)).toBe("First thought. Second thought.");
    expect(segmentsToParagraphs([])).toBe("");
  });

  it("voiceNoteTitle names the note from its first spoken segment", () => {
    expect(voiceNoteTitle(["  Buy milk and eggs  ", "Also call mum"])).toBe("Buy milk and eggs");
    expect(voiceNoteTitle(["", "  ", "Second is first real"])).toBe("Second is first real");
    expect(voiceNoteTitle([])).toBe("");
    expect(voiceNoteTitle(["   "])).toBe("");
    const long = "x".repeat(250);
    expect(voiceNoteTitle([long]).length).toBe(200);
  });

  it("dictationJoin adds exactly one space, only when needed", () => {
    expect(dictationJoin("", "hello")).toBe("hello");
    expect(dictationJoin("hello ", "world")).toBe("hello world");
    expect(dictationJoin("hello", "world")).toBe("hello world");
    expect(dictationJoin("hello", "  ")).toBe("hello");
  });

  it("dictationInsertionText returns only the text to insert at the caret", () => {
    // Nothing before the caret (document or block start): no space.
    expect(dictationInsertionText("", "hello")).toBe("hello");
    // A block separator before the caret reads as nothing before.
    expect(dictationInsertionText("\n", "hello")).toBe("hello");
    // Whitespace before: no extra space.
    expect(dictationInsertionText(" ", "world")).toBe("world");
    // A letter before: exactly one leading space.
    expect(dictationInsertionText("o", "world")).toBe(" world");
    // A wordless segment inserts nothing.
    expect(dictationInsertionText("o", "   ")).toBe("");
  });
});

const listening = (over: Partial<SpeechSessionSnapshot> = {}): SpeechSessionSnapshot => ({
  ...INITIAL_SPEECH_SESSION,
  state: "listening",
  ...over,
});

describe("speechSessionReducer", () => {
  it("walks the start path: idle → requesting → listening", () => {
    const requested = speechSessionReducer(INITIAL_SPEECH_SESSION, { type: "start-requested" });
    expect(requested.state).toBe("requesting-permission");
    const granted = speechSessionReducer(requested, { type: "permission-granted" });
    expect(granted.state).toBe("listening");
  });

  it("start-requested is a no-op while already listening", () => {
    const s = listening();
    expect(speechSessionReducer(s, { type: "start-requested" })).toBe(s);
  });

  it("permission denial and unavailability land in named error states", () => {
    const requested = speechSessionReducer(INITIAL_SPEECH_SESSION, { type: "start-requested" });
    expect(speechSessionReducer(requested, { type: "permission-denied" })).toMatchObject({
      state: "error",
      errorKind: "permission",
    });
    expect(speechSessionReducer(requested, { type: "unavailable" })).toMatchObject({
      state: "error",
      errorKind: "unavailable",
    });
  });

  it("partials only land while listening and are replaced, not appended", () => {
    const s = listening();
    const p1 = speechSessionReducer(s, { type: "partial", text: "hel" });
    const p2 = speechSessionReducer(p1, { type: "partial", text: "hello" });
    expect(p2.partial).toBe("hello");
    expect(speechSessionReducer(INITIAL_SPEECH_SESSION, { type: "partial", text: "x" })).toBe(
      INITIAL_SPEECH_SESSION,
    );
  });

  it("a final commits, clears the partial and resets the soft-miss counter", () => {
    const s = listening({ partial: "hello world", softMisses: 2 });
    const next = speechSessionReducer(s, { type: "final", text: "hello world" });
    expect(next.committed).toEqual(["hello world"]);
    expect(next.partial).toBe("");
    expect(next.softMisses).toBe(0);
  });

  it("a final still lands while stopping (stop asks for the last utterance)", () => {
    const s = listening({ state: "stopping" });
    const next = speechSessionReducer(s, { type: "final", text: "last words" });
    expect(next.committed).toEqual(["last words"]);
  });

  it("engine-ended is invisible while listening, and settles a stopping session", () => {
    const s = listening();
    expect(speechSessionReducer(s, { type: "engine-ended" })).toBe(s);
    const stopping = listening({ state: "stopping" });
    expect(speechSessionReducer(stopping, { type: "engine-ended" }).state).toBe("idle");
  });

  it("soft misses accumulate and only the third ends the session, as no-speech", () => {
    let s = listening({ partial: "um" });
    s = speechSessionReducer(s, { type: "engine-error", kind: "no-match" });
    expect(s).toMatchObject({ state: "listening", softMisses: 1, partial: "" });
    s = speechSessionReducer(s, { type: "engine-error", kind: "speech-timeout" });
    expect(s).toMatchObject({ state: "listening", softMisses: 2 });
    s = speechSessionReducer(s, { type: "engine-error", kind: "no-match" });
    expect(s).toMatchObject({
      state: "error",
      errorKind: "no-speech",
      softMisses: MAX_SOFT_MISSES,
    });
  });

  it("a fatal error ends the session but never loses committed finals", () => {
    const s = listening({ committed: ["kept"] });
    const next = speechSessionReducer(s, { type: "engine-error", kind: "network" });
    expect(next).toMatchObject({ state: "error", errorKind: "network", committed: ["kept"] });
  });

  it("cancel returns to idle with the transcript kept; reset clears all", () => {
    const s = listening({ committed: ["kept"], partial: "draft" });
    const cancelled = speechSessionReducer(s, { type: "cancelled" });
    expect(cancelled).toMatchObject({ state: "idle", committed: ["kept"], partial: "" });
    expect(speechSessionReducer(s, { type: "reset" })).toEqual(INITIAL_SPEECH_SESSION);
  });
});

/* ---------------- Controller, driven by a fake engine ---------------- */

function fakeEngine(
  opts: {
    available?: boolean;
    permission?: boolean;
    onDevice?: boolean;
    probeReason?: "service-disabled";
    serviceApp?: string;
  } = {},
) {
  const calls = { probe: 0, ensure: 0, start: 0, stop: 0, cancel: 0 };
  let handlers: SpeechEngineHandlers | null = null;
  const engine: SpeechEngine = {
    probe: async () => {
      calls.probe++;
      return {
        available: opts.available ?? true,
        onDevice: opts.onDevice ?? false,
        ...(opts.probeReason
          ? { reason: opts.probeReason, serviceApp: opts.serviceApp ?? null }
          : {}),
      };
    },
    ensurePermission: async () => {
      calls.ensure++;
      return opts.permission ?? true;
    },
    start: (_tag, h) => {
      calls.start++;
      handlers = h;
    },
    stop: () => {
      calls.stop++;
    },
    cancel: () => {
      calls.cancel++;
    },
  };
  return {
    engine,
    calls,
    emit: () => {
      if (!handlers) throw new Error("engine not started");
      return handlers;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createSpeechSession", () => {
  it("start probes, asks permission, then starts the engine listening", async () => {
    const { engine, calls } = fakeEngine();
    const session = createSpeechSession(engine);
    await session.start("bn-BD");
    expect(session.getSnapshot().state).toBe("listening");
    expect(calls).toMatchObject({ probe: 1, ensure: 1, start: 1 });
  });

  it("an unavailable recogniser errors as unavailable and never starts", async () => {
    const { engine, calls } = fakeEngine({ available: false });
    const session = createSpeechSession(engine);
    await session.start("en-US");
    expect(session.getSnapshot()).toMatchObject({ state: "error", errorKind: "unavailable" });
    expect(calls.start).toBe(0);
  });

  it("a denied permission errors as permission and never starts", async () => {
    const { engine, calls } = fakeEngine({ permission: false });
    const session = createSpeechSession(engine);
    await session.start("en-US");
    expect(session.getSnapshot()).toMatchObject({ state: "error", errorKind: "permission" });
    expect(calls.start).toBe(0);
  });

  it("under the disabled-service advisory, a generic engine death is named service-disabled", async () => {
    const { engine, emit } = fakeEngine({
      onDevice: true,
      probeReason: "service-disabled",
      serviceApp: "Google",
    });
    const session = createSpeechSession(engine);
    await session.start("en-US");
    expect(session.getSnapshot().state).toBe("listening");
    emit().onError("client");
    expect(session.getSnapshot()).toMatchObject({ state: "error", errorKind: "service-disabled" });
  });

  it("under the advisory, unrelated errors keep their own kind", async () => {
    const { engine, emit } = fakeEngine({
      onDevice: true,
      probeReason: "service-disabled",
      serviceApp: "Google",
    });
    const session = createSpeechSession(engine);
    await session.start("en-US");
    emit().onError("network");
    expect(session.getSnapshot()).toMatchObject({ state: "error", errorKind: "network" });
  });

  it("without the advisory, a client error stays client", async () => {
    const { engine, emit } = fakeEngine();
    const session = createSpeechSession(engine);
    await session.start("en-US");
    emit().onError("client");
    expect(session.getSnapshot()).toMatchObject({ state: "error", errorKind: "client" });
  });

  it("partials and finals flow into the snapshot", async () => {
    const { engine, emit } = fakeEngine();
    const session = createSpeechSession(engine);
    await session.start("en-US");
    emit().onPartial("hel");
    expect(session.getSnapshot().partial).toBe("hel");
    emit().onFinal("hello");
    expect(session.getSnapshot()).toMatchObject({ committed: ["hello"], partial: "" });
  });

  it("an utterance ending mid-session restarts the engine (continuous dictation)", async () => {
    const { engine, calls, emit } = fakeEngine();
    const session = createSpeechSession(engine);
    await session.start("en-US");
    emit().onEnd();
    await tick();
    expect(session.getSnapshot().state).toBe("listening");
    expect(calls.start).toBe(2);
  });

  it("stop settles through stopping to idle, with no restart", async () => {
    const { engine, calls, emit } = fakeEngine();
    const session = createSpeechSession(engine);
    await session.start("en-US");
    session.stop();
    expect(session.getSnapshot().state).toBe("stopping");
    expect(calls.stop).toBe(1);
    emit().onFinal("last words");
    emit().onEnd();
    await tick();
    expect(session.getSnapshot()).toMatchObject({ state: "idle", committed: ["last words"] });
    expect(calls.start).toBe(1);
  });

  it("repeated silence gives up as no-speech instead of restarting forever", async () => {
    const { engine, calls, emit } = fakeEngine();
    const session = createSpeechSession(engine);
    await session.start("en-US");
    emit().onError("no-match");
    await tick();
    emit().onError("speech-timeout");
    await tick();
    emit().onError("no-match");
    await tick();
    expect(session.getSnapshot()).toMatchObject({ state: "error", errorKind: "no-speech" });
    expect(calls.start).toBe(3);
  });

  it("cancel idles the session and cancels the engine", async () => {
    const { engine, calls, emit } = fakeEngine();
    const session = createSpeechSession(engine);
    await session.start("en-US");
    emit().onFinal("kept");
    session.cancel();
    expect(session.getSnapshot()).toMatchObject({ state: "idle", committed: ["kept"] });
    expect(calls.cancel).toBe(1);
  });
});

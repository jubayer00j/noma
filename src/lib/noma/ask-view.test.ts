import { describe, expect, it } from "vitest";
import { OPENROUTER_BASE_URL, type AiEmbeddingTarget, type AiSettings } from "./ai";
import type { AskExcerpt } from "./ask";
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
  type AskThreadState,
} from "./ask-view";
import type { SemanticIndexStatus } from "./semantic";

const geminiSettings: AiSettings = { enabled: true, apiKey: "key" };
const geminiTarget: AiEmbeddingTarget = {
  settings: geminiSettings,
  presetId: "gemini",
  embeddingModel: "gemini-embedding-001",
  mode: "native",
};

const readyStatus: SemanticIndexStatus = {
  state: "ready",
  indexedCount: 4,
  staleCount: 0,
  embeddingModel: "gemini-embedding-001",
  chunkCount: 11,
  chunksStaleCount: 0,
};

function excerpt(noteId: string, chunkIndex: number, text = "passage"): AskExcerpt {
  return { noteId, chunkIndex, title: `Title of ${noteId}`, text, similarity: 0.9 };
}

function answerEntry(
  status: AskAnswerEntry["status"],
  text = "",
): Omit<AskAnswerEntry, "kind" | "id"> {
  return { status, text, citations: [], sentExcerpts: [], disclosure: null, errorMessage: null };
}

function threadWith(...actions: Parameters<typeof askThreadReducer>[1][]): AskThreadState {
  return actions.reduce(askThreadReducer, initialAskThreadState);
}

describe("deriveAskGate", () => {
  it("asks for AI setup before anything else", () => {
    expect(deriveAskGate({ settings: null, target: null, indexStatus: null })).toBe("ai-off");
    expect(
      deriveAskGate({
        settings: { enabled: false, apiKey: "key" },
        target: null,
        indexStatus: null,
      }),
    ).toBe("ai-off");
    expect(
      deriveAskGate({ settings: { enabled: true, apiKey: "  " }, target: null, indexStatus: null }),
    ).toBe("ai-off");
  });

  it("shows the honest no-embeddings note for Groq / DeepSeek presets", () => {
    const groq: AiSettings = {
      enabled: true,
      apiKey: "key",
      provider: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
    };
    expect(deriveAskGate({ settings: groq, target: null, indexStatus: readyStatus })).toBe(
      "no-embeddings",
    );
    const deepseek: AiSettings = {
      enabled: true,
      apiKey: "key",
      provider: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
    };
    expect(deriveAskGate({ settings: deepseek, target: null, indexStatus: readyStatus })).toBe(
      "no-embeddings",
    );
  });

  it("points at an embedding model when a compatible preset has none chosen", () => {
    const together: AiSettings = {
      enabled: true,
      apiKey: "key",
      provider: "openai-compatible",
      baseUrl: "https://api.together.xyz/v1",
    };
    expect(deriveAskGate({ settings: together, target: null, indexStatus: readyStatus })).toBe(
      "needs-embedding-model",
    );
  });

  it("loads, then gates on a missing or foreign index", () => {
    expect(
      deriveAskGate({ settings: geminiSettings, target: geminiTarget, indexStatus: null }),
    ).toBe("loading");
    expect(
      deriveAskGate({
        settings: geminiSettings,
        target: geminiTarget,
        indexStatus: { ...readyStatus, state: "not-built", indexedCount: 0, chunkCount: 0 },
      }),
    ).toBe("needs-index");
    expect(
      deriveAskGate({
        settings: geminiSettings,
        target: geminiTarget,
        indexStatus: { ...readyStatus, state: "invalid-provider" },
      }),
    ).toBe("needs-rebuild");
  });

  it("gates a pre-chunk index on the chunk backfill, not on Update-less readiness", () => {
    expect(
      deriveAskGate({
        settings: geminiSettings,
        target: geminiTarget,
        indexStatus: { ...readyStatus, chunkCount: 0, chunksStaleCount: 4 },
      }),
    ).toBe("chunks-pending");
  });

  it("is ready with a usable index — and with an empty library", () => {
    expect(
      deriveAskGate({ settings: geminiSettings, target: geminiTarget, indexStatus: readyStatus }),
    ).toBe("ready");
    expect(
      deriveAskGate({
        settings: geminiSettings,
        target: geminiTarget,
        indexStatus: { ...readyStatus, indexedCount: 0, chunkCount: 0 },
      }),
    ).toBe("ready");
  });

  it("never lets staleness block: a behind index is still ready", () => {
    const stale = { ...readyStatus, staleCount: 2 };
    expect(
      deriveAskGate({ settings: geminiSettings, target: geminiTarget, indexStatus: stale }),
    ).toBe("ready");
    expect(askIndexStale(stale)).toBe(true);
    expect(askIndexStale({ ...readyStatus, chunksStaleCount: 1 })).toBe(true);
    expect(askIndexStale(readyStatus)).toBe(false);
    expect(askIndexStale({ ...readyStatus, state: "not-built", staleCount: 3 })).toBe(false);
    expect(askIndexStale(null)).toBe(false);
  });
});

describe("askProviderName", () => {
  it("mirrors the Settings provider naming", () => {
    expect(askProviderName(geminiSettings)).toBe("Google Gemini");
    expect(
      askProviderName({
        enabled: true,
        apiKey: "key",
        provider: "openai-compatible",
        baseUrl: OPENROUTER_BASE_URL,
      }),
    ).toBe("OpenRouter");
    expect(
      askProviderName({
        enabled: true,
        apiKey: "key",
        provider: "openai-compatible",
        baseUrl: "https://example.com/v1",
      }),
    ).toBe("your custom endpoint");
    expect(askProviderName(null)).toBe("this provider");
  });
});

describe("askDisclosureLine", () => {
  it("counts distinct notes and pluralises", () => {
    expect(askDisclosureLine([excerpt("n1", 0), excerpt("n1", 1)], "Google Gemini")).toBe(
      "Sent excerpts from 1 note to Google Gemini. Your index and notes stay on this device.",
    );
    expect(askDisclosureLine([excerpt("n1", 0), excerpt("n2", 0)], "OpenRouter")).toBe(
      "Sent excerpts from 2 notes to OpenRouter. Your index and notes stay on this device.",
    );
  });
});

describe("askThreadReducer", () => {
  it("appends the question and marks the thread busy", () => {
    const state = threadWith({ type: "submitted", question: "What did I plan?" });
    expect(state.busy).toBe(true);
    expect(state.entries).toEqual([{ kind: "question", id: 1, text: "What did I plan?" }]);
  });

  it("refuses a second submit while one is in flight", () => {
    const busy = threadWith({ type: "submitted", question: "First?" });
    expect(askThreadReducer(busy, { type: "submitted", question: "Second?" })).toBe(busy);
  });

  it("appends the answer, clears busy, and keeps ids monotonic", () => {
    const state = threadWith(
      { type: "submitted", question: "First?" },
      { type: "answered", entry: answerEntry("answer", "One.") },
      { type: "submitted", question: "Second?" },
      { type: "answered", entry: answerEntry("answer", "Two.") },
    );
    expect(state.busy).toBe(false);
    expect(state.entries.map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
    expect(state.entries.map((entry) => entry.kind)).toEqual([
      "question",
      "answer",
      "question",
      "answer",
    ]);
  });

  it("clears back to the initial state", () => {
    const state = threadWith(
      { type: "submitted", question: "First?" },
      { type: "answered", entry: answerEntry("answer", "One.") },
    );
    expect(askThreadReducer(state, { type: "cleared" })).toEqual(initialAskThreadState);
  });
});

describe("previousTurnOf", () => {
  it("is undefined without a completed answer", () => {
    expect(previousTurnOf([])).toBeUndefined();
    expect(
      previousTurnOf(threadWith({ type: "submitted", question: "Q?" }).entries),
    ).toBeUndefined();
    const refused = threadWith(
      { type: "submitted", question: "Q?" },
      { type: "answered", entry: answerEntry("refusal") },
    );
    expect(previousTurnOf(refused.entries)).toBeUndefined();
    const errored = threadWith(
      { type: "submitted", question: "Q?" },
      { type: "answered", entry: answerEntry("error") },
    );
    expect(previousTurnOf(errored.entries)).toBeUndefined();
  });

  it("returns the pair for a completed answer", () => {
    const state = threadWith(
      { type: "submitted", question: "Q?" },
      { type: "answered", entry: answerEntry("answer", "A.") },
    );
    expect(previousTurnOf(state.entries)).toEqual({ question: "Q?", answer: "A." });
  });

  it("returns only the immediately previous pair", () => {
    const state = threadWith(
      { type: "submitted", question: "First?" },
      { type: "answered", entry: answerEntry("answer", "One.") },
      { type: "submitted", question: "Second?" },
      { type: "answered", entry: answerEntry("answer", "Two.") },
    );
    expect(previousTurnOf(state.entries)).toEqual({ question: "Second?", answer: "Two." });
  });
});

describe("citationSegments", () => {
  const citations = [
    { n: 1, noteId: "n1", chunkIndex: 0 },
    { n: 2, noteId: "n2", chunkIndex: 3 },
  ];

  it("leaves citation-free text as one segment", () => {
    expect(citationSegments("Plain text.", [])).toEqual([{ kind: "text", text: "Plain text." }]);
    expect(citationSegments("", [])).toEqual([{ kind: "text", text: "" }]);
  });

  it("splits validated markers into chips", () => {
    expect(citationSegments("Rent is due [1] monthly, see [2].", citations)).toEqual([
      { kind: "text", text: "Rent is due " },
      { kind: "citation", n: 1, noteId: "n1", chunkIndex: 0 },
      { kind: "text", text: " monthly, see " },
      { kind: "citation", n: 2, noteId: "n2", chunkIndex: 3 },
      { kind: "text", text: "." },
    ]);
  });

  it("chips every occurrence of a repeated citation", () => {
    expect(citationSegments("[1] and again [1]", citations)).toEqual([
      { kind: "citation", n: 1, noteId: "n1", chunkIndex: 0 },
      { kind: "text", text: " and again " },
      { kind: "citation", n: 1, noteId: "n1", chunkIndex: 0 },
    ]);
  });

  it("keeps unvalidated markers as literal text", () => {
    expect(citationSegments("See [9] and [1].", citations)).toEqual([
      { kind: "text", text: "See [9] and " },
      { kind: "citation", n: 1, noteId: "n1", chunkIndex: 0 },
      { kind: "text", text: "." },
    ]);
  });
});

describe("sourceCardsFor", () => {
  it("builds one card per cited note, from its first cited chunk", () => {
    const sent = [excerpt("n1", 0, "first"), excerpt("n1", 1, "second"), excerpt("n2", 0, "other")];
    const cards = sourceCardsFor(sent, [
      { n: 1, noteId: "n1", chunkIndex: 1 },
      { n: 2, noteId: "n1", chunkIndex: 0 },
      { n: 3, noteId: "n2", chunkIndex: 0 },
    ]);
    expect(cards).toEqual([
      { noteId: "n1", chunkIndex: 1, title: "Title of n1", text: "second" },
      { noteId: "n2", chunkIndex: 0, title: "Title of n2", text: "other" },
    ]);
  });

  it("drops a citation whose excerpt is missing instead of rendering an empty card", () => {
    expect(sourceCardsFor([], [{ n: 1, noteId: "gone", chunkIndex: 0 }])).toEqual([]);
  });
});

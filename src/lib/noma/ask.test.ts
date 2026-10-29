// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_MAX_INPUT_CHARS,
  getAiEmbeddingTarget,
  saveAiRecord,
  type AiEmbeddingTarget,
} from "./ai";
import {
  ASK_EXCERPT_BUDGET_CHARS,
  ASK_MAX_EXCERPTS,
  ASK_REFUSAL_SENTENCE,
  buildAskPrompt,
  parseAskAnswer,
  retrieveChunks,
  type AskExcerpt,
} from "./ask";
import type { NomaDatabase } from "./db";
import { fnv1a, providerKeyFor } from "./semantic";
import type { Note, NoteChunk } from "./types";

const OWNER = "user-1";
const API_KEY = "<redacted>";

const FAKE_LOCK: Note["lock"] = {
  v: 1,
  slots: {},
  biometric: false,
  failedAttempts: 0,
  lockoutUntil: 1,
  lockedAt: 1,
};

/* ---------------- Storage stand-in (same pattern as semantic.test.ts) ---------------- */

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  clear(): void {
    this.values.clear();
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: new MemoryStorage(), dispatchEvent: () => true },
    configurable: true,
  });
  vi.unstubAllGlobals();
});

/* ---------------- Fake chunk table + db (mirrors semantic.test.ts) ---------------- */

class FakeChunkTable {
  rows = new Map<string, NoteChunk>();
  async put(row: NoteChunk): Promise<string> {
    this.rows.set(row.id, structuredClone(row));
    return row.id;
  }
  async toArray(): Promise<NoteChunk[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
}

class FakeDb {
  noteChunks = new FakeChunkTable();
}

function asDb(fake: FakeDb): NomaDatabase {
  return fake as unknown as NomaDatabase;
}

function baseNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "n1",
    title: "Rain notes",
    content: "<p>Heavy rain all week.</p>",
    contentFormat: "tiptap-html",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    folderId: null,
    tagIds: [],
    pinned: false,
    favorite: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    reminderAt: null,
    wordCount: 4,
    ...overrides,
  };
}

function geminiTarget(): AiEmbeddingTarget {
  saveAiRecord(OWNER, {
    enabled: true,
    activePreset: "gemini",
    providers: { gemini: { apiKey: API_KEY } },
  });
  const target = getAiEmbeddingTarget(OWNER);
  if (!target) throw new Error("expected a gemini embedding target");
  return target;
}

/** A chunk row as the index build would have written it. */
function chunkRow(
  target: AiEmbeddingTarget,
  noteId: string,
  chunkIndex: number,
  vector: number[],
  text = `chunk ${chunkIndex} of ${noteId}`,
  providerKey = providerKeyFor(target, vector.length),
): NoteChunk {
  return {
    id: `${noteId}#${chunkIndex}`,
    noteId,
    chunkIndex,
    providerKey,
    dims: vector.length,
    vector: new Float32Array(vector),
    contentHash: fnv1a(text),
    text,
    updatedAt: 1,
  };
}

/**
 * Stubs the Gemini batch-embeddings endpoint: every requested text is
 * embedded by `vectorFor`. The question in these tests is always
 * embedded as [1, 0], so a stored chunk vector [s, 0] scores exactly s.
 */
function stubEmbedFetch(vectorFor: (text: string) => number[]): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      calls.push(body);
      const parsed = JSON.parse(body) as {
        requests?: Array<{ content: { parts: Array<{ text: string }> } }>;
      };
      const texts = (parsed.requests ?? []).map((r) => r.content.parts[0]!.text);
      return new Response(
        JSON.stringify({ embeddings: texts.map((text) => ({ values: vectorFor(text) })) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  return { calls };
}

function excerpt(overrides: Partial<AskExcerpt> = {}): AskExcerpt {
  return {
    noteId: "n1",
    chunkIndex: 0,
    title: "Rain notes",
    text: "Heavy rain all week.",
    similarity: 0.9,
    ...overrides,
  };
}

/* ---------------- Retrieval ---------------- */

describe("retrieveChunks", () => {
  it("ranks by similarity, keeps the floor, and drops what scores below it", async () => {
    stubEmbedFetch(() => [1, 0]);
    const target = geminiTarget();
    const db = new FakeDb();
    const notes = new Map<string, Note>([
      ["a", baseNote({ id: "a", title: "Alpha" })],
      ["b", baseNote({ id: "b", title: "Beta" })],
      ["c", baseNote({ id: "c", title: "Gamma" })],
      ["d", baseNote({ id: "d", title: "Delta" })],
    ]);
    await db.noteChunks.put(chunkRow(target, "b", 0, [0.8, 0.6], "beta chunk"));
    await db.noteChunks.put(chunkRow(target, "a", 0, [1, 0], "alpha chunk"));
    await db.noteChunks.put(chunkRow(target, "c", 0, [0, 1], "gamma chunk"));
    await db.noteChunks.put(chunkRow(target, "d", 0, [0.5, 0.5], "delta chunk"));

    const out = await retrieveChunks(asDb(db), "monsoon?", target, notes);
    // sims: a = 1, b = 0.8, d = 0.5 (exactly the floor — kept), c = 0 (dropped).
    expect(out.map((e) => e.noteId)).toEqual(["a", "b", "d"]);
    expect(out[0]!.similarity).toBeCloseTo(1);
    expect(out[1]!.similarity).toBeCloseTo(0.8);
    expect(out[2]!.similarity).toBeCloseTo(0.5);
    expect(out[0]).toMatchObject({ title: "Alpha", text: "alpha chunk", chunkIndex: 0 });
  });

  it("caps at two chunks per note — the best two, not the first two", async () => {
    stubEmbedFetch(() => [1, 0]);
    const target = geminiTarget();
    const db = new FakeDb();
    const notes = new Map([["a", baseNote({ id: "a" })]]);
    // chunkIndex order is NOT similarity order on purpose.
    await db.noteChunks.put(chunkRow(target, "a", 0, [0.96, 0]));
    await db.noteChunks.put(chunkRow(target, "a", 1, [0.99, 0]));
    await db.noteChunks.put(chunkRow(target, "a", 2, [0.98, 0]));
    await db.noteChunks.put(chunkRow(target, "a", 3, [0.97, 0]));

    const out = await retrieveChunks(asDb(db), "q", target, notes);
    expect(out.map((e) => e.chunkIndex)).toEqual([1, 2]);
  });

  it("caps the total at six excerpts across notes", async () => {
    stubEmbedFetch(() => [1, 0]);
    const target = geminiTarget();
    const db = new FakeDb();
    const notes = new Map<string, Note>();
    const sims: Record<string, number[]> = {
      a: [0.99, 0.98],
      b: [0.97, 0.96],
      c: [0.95, 0.94],
      d: [0.93, 0.92],
      e: [0.91, 0.9],
    };
    for (const [id, pair] of Object.entries(sims)) {
      notes.set(id, baseNote({ id }));
      await db.noteChunks.put(chunkRow(target, id, 0, [pair[0]!, 0]));
      await db.noteChunks.put(chunkRow(target, id, 1, [pair[1]!, 0]));
    }

    const out = await retrieveChunks(asDb(db), "q", target, notes);
    expect(out).toHaveLength(ASK_MAX_EXCERPTS);
    expect(out.map((e) => e.noteId)).toEqual(["a", "a", "b", "b", "c", "c"]);
  });

  it("re-checks eligibility against the live notes: locked, trashed, template and missing notes never surface", async () => {
    stubEmbedFetch(() => [1, 0]);
    const target = geminiTarget();
    const db = new FakeDb();
    // Every chunk below scores a perfect 1 — each was indexed while
    // its note was eligible. Only the note's CURRENT state may let it
    // through.
    const notes = new Map<string, Note>([
      ["ok", baseNote({ id: "ok" })],
      ["locked", baseNote({ id: "locked", lock: FAKE_LOCK })],
      ["trashed", baseNote({ id: "trashed", deleted: true, deletedAt: 1 })],
      ["template", baseNote({ id: "template", isTemplate: true })],
      // "ghost" deliberately absent: deleted outright after indexing.
    ]);
    for (const id of ["ok", "locked", "trashed", "template", "ghost"]) {
      await db.noteChunks.put(chunkRow(target, id, 0, [1, 0], `${id} chunk`));
    }

    const out = await retrieveChunks(asDb(db), "q", target, notes);
    expect(out.map((e) => e.noteId)).toEqual(["ok"]);
  });

  it("never scores rows from another embedding space or with mismatched dims", async () => {
    stubEmbedFetch(() => [1, 0]);
    const target = geminiTarget();
    const db = new FakeDb();
    const notes = new Map([["a", baseNote({ id: "a" })]]);
    await db.noteChunks.put(
      chunkRow(target, "a", 0, [1, 0], "other model chunk", "gemini|native|other-model|2"),
    );
    await db.noteChunks.put(chunkRow(target, "a", 1, [1, 0, 0], "three-dim chunk"));

    const out = await retrieveChunks(asDb(db), "q", target, notes);
    expect(out).toEqual([]);
  });

  it("returns nothing — and embeds nothing — for a blank question, no target, or an empty index", async () => {
    const { calls } = stubEmbedFetch(() => [1, 0]);
    const target = geminiTarget();
    const db = new FakeDb();
    const notes = new Map([["a", baseNote({ id: "a" })]]);
    await db.noteChunks.put(chunkRow(target, "a", 0, [1, 0]));

    expect(await retrieveChunks(asDb(db), "   ", target, notes)).toEqual([]);
    expect(await retrieveChunks(asDb(db), "q", null, notes)).toEqual([]);
    expect(calls).toHaveLength(0);

    const emptyDb = new FakeDb();
    expect(await retrieveChunks(asDb(emptyDb), "q", target, notes)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

/* ---------------- Prompt assembly ---------------- */

describe("buildAskPrompt", () => {
  it("numbers excerpts in order under their note titles and carries the refusal instruction verbatim", () => {
    const excerpts = [
      excerpt({ noteId: "a", title: "Alpha", text: "alpha text" }),
      excerpt({ noteId: "b", chunkIndex: 2, title: "Beta", text: "beta text" }),
    ];
    const { prompt, excerpts: used } = buildAskPrompt("When does it rain?", excerpts);
    expect(used).toEqual(excerpts);
    expect(prompt).toContain(`[1] From "Alpha": alpha text`);
    expect(prompt).toContain(`[2] From "Beta": beta text`);
    expect(prompt).toContain(
      `reply with exactly this sentence and nothing else: ${ASK_REFUSAL_SENTENCE}`,
    );
    expect(prompt).toContain("Answer in the language of the question.");
    expect(prompt.endsWith("Question: When does it rain?")).toBe(true);
    expect(prompt.length).toBeLessThanOrEqual(AI_MAX_INPUT_CHARS);
  });

  it("sheds the lowest-ranked chunks whole to meet the excerpt sub-budget", () => {
    const big = "x".repeat(7_000);
    const excerpts = [
      excerpt({ noteId: "a", title: "First", text: big }),
      excerpt({ noteId: "b", title: "Second", text: big }),
      excerpt({ noteId: "c", title: "Third", text: big }),
    ];
    const { prompt, excerpts: used } = buildAskPrompt("q", excerpts);
    // 3 × 7000 > 16000; 2 × 7000 fits. The third is dropped, not cut.
    expect(used.map((e) => e.noteId)).toEqual(["a", "b"]);
    expect(prompt).not.toContain(`From "Third"`);
    expect(prompt).toContain(`[2] From "Second"`);
    expect(prompt.length).toBeLessThanOrEqual(AI_MAX_INPUT_CHARS);
  });

  it("middle-truncates a lone oversized chunk instead of dropping it", () => {
    const excerpts = [excerpt({ text: "y".repeat(20_000) })];
    const { prompt, excerpts: used } = buildAskPrompt("q", excerpts);
    expect(used).toHaveLength(1);
    expect(used[0]!.text.length).toBeLessThanOrEqual(ASK_EXCERPT_BUDGET_CHARS);
    expect(used[0]!.text).toContain("middle of the note omitted for length");
    expect(prompt.length).toBeLessThanOrEqual(AI_MAX_INPUT_CHARS);
  });

  it("holds the total cap even when the question itself is huge", () => {
    const excerpts = [excerpt({ text: "z".repeat(ASK_EXCERPT_BUDGET_CHARS) })];
    const { prompt } = buildAskPrompt("w".repeat(10_000), excerpts);
    expect(prompt.length).toBeLessThanOrEqual(AI_MAX_INPUT_CHARS);
  });

  it("includes the previous turn, labelled as conversation, when budget remains", () => {
    const { prompt } = buildAskPrompt("follow-up?", [excerpt()], {
      question: "When does it rain?",
      answer: "In June [1].",
    });
    expect(prompt).toContain("Earlier conversation (context only — not evidence):");
    expect(prompt).toContain("Q: When does it rain?");
    expect(prompt).toContain("A: In June [1].");
    // The conversation block sits before the evidence, never inside it.
    expect(prompt.indexOf("Earlier conversation")).toBeLessThan(
      prompt.indexOf("Excerpts from the user's notes:"),
    );
  });

  it("omits the previous turn when the excerpts leave no budget for it", () => {
    const excerpts = [
      excerpt({ noteId: "a", text: "x".repeat(8_000) }),
      excerpt({ noteId: "b", text: "x".repeat(8_000) }),
    ];
    const { prompt } = buildAskPrompt("q".repeat(7_000), excerpts, {
      question: "earlier question",
      answer: "a".repeat(1_500),
    });
    expect(prompt).not.toContain("Earlier conversation");
    expect(prompt.length).toBeLessThanOrEqual(AI_MAX_INPUT_CHARS);
  });

  it("truncates an over-long previous turn to its budget instead of dropping it", () => {
    const { prompt } = buildAskPrompt("q", [excerpt()], {
      question: "earlier",
      answer: "a".repeat(5_000),
    });
    expect(prompt).toContain("Earlier conversation (context only — not evidence):");
    expect(prompt).toContain("middle of the note omitted for length");
    expect(prompt.length).toBeLessThanOrEqual(AI_MAX_INPUT_CHARS);
  });
});

/* ---------------- Answer parsing ---------------- */

describe("parseAskAnswer", () => {
  const excerpts = [
    excerpt({ noteId: "a", chunkIndex: 0 }),
    excerpt({ noteId: "b", chunkIndex: 2 }),
    excerpt({ noteId: "a", chunkIndex: 1 }),
  ];

  it("maps citations to their source chunks, deduplicated in first-use order", () => {
    const result = parseAskAnswer(
      "Beta says so [2]. Alpha agrees [1], and again [2]. Alpha's later chunk adds detail [3].",
      excerpts,
    );
    expect(result).toEqual({
      status: "answer",
      text: "Beta says so [2]. Alpha agrees [1], and again [2]. Alpha's later chunk adds detail [3].",
      citations: [
        { n: 2, noteId: "b", chunkIndex: 2 },
        { n: 1, noteId: "a", chunkIndex: 0 },
        { n: 3, noteId: "a", chunkIndex: 1 },
      ],
    });
  });

  it("strips hallucinated citation numbers instead of rendering them", () => {
    const result = parseAskAnswer("True [1], invented [9], zero [0].", [excerpts[0]!]);
    expect(result.status).toBe("answer");
    if (result.status !== "answer") throw new Error("expected an answer");
    expect(result.text).toContain("[1]");
    expect(result.text).not.toContain("[9]");
    expect(result.text).not.toContain("[0]");
    expect(result.citations).toEqual([{ n: 1, noteId: "a", chunkIndex: 0 }]);
  });

  it("detects the refusal sentence, even wrapped in extra whitespace", () => {
    expect(parseAskAnswer(ASK_REFUSAL_SENTENCE, excerpts)).toEqual({ status: "refusal" });
    expect(parseAskAnswer(`\n  ${ASK_REFUSAL_SENTENCE}\n`, excerpts)).toEqual({
      status: "refusal",
    });
  });

  it("does not mistake a longer sentence that merely starts alike for the refusal", () => {
    const result = parseAskAnswer(
      "I couldn't find that in your notes about taxes, but the budget note covers it [1].",
      excerpts,
    );
    expect(result.status).toBe("answer");
  });
});

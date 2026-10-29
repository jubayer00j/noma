// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import {
  AI_ERROR_MESSAGES,
  AiError,
  GEMINI_MODEL,
  OPENAI_PRESETS,
  OPENROUTER_BASE_URL,
  aiActionsAvailable,
  aiProviderSettingsChanged,
  aiSlotChanged,
  askNotes,
  clearAiSettings,
  embedTexts,
  embeddingCapabilityForPreset,
  getAiEmbeddingTarget,
  getAiRecord,
  getAiSettings,
  normalizeAiRecord,
  normalizeBaseUrl,
  noteEligibleForAi,
  parseSummaryBlocks,
  parseTagSuggestions,
  prepareNoteText,
  projectAiSettings,
  resolveAiPreset,
  saveAiRecord,
  saveAiSettings,
  suggestTags,
  summarizeNote,
  summaryTextToHtml,
  testAiConnection,
  truncateMiddle,
} from "./ai";
import { ASK_REFUSAL_SENTENCE, type AskExcerpt } from "./ask";
import { buildBackupZip, readBackupZip } from "./backup";
import { sanitizeHtml } from "./sanitize";
import { disconnectDrive } from "./drive";
import { type NomaDatabase } from "./db";
import type {
  AppSettings,
  AttachmentMeta,
  Folder,
  Note,
  NoteLock,
  Reminder,
  SyncTombstone,
  Tag,
} from "./types";

const FAKE_LOCK: NoteLock = {
  v: 1,
  slots: {},
  biometric: false,
  failedAttempts: 0,
  lockoutUntil: null,
  lockedAt: 1,
};

/* ---------------- Storage stand-in (same pattern as backup-encryption tests) ---------------- */

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

const OWNER = "user-1";
const API_KEY = "AIza-test-secret-key-1234567890";

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage: new MemoryStorage(), dispatchEvent: () => true },
    configurable: true,
    writable: true,
  });
  vi.unstubAllGlobals();
});

/* ---------------- Fake Dexie surface (mirrors backup-encryption.test.ts) ---------------- */

type Row = { id: string };

class FakeTable<T extends Row> {
  rows = new Map<string, T>();
  async get(id: string): Promise<T | undefined> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : undefined;
  }
  async put(row: T): Promise<string> {
    this.rows.set(row.id, structuredClone(row));
    return row.id;
  }
  async bulkPut(rows: T[]): Promise<void> {
    for (const row of rows) this.rows.set(row.id, structuredClone(row));
  }
  async update(id: string, patch: Partial<T>): Promise<number> {
    const current = this.rows.get(id);
    if (!current) return 0;
    this.rows.set(id, { ...current, ...patch });
    return 1;
  }
  async delete(id: string): Promise<void> {
    this.rows.delete(id);
  }
  async bulkDelete(ids: string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
  async clear(): Promise<void> {
    this.rows.clear();
  }
  async count(): Promise<number> {
    return this.rows.size;
  }
  async toArray(): Promise<T[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }
  filter(fn: (row: T) => boolean) {
    return {
      toArray: async () => [...this.rows.values()].filter(fn).map((row) => structuredClone(row)),
    };
  }
  where(field: string) {
    const matches = (value: unknown) =>
      [...this.rows.values()].filter(
        (row) => (row as unknown as Record<string, unknown>)[field] === value,
      );
    return {
      equals: (value: unknown) => ({
        toArray: async () => matches(value).map((row) => structuredClone(row)),
        count: async () => matches(value).length,
        delete: async () => {
          const found = matches(value);
          for (const row of found) this.rows.delete(row.id);
          return found.length;
        },
      }),
    };
  }
}

class FakeDb {
  name = "noma_test";
  notes = new FakeTable<Note>();
  folders = new FakeTable<Folder>();
  tags = new FakeTable<Tag>();
  attachments = new FakeTable<AttachmentMeta>();
  reminders = new FakeTable<Reminder>();
  settings = new FakeTable<AppSettings>();
  backups = new FakeTable<Row & { createdAt: number }>();
  tombstones = new FakeTable<SyncTombstone>();

  async transaction(...args: unknown[]): Promise<void> {
    const fn = args[args.length - 1] as () => Promise<void>;
    await fn();
  }
}

function asDb(fake: FakeDb): NomaDatabase {
  return fake as unknown as NomaDatabase;
}

function baseNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "n1",
    title: "Trip notes",
    content: "<p>Pack the camera.</p>",
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
    wordCount: 3,
    ...overrides,
  };
}

/* ---------------- Fetch mocking ---------------- */

interface FetchCall {
  url: string;
  init: RequestInit;
}

function stubFetch(
  handler: (call: FetchCall) => Promise<Response> | Response,
): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (url: unknown, init?: RequestInit) => {
    const call: FetchCall = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", mock);
  return { calls };
}

function geminiResponse(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function statusResponse(status: number): Response {
  return new Response(JSON.stringify({ error: { message: "nope" } }), { status });
}

/* ---------------- Record storage ---------------- */

describe("AI settings record storage", () => {
  it("round-trips through localStorage keyed per account", () => {
    saveAiSettings(OWNER, { enabled: true, apiKey: API_KEY });
    expect(getAiSettings(OWNER)).toEqual({ enabled: true, apiKey: API_KEY });
    expect(getAiSettings("someone-else")).toBeNull();
    expect(getAiSettings(null)).toBeNull();

    saveAiSettings(null, { enabled: false, apiKey: "guest-key" });
    expect(getAiSettings(null)).toEqual({ enabled: false, apiKey: "guest-key" });
    // Guest and account records are independent.
    expect(getAiSettings(OWNER)).toEqual({ enabled: true, apiKey: API_KEY });
  });

  it("stores the enable flag in the same record (nothing in AppSettings)", () => {
    saveAiSettings(OWNER, { enabled: false, apiKey: API_KEY });
    expect(getAiSettings(OWNER)?.enabled).toBe(false);
    saveAiSettings(OWNER, { enabled: true, apiKey: API_KEY });
    expect(getAiSettings(OWNER)?.enabled).toBe(true);
  });

  it("returns null for a malformed record and clears cleanly", () => {
    const store = window.localStorage;
    store.setItem(`noma-ai-v1-${OWNER}`, "{not json");
    expect(getAiSettings(OWNER)).toBeNull();
    store.setItem(`noma-ai-v1-${OWNER}`, JSON.stringify({ enabled: true }));
    expect(getAiSettings(OWNER)).toBeNull();

    saveAiSettings(OWNER, { enabled: true, apiKey: API_KEY });
    clearAiSettings(OWNER);
    expect(getAiSettings(OWNER)).toBeNull();
  });

  it("is cleared when Drive disconnects (the sign-out path shares it)", async () => {
    saveAiSettings(OWNER, { enabled: true, apiKey: API_KEY });
    window.localStorage.setItem(
      `noma-drive-v1-${OWNER}`,
      JSON.stringify({
        email: "a@example.com",
        connectedAt: 1,
        folderId: "folder1",
        backupFileId: "file1",
        lastBackupAt: 1,
        lastSignature: null,
      }),
    );
    await disconnectDrive(OWNER);
    expect(getAiSettings(OWNER)).toBeNull();
  });
});

/* ---------------- The key never reaches a backup (release gate) ---------------- */

describe("AI key containment", () => {
  it("a backup built with a key record present contains the key nowhere", async () => {
    saveAiSettings(OWNER, { enabled: true, apiKey: API_KEY });
    const db = new FakeDb();
    await db.notes.put(baseNote());

    const { blob } = await buildBackupZip(asDb(db), OWNER);

    // Raw bytes (in case entries are stored uncompressed)…
    const rawText = new TextDecoder("latin1").decode(await blob.arrayBuffer());
    expect(rawText).not.toContain(API_KEY);

    // …and every decompressed entry inside the ZIP.
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const names = Object.keys(zip.files);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const entry = zip.files[name];
      if (!entry || entry.dir) continue;
      const text = await entry.async("string");
      expect(text, `entry ${name}`).not.toContain(API_KEY);
    }

    // The parsed payload (settings included) is clean too.
    const payload = await readBackupZip(blob, OWNER);
    expect(JSON.stringify(payload)).not.toContain(API_KEY);
  });
});

/* ---------------- Gating predicate ---------------- */

describe("AI gating predicate", () => {
  const on = { enabled: true, apiKey: API_KEY };

  it("allows an ordinary note only when enabled with a key", () => {
    const note = baseNote();
    expect(aiActionsAvailable(note, on)).toBe(true);
    expect(aiActionsAvailable(note, null)).toBe(false);
    expect(aiActionsAvailable(note, { enabled: false, apiKey: API_KEY })).toBe(false);
    expect(aiActionsAvailable(note, { enabled: true, apiKey: "" })).toBe(false);
    expect(aiActionsAvailable(note, { enabled: true, apiKey: "   " })).toBe(false);
  });

  it("never allows locked, template, or trashed notes", () => {
    expect(noteEligibleForAi(baseNote())).toBe(true);
    expect(noteEligibleForAi(baseNote({ lock: FAKE_LOCK }))).toBe(false);
    expect(noteEligibleForAi(baseNote({ isTemplate: true }))).toBe(false);
    expect(noteEligibleForAi(baseNote({ deleted: true, deletedAt: 1 }))).toBe(false);
    expect(aiActionsAvailable(baseNote({ lock: FAKE_LOCK }), on)).toBe(false);
    expect(aiActionsAvailable(baseNote({ isTemplate: true }), on)).toBe(false);
    expect(aiActionsAvailable(baseNote({ deleted: true }), on)).toBe(false);
  });
});

/* ---------------- Text preparation ---------------- */

describe("text preparation", () => {
  it("extracts plain text from note HTML", () => {
    const { text, truncated } = prepareNoteText("<p>Hello <strong>world</strong></p>");
    expect(text).toBe("Hello world");
    expect(truncated).toBe(false);
  });

  it("middle-truncates over-long text, keeping head and tail", () => {
    const long = `HEAD-${"a".repeat(30_000)}-TAIL`;
    const { text, truncated } = truncateMiddle(long);
    expect(truncated).toBe(true);
    expect(text.startsWith("HEAD-")).toBe(true);
    expect(text.endsWith("-TAIL")).toBe(true);
    expect(text).toContain("omitted for length");
    expect(text.length).toBeLessThan(long.length);

    const short = truncateMiddle("brief");
    expect(short).toEqual({ text: "brief", truncated: false });
  });
});

/* ---------------- Gemini client (mocked fetch) ---------------- */

describe("Gemini client", () => {
  it("sends the documented request shape and extracts the reply text", async () => {
    const { calls } = stubFetch(() => geminiResponse("A tidy summary."));
    const result = await summarizeNote(API_KEY, { title: "Trip notes", text: "Pack the camera." });
    expect(result).toEqual({ summary: "A tidy summary.", truncated: false });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    );
    expect(GEMINI_MODEL).toBe("gemini-3.5-flash-lite");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(API_KEY);
    const body = JSON.parse(String(init.body)) as {
      contents: { parts: { text: string }[] }[];
    };
    expect(body.contents[0]!.parts[0]!.text).toContain("Trip notes");
    expect(body.contents[0]!.parts[0]!.text).toContain("Pack the camera.");
  });

  it("joins multi-part replies and honours a per-record model override", async () => {
    const { calls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "one " }, { text: "two" }] } }],
          }),
          { status: 200 },
        ),
    );
    const ok = await testAiConnection(API_KEY, { enabled: true, apiKey: API_KEY, model: "custom-model" });
    expect(ok).toBe(true);
    expect(calls[0]!.url).toContain("/models/custom-model:generateContent");
  });

  it("flags truncation for over-long notes", async () => {
    stubFetch(() => geminiResponse("Summary."));
    const result = await summarizeNote(API_KEY, { title: "Big", text: "x".repeat(30_000) });
    expect(result.truncated).toBe(true);
  });

  it("throws no-key without calling fetch when the key is blank", async () => {
    const { calls } = stubFetch(() => geminiResponse("never"));
    const error = await summarizeNote("  ", { title: "t", text: "body" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).kind).toBe("no-key");
    expect(calls).toHaveLength(0);
  });

  it("maps failures to calm AiError kinds", async () => {
    const cases: { name: string; handler: () => Promise<Response> | Response; kind: string }[] = [
      { name: "network failure", handler: () => Promise.reject(new TypeError("fetch failed")), kind: "offline" },
      { name: "429", handler: () => statusResponse(429), kind: "rate-limited" },
      { name: "400", handler: () => statusResponse(400), kind: "invalid-key" },
      { name: "401", handler: () => statusResponse(401), kind: "invalid-key" },
      { name: "403", handler: () => statusResponse(403), kind: "invalid-key" },
      { name: "500", handler: () => statusResponse(500), kind: "transient" },
      {
        name: "malformed JSON body",
        handler: () => new Response("{oops", { status: 200 }),
        kind: "bad-response",
      },
      {
        name: "no candidates field",
        handler: () => new Response(JSON.stringify({}), { status: 200 }),
        kind: "bad-response",
      },
      {
        name: "empty candidates",
        handler: () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
        kind: "empty",
      },
      {
        name: "blank text part",
        handler: () => geminiResponse("   "),
        kind: "empty",
      },
    ];
    for (const testCase of cases) {
      stubFetch(testCase.handler);
      const error = await testAiConnection(API_KEY).catch((e: unknown) => e);
      expect(error, testCase.name).toBeInstanceOf(AiError);
      expect((error as AiError).kind, testCase.name).toBe(testCase.kind);
      expect((error as AiError).message, testCase.name).toBe(
        AI_ERROR_MESSAGES[testCase.kind as keyof typeof AI_ERROR_MESSAGES],
      );
    }
  });

  it("treats a note with no text as a calm empty error before any call", async () => {
    const { calls } = stubFetch(() => geminiResponse("never"));
    const error = await summarizeNote(API_KEY, { title: "", text: "   " }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).kind).toBe("empty");
    expect((error as AiError).message).toContain("no text");
    expect(calls).toHaveLength(0);
  });

  it("surfaces Google's real error instead of the generic line", async () => {
    const errorEnvelope = (status: number, message: string): Response =>
      new Response(JSON.stringify({ error: { code: status, message, status: "FAILED" } }), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    // 404 names the configured model, so a retired model id is diagnosable.
    stubFetch(() => errorEnvelope(404, "models/gemini-2.5-flash is not found."));
    const notFound = await testAiConnection(API_KEY).catch((e: unknown) => e);
    expect((notFound as AiError).kind).toBe("model-unavailable");
    expect((notFound as AiError).message).toContain(GEMINI_MODEL);

    // …and the per-record override, not the pinned default.
    stubFetch(() => errorEnvelope(404, "not found"));
    const customModel = await testAiConnection(API_KEY, {
      enabled: true,
      apiKey: API_KEY,
      model: "custom-model",
    }).catch((e: unknown) => e);
    expect((customModel as AiError).kind).toBe("model-unavailable");
    expect((customModel as AiError).message).toContain("custom-model");

    // 502/503 are transient, whatever the envelope says.
    for (const status of [502, 503]) {
      stubFetch(() => errorEnvelope(status, "The model is overloaded."));
      const busy = await testAiConnection(API_KEY).catch((e: unknown) => e);
      expect((busy as AiError).kind).toBe("transient");
      expect((busy as AiError).message).toBe(AI_ERROR_MESSAGES["transient"]);
    }

    // Unmapped statuses surface Google's message verbatim (capped).
    stubFetch(() => errorEnvelope(422, "Something specific went wrong."));
    const apiError = await testAiConnection(API_KEY).catch((e: unknown) => e);
    expect((apiError as AiError).kind).toBe("api-error");
    expect((apiError as AiError).message).toContain("Something specific went wrong.");

    // A very long envelope message is capped, never pasted whole.
    stubFetch(() => errorEnvelope(422, "x".repeat(500)));
    const capped = await testAiConnection(API_KEY).catch((e: unknown) => e);
    expect((capped as AiError).kind).toBe("api-error");
    expect((capped as AiError).message.endsWith("…")).toBe(true);
    expect((capped as AiError).message.length).toBeLessThan(300);

    // A non-JSON body on an unmapped status falls back to generic, never throws.
    stubFetch(() => new Response("{oops", { status: 422 }));
    const nonJson = await testAiConnection(API_KEY).catch((e: unknown) => e);
    expect((nonJson as AiError).kind).toBe("bad-response");
    expect((nonJson as AiError).message).toBe(AI_ERROR_MESSAGES["bad-response"]);

    // A JSON body with no error message also falls back to generic.
    stubFetch(() => new Response(JSON.stringify({}), { status: 422 }));
    const noMessage = await testAiConnection(API_KEY).catch((e: unknown) => e);
    expect((noMessage as AiError).kind).toBe("bad-response");

    // A message echoing the key is never surfaced.
    stubFetch(() => errorEnvelope(422, `bad key ${API_KEY} here`));
    const keyEcho = await testAiConnection(API_KEY).catch((e: unknown) => e);
    expect((keyEcho as AiError).kind).toBe("bad-response");
    expect((keyEcho as AiError).message).not.toContain(API_KEY);
  });
});

/* ---------------- Tag suggestions ---------------- */

describe("tag suggestions", () => {
  it("requests JSON-only tags and parses the reply", async () => {
    const { calls } = stubFetch(() => geminiResponse('["travel", "photography"]'));
    const result = await suggestTags(API_KEY, {
      title: "Trip notes",
      text: "Pack the camera.",
      existingTagNames: ["travel", "work"],
      currentTagNames: [],
    });
    expect(result.tags).toEqual(["travel", "photography"]);
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      contents: { parts: { text: string }[] }[];
    };
    expect(body.contents[0]!.parts[0]!.text).toContain("JSON array");
    expect(body.contents[0]!.parts[0]!.text).toContain("travel, work");
  });

  it("parses fenced JSON and filters invalid entries", () => {
    expect(parseTagSuggestions('```json\n["Work", " ideas "]\n```')).toEqual(["Work", "ideas"]);
    expect(parseTagSuggestions('Here you go: ["a"] hope that helps')).toEqual(["a"]);
    expect(parseTagSuggestions("not json at all")).toEqual([]);
    // The first JSON array in the reply wins, even inside an object envelope.
    expect(parseTagSuggestions('{"tags": ["a"]}')).toEqual(["a"]);
    expect(parseTagSuggestions('[1, true, null, "ok"]')).toEqual(["ok"]);
    expect(parseTagSuggestions('["#hash", "##double"]')).toEqual(["hash", "double"]);
    expect(parseTagSuggestions(`["${"x".repeat(41)}", "fits"]`)).toEqual(["fits"]);
    expect(parseTagSuggestions('["", "  ", "real"]')).toEqual(["real"]);
  });

  it("dedupes case-insensitively, excludes current tags, and caps at 5", () => {
    expect(parseTagSuggestions('["Work", "work", "WORK"]')).toEqual(["Work"]);
    expect(parseTagSuggestions('["Work", "new"]', ["work"])).toEqual(["new"]);
    expect(parseTagSuggestions('["#Work"]', ["work"])).toEqual([]);
    expect(parseTagSuggestions('["1", "2", "3", "4", "5", "6", "7"]')).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });
});

/* ---------------- Summary rendering safety ---------------- */

describe("summary rendering", () => {
  it("parses the fixed format into paragraph + bullet blocks", () => {
    const blocks = parseSummaryBlocks(
      "The note plans a trip to the coast.\n\n- Book the train\n- Pack the camera",
    );
    expect(blocks).toEqual([
      { type: "paragraph", text: "The note plans a trip to the coast." },
      { type: "bullets", items: ["Book the train", "Pack the camera"] },
    ]);
  });

  it("escapes model output so markup stays inert text", () => {
    const evil = 'Summary <script>alert("x")</script> here.\n\n- <b>bold</b> point';
    const html = summaryTextToHtml(evil);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("survives the sanitize round-trip as inert text (what updateNote does on insert)", () => {
    const evil = 'Text <img src=x onerror=alert(1)> and <script>alert(2)</script>.';
    const inserted = `${summaryTextToHtml(evil)}<hr><p>Original body</p>`;
    const stored = sanitizeHtml(inserted);
    // Safety property: the payload produced no elements or attributes —
    // it survives only as escaped, inert text (the literal characters
    // "onerror" inside a text node are harmless and expected).
    const doc = new DOMParser().parseFromString(stored, "text/html");
    expect(doc.querySelector("script")).toBeNull();
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector("[onerror]")).toBeNull();
    expect(stored).toContain("Original body");
    // The escaped payload remains visible as literal text, not markup.
    const text = doc.body.textContent ?? "";
    expect(text).toContain('<img src=x onerror=alert(1)>');
  });
});

/* ---------------- OpenAI-compatible client ---------------- */

describe("OpenAI-compatible client", () => {
  const GROQ_SETTINGS = {
    enabled: true,
    apiKey: API_KEY,
    provider: "openai-compatible" as const,
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
  };

  function chatResponse(text: string, status = 200): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  function chatError(status: number, message: string): Response {
    return new Response(JSON.stringify({ error: { message, code: "x", type: "t" } }), {
      status,
    });
  }

  it("sends the chat-completions shape with a Bearer key", async () => {
    const { calls } = stubFetch(() => chatResponse("A tidy summary."));
    const result = await summarizeNote(
      API_KEY,
      { title: "Trip notes", text: "Pack the camera." },
      GROQ_SETTINGS,
    );
    expect(result).toEqual({ summary: "A tidy summary.", truncated: false });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe("llama-3.3-70b-versatile");
    expect(body.messages[0]!.role).toBe("user");
    expect(body.messages[0]!.content).toContain("Pack the camera.");
  });

  it("sends OpenRouter identification headers only for OpenRouter", async () => {
    (globalThis as unknown as { window: Record<string, unknown> }).window["location"] = {
      origin: "https://noma.test",
    };
    const openRouterSettings = {
      ...GROQ_SETTINGS,
      baseUrl: OPENROUTER_BASE_URL,
      model: "openai/gpt-4o-mini",
    };
    const { calls: openRouterCalls } = stubFetch(() => chatResponse("ok"));
    await testAiConnection(API_KEY, openRouterSettings);
    const openRouterHeaders = openRouterCalls[0]!.init.headers as Record<string, string>;
    expect(openRouterHeaders["X-Title"]).toBe("Noma");
    expect(openRouterHeaders["HTTP-Referer"]).toBe("https://noma.test");

    const { calls: groqCalls } = stubFetch(() => chatResponse("ok"));
    await testAiConnection(API_KEY, GROQ_SETTINGS);
    const groqHeaders = groqCalls[0]!.init.headers as Record<string, string>;
    expect(groqHeaders["X-Title"]).toBeUndefined();
    expect(groqHeaders["HTTP-Referer"]).toBeUndefined();
  });

  it("joins parts-array content and reports empty choices as empty", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [
                    { type: "text", text: "one " },
                    { type: "text", text: "two" },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const ok = await testAiConnection(API_KEY, GROQ_SETTINGS);
    expect(ok).toBe(true);

    stubFetch(() => new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    const empty = await testAiConnection(API_KEY, GROQ_SETTINGS).catch((e: unknown) => e);
    expect((empty as AiError).kind).toBe("empty");

    stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const malformed = await testAiConnection(API_KEY, GROQ_SETTINGS).catch((e: unknown) => e);
    expect((malformed as AiError).kind).toBe("bad-response");
  });

  it("maps provider failures to the shared kinds with neutral messages", async () => {
    const cases: { name: string; handler: () => Response; kind: string; match?: string }[] = [
      { name: "401", handler: () => chatError(401, "bad key"), kind: "invalid-key" },
      { name: "429", handler: () => chatError(429, "slow down"), kind: "rate-limited" },
      {
        name: "404 names the model",
        handler: () => chatError(404, "not found"),
        kind: "model-unavailable",
        match: "llama-3.3-70b-versatile",
      },
      { name: "503", handler: () => chatError(503, "overloaded"), kind: "transient" },
      {
        name: "envelope message carried",
        handler: () => chatError(418, "provider says no"),
        kind: "api-error",
        match: "provider says no",
      },
      {
        name: "non-JSON error body falls back",
        handler: () => new Response("{oops", { status: 418 }),
        kind: "bad-response",
      },
    ];
    for (const testCase of cases) {
      stubFetch(testCase.handler);
      const error = await testAiConnection(API_KEY, GROQ_SETTINGS).catch((e: unknown) => e);
      expect(error, testCase.name).toBeInstanceOf(AiError);
      expect((error as AiError).kind, testCase.name).toBe(testCase.kind);
      if (testCase.match) {
        expect((error as AiError).message, testCase.name).toContain(testCase.match);
      }
      expect((error as AiError).message, testCase.name).not.toContain("Gemini");
    }
  });

  it("routes a record without a provider to Gemini, unchanged", async () => {
    const { calls } = stubFetch(() => geminiResponse("ready"));
    const ok = await testAiConnection(API_KEY, { enabled: true, apiKey: API_KEY });
    expect(ok).toBe(true);
    expect(calls[0]!.url).toContain("generativelanguage.googleapis.com");
  });

  it("refuses insecure endpoints and missing models before any fetch", async () => {
    const { calls: httpCalls } = stubFetch(() => chatResponse("never"));
    const httpError = await testAiConnection(API_KEY, {
      ...GROQ_SETTINGS,
      baseUrl: "http://api.example.com/v1",
    }).catch((e: unknown) => e);
    expect((httpError as AiError).message).toContain("https://");
    expect(httpCalls).toHaveLength(0);

    const { calls: modelCalls } = stubFetch(() => chatResponse("never"));
    const modelError = await testAiConnection(API_KEY, {
      ...GROQ_SETTINGS,
      model: "   ",
    }).catch((e: unknown) => e);
    expect((modelError as AiError).message).toContain("model");
    expect(modelCalls).toHaveLength(0);
  });
});

/* ---------------- Presets + record shape ---------------- */

describe("AI provider presets", () => {
  it("every preset endpoint is https with no trailing slash; custom stays blank", () => {
    expect(OPENAI_PRESETS.length).toBeGreaterThan(0);
    for (const preset of OPENAI_PRESETS) {
      if (preset.id === "custom") {
        expect(preset.baseUrl).toBe("");
        expect(preset.defaultModel).toBe("");
      } else {
        expect(preset.baseUrl.startsWith("https://")).toBe(true);
        expect(preset.baseUrl.endsWith("/")).toBe(false);
        expect(preset.defaultModel.length).toBeGreaterThan(0);
      }
    }
  });

  it("resolves stored records to presets, unknown URLs to custom", () => {
    expect(resolveAiPreset("gemini", undefined)).toBe("gemini");
    expect(resolveAiPreset(undefined, undefined)).toBe("gemini");
    expect(resolveAiPreset("openai-compatible", "https://api.groq.com/openai/v1/")).toBe("groq");
    expect(resolveAiPreset("openai-compatible", "https://api.example.com/v1")).toBe("custom");
    expect(normalizeBaseUrl("https://api.example.com/v1///")).toBe("https://api.example.com/v1");
  });

  it("round-trips provider fields and drops unknown provider values", () => {
    saveAiSettings(OWNER, {
      enabled: true,
      apiKey: API_KEY,
      provider: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
    });
    expect(getAiSettings(OWNER)).toEqual({
      enabled: true,
      apiKey: API_KEY,
      provider: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
    });

    const store = (globalThis.window as unknown as { localStorage: MemoryStorage }).localStorage;
    store.setItem(
      `noma-ai-v1-${OWNER}`,
      JSON.stringify({ enabled: true, apiKey: API_KEY, provider: "bogus" }),
    );
    expect(getAiSettings(OWNER)).toEqual({ enabled: true, apiKey: API_KEY });
  });
});

/* ---------------- Draft-vs-saved provider comparison (saved-key Save button) ---------------- */

describe("aiProviderSettingsChanged", () => {
  const groq = {
    enabled: true,
    apiKey: API_KEY,
    provider: "openai-compatible" as const,
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
  };
  const gemini = { enabled: true, apiKey: API_KEY, provider: "gemini" as const };

  it("identical records are not dirty", () => {
    expect(aiProviderSettingsChanged(groq, { ...groq })).toBe(false);
    expect(aiProviderSettingsChanged(gemini, { ...gemini })).toBe(false);
  });

  it("a provider change is dirty in either direction", () => {
    expect(aiProviderSettingsChanged(gemini, groq)).toBe(true);
    expect(aiProviderSettingsChanged(groq, gemini)).toBe(true);
  });

  it("an endpoint or model change is dirty, but trailing slashes and padding are not", () => {
    expect(
      aiProviderSettingsChanged(groq, { ...groq, baseUrl: "https://api.example.com/v1" }),
    ).toBe(true);
    expect(aiProviderSettingsChanged(groq, { ...groq, baseUrl: groq.baseUrl + "/" })).toBe(false);
    expect(aiProviderSettingsChanged(groq, { ...groq, model: "other-model" })).toBe(true);
    expect(aiProviderSettingsChanged(groq, { ...groq, model: ` ${groq.model} ` })).toBe(false);
  });

  it("a Gemini record with no model override is not dirty against a Gemini draft", () => {
    expect(aiProviderSettingsChanged(gemini, { ...gemini })).toBe(false);
    expect(aiProviderSettingsChanged(null, { ...gemini })).toBe(false);
    expect(aiProviderSettingsChanged(null, groq)).toBe(true);
  });
});

/* ---------------- The key never reaches a backup, any provider ---------------- */

describe("AI key containment (OpenAI-compatible record)", () => {
  it("a backup built with an OpenAI-compatible key record contains the key nowhere", async () => {
    saveAiSettings(OWNER, {
      enabled: true,
      apiKey: API_KEY,
      provider: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
    });
    const db = new FakeDb();
    await db.notes.put(baseNote());

    const { blob } = await buildBackupZip(asDb(db), OWNER);

    const rawText = new TextDecoder("latin1").decode(await blob.arrayBuffer());
    expect(rawText).not.toContain(API_KEY);

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (!entry || entry.dir) continue;
      const text = await entry.async("string");
      expect(text, `entry ${name}`).not.toContain(API_KEY);
    }

    const payload = await readBackupZip(blob, OWNER);
    expect(JSON.stringify(payload)).not.toContain(API_KEY);
  });
});

/* ---------------- Per-provider key slots: migration ---------------- */

describe("AI record migration (single-key → per-provider slots)", () => {
  function seedRaw(value: unknown) {
    window.localStorage.setItem(`noma-ai-v1-${OWNER}`, JSON.stringify(value));
  }

  it("migrates a legacy Gemini record into the gemini slot, active", () => {
    seedRaw({ enabled: true, apiKey: API_KEY });
    expect(getAiRecord(OWNER)).toEqual({
      enabled: true,
      activePreset: "gemini",
      providers: { gemini: { apiKey: API_KEY } },
    });
    // The projection is byte-for-byte the old reader's answer.
    expect(getAiSettings(OWNER)).toEqual({ enabled: true, apiKey: API_KEY });
  });

  it("migrates a legacy Gemini model override into the gemini slot", () => {
    seedRaw({ enabled: true, apiKey: API_KEY, provider: "gemini", model: "gemini-custom" });
    expect(getAiRecord(OWNER)?.providers["gemini"]).toEqual({
      apiKey: API_KEY,
      model: "gemini-custom",
    });
    expect(getAiSettings(OWNER)).toEqual({
      enabled: true,
      apiKey: API_KEY,
      model: "gemini-custom",
    });
  });

  it("migrates a legacy OpenAI-compatible record into its preset slot", () => {
    seedRaw({
      enabled: true,
      apiKey: "sk-groq-legacy",
      provider: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1/",
      model: "llama-3.3-70b-versatile",
    });
    expect(getAiRecord(OWNER)).toEqual({
      enabled: true,
      activePreset: "groq",
      providers: { groq: { apiKey: "sk-groq-legacy", model: "llama-3.3-70b-versatile" } },
    });
    // Projection restores the preset's constant endpoint (stored URL
    // had a trailing slash) and the slot's model.
    expect(getAiSettings(OWNER)).toEqual({
      enabled: true,
      apiKey: "sk-groq-legacy",
      provider: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
    });
  });

  it("migrates an unmatched legacy endpoint into the custom slot, URL kept", () => {
    seedRaw({
      enabled: false,
      apiKey: "sk-custom-legacy",
      provider: "openai-compatible",
      baseUrl: "https://llm.example.com/v1/",
      model: "house-model",
    });
    expect(getAiRecord(OWNER)).toEqual({
      enabled: false,
      activePreset: "custom",
      providers: {
        custom: {
          apiKey: "sk-custom-legacy",
          model: "house-model",
          baseUrl: "https://llm.example.com/v1",
        },
      },
    });
    expect(getAiSettings(OWNER)?.baseUrl).toBe("https://llm.example.com/v1");
  });

  it("treats an unknown legacy provider as Gemini, and a keyless record as no record", () => {
    seedRaw({ enabled: true, apiKey: API_KEY, provider: "bogus" });
    expect(getAiRecord(OWNER)?.activePreset).toBe("gemini");

    seedRaw({ enabled: true });
    expect(getAiRecord(OWNER)).toBeNull();
    expect(getAiSettings(OWNER)).toBeNull();
  });

  it("is idempotent: normalizing a migrated record changes nothing", () => {
    const legacy = {
      enabled: true,
      apiKey: "sk-or-legacy",
      provider: "openai-compatible",
      baseUrl: OPENROUTER_BASE_URL,
      model: "openai/gpt-4o-mini",
    };
    const once = normalizeAiRecord(legacy);
    expect(once).not.toBeNull();
    expect(normalizeAiRecord(once)).toEqual(once);
    // And a stored round-trip through the record API is stable.
    seedRaw(legacy);
    const migrated = getAiRecord(OWNER);
    saveAiRecord(OWNER, migrated);
    expect(getAiRecord(OWNER)).toEqual(migrated);
  });
});

/* ---------------- Per-provider key slots: save / switch / remove ---------------- */

describe("AI per-provider slots", () => {
  const GEMINI_KEY = "AIza-gemini-key-0001";
  const OR_KEY = "sk-or-openrouter-key-0002";

  function twoProviderRecord() {
    saveAiRecord(OWNER, {
      enabled: true,
      activePreset: "gemini",
      providers: { gemini: { apiKey: GEMINI_KEY } },
    });
    // Saving a second provider's slot (the Settings flow) must not
    // disturb the first.
    const current = getAiRecord(OWNER)!;
    saveAiRecord(OWNER, {
      ...current,
      activePreset: "openrouter",
      providers: {
        ...current.providers,
        openrouter: { apiKey: OR_KEY, model: "openai/gpt-4o-mini" },
      },
    });
  }

  it("keeps each provider's key separate and projects the active slot", () => {
    twoProviderRecord();
    expect(getAiSettings(OWNER)).toEqual({
      enabled: true,
      apiKey: OR_KEY,
      provider: "openai-compatible",
      baseUrl: OPENROUTER_BASE_URL,
      model: "openai/gpt-4o-mini",
    });

    // Switch back: the Gemini key is intact, no re-entry.
    const current = getAiRecord(OWNER)!;
    saveAiRecord(OWNER, { ...current, activePreset: "gemini" });
    expect(getAiSettings(OWNER)).toEqual({ enabled: true, apiKey: GEMINI_KEY });
    expect(getAiRecord(OWNER)?.providers["openrouter"]?.apiKey).toBe(OR_KEY);
  });

  it("removing one provider's slot never affects the others", () => {
    twoProviderRecord();
    const current = getAiRecord(OWNER)!;
    const providers = { ...current.providers };
    delete providers["openrouter"];
    saveAiRecord(OWNER, { ...current, providers });
    expect(getAiRecord(OWNER)?.providers["gemini"]?.apiKey).toBe(GEMINI_KEY);
    expect(getAiRecord(OWNER)?.providers["openrouter"]).toBeUndefined();
  });

  it("replacing a slot's key leaves the other slots and the flag alone", () => {
    twoProviderRecord();
    const current = getAiRecord(OWNER)!;
    saveAiRecord(OWNER, {
      ...current,
      providers: {
        ...current.providers,
        gemini: { apiKey: "AIza-gemini-key-replaced" },
      },
    });
    const after = getAiRecord(OWNER)!;
    expect(after.providers["gemini"]?.apiKey).toBe("AIza-gemini-key-replaced");
    expect(after.providers["openrouter"]?.apiKey).toBe(OR_KEY);
    expect(after.enabled).toBe(true);
  });

  it("projects a named preset's default model when its slot stored none", () => {
    expect(
      projectAiSettings({
        enabled: true,
        activePreset: "groq",
        providers: { groq: { apiKey: "sk-groq" } },
      }),
    ).toEqual({
      enabled: true,
      apiKey: "sk-groq",
      provider: "openai-compatible",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "llama-3.3-70b-versatile",
    });
  });

  it("a flat saveAiSettings write lands in its own slot and preserves the rest", () => {
    saveAiSettings(OWNER, { enabled: true, apiKey: GEMINI_KEY });
    saveAiSettings(OWNER, {
      enabled: true,
      apiKey: OR_KEY,
      provider: "openai-compatible",
      baseUrl: OPENROUTER_BASE_URL,
      model: "openai/gpt-4o-mini",
    });
    const record = getAiRecord(OWNER)!;
    expect(record.providers["gemini"]?.apiKey).toBe(GEMINI_KEY);
    expect(record.providers["openrouter"]?.apiKey).toBe(OR_KEY);
    expect(record.activePreset).toBe("openrouter");
  });
});

/* ---------------- aiSlotChanged ---------------- */

describe("aiSlotChanged", () => {
  it("an unchanged slot is not dirty; a missing slot equals an empty one", () => {
    const slot = { apiKey: "sk-1", model: "m1" };
    expect(aiSlotChanged(slot, { ...slot })).toBe(false);
    expect(aiSlotChanged(undefined, undefined)).toBe(false);
    expect(aiSlotChanged(undefined, { apiKey: "" })).toBe(false);
  });

  it("a key, model, or endpoint change is dirty; padding and slashes are not", () => {
    const slot = { apiKey: "sk-1", model: "m1", baseUrl: "https://llm.example.com/v1" };
    expect(aiSlotChanged(slot, { ...slot, apiKey: "sk-2" })).toBe(true);
    expect(aiSlotChanged(slot, { ...slot, apiKey: " sk-1 " })).toBe(false);
    expect(aiSlotChanged(slot, { ...slot, model: "m2" })).toBe(true);
    expect(aiSlotChanged(slot, { ...slot, baseUrl: "https://other.example.com/v1" })).toBe(true);
    expect(aiSlotChanged(slot, { ...slot, baseUrl: "https://llm.example.com/v1/" })).toBe(false);
  });

  it("an unset model compares as the preset default", () => {
    expect(
      aiSlotChanged({ apiKey: "sk-1" }, { apiKey: "sk-1", model: "gpt-4o-mini" }, "gpt-4o-mini"),
    ).toBe(false);
    expect(
      aiSlotChanged({ apiKey: "sk-1", model: "other" }, { apiKey: "sk-1" }, "gpt-4o-mini"),
    ).toBe(true);
  });
});

/* ---------------- The keys never reach a backup, however many providers ---------------- */

describe("AI key containment (multiple provider slots)", () => {
  it("a backup built with several providers' keys stored contains none of them", async () => {
    const keys = [
      "AIza-gemini-secret-AAAA",
      "sk-or-openrouter-secret-BBBB",
      "sk-custom-secret-CCCC",
    ];
    saveAiRecord(OWNER, {
      enabled: true,
      activePreset: "openrouter",
      providers: {
        gemini: { apiKey: keys[0]! },
        openrouter: { apiKey: keys[1]!, model: "openai/gpt-4o-mini" },
        custom: { apiKey: keys[2]!, baseUrl: "https://llm.example.com/v1", model: "house-model" },
      },
    });
    const db = new FakeDb();
    await db.notes.put(baseNote());

    const { blob } = await buildBackupZip(asDb(db), OWNER);

    const rawText = new TextDecoder("latin1").decode(await blob.arrayBuffer());
    for (const key of keys) expect(rawText).not.toContain(key);

    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (!entry || entry.dir) continue;
      const text = await entry.async("string");
      for (const key of keys) expect(text, `entry ${name}`).not.toContain(key);
    }

    const payload = await readBackupZip(blob, OWNER);
    for (const key of keys) expect(JSON.stringify(payload)).not.toContain(key);
  });
});

/* ---------------- Embeddings: slot storage + target resolution (#8.5) ---------------- */

describe("embedding model slot storage", () => {
  it("round-trips a slot's embeddingModel through the record", () => {
    saveAiRecord(OWNER, {
      enabled: true,
      activePreset: "openai",
      providers: {
        openai: { apiKey: API_KEY, model: "gpt-4o-mini", embeddingModel: "text-embedding-3-large" },
      },
    });
    expect(getAiRecord(OWNER)?.providers["openai"]?.embeddingModel).toBe("text-embedding-3-large");
    // The chat projection is unchanged by the extra slot field.
    expect(getAiSettings(OWNER)).toEqual({
      enabled: true,
      apiKey: API_KEY,
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
    });
  });

  it("loads records written before embeddingModel existed, unchanged", () => {
    window.localStorage.setItem(
      `noma-ai-v1-${OWNER}`,
      JSON.stringify({
        enabled: true,
        activePreset: "gemini",
        providers: { gemini: { apiKey: API_KEY } },
      }),
    );
    const record = getAiRecord(OWNER);
    expect(record?.providers["gemini"]).toEqual({ apiKey: API_KEY });
  });

  it("carries embeddingModel through the flat saveAiSettings write", () => {
    saveAiSettings(OWNER, {
      enabled: true,
      apiKey: API_KEY,
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      embeddingModel: "text-embedding-3-small",
    } as Parameters<typeof saveAiSettings>[1]);
    expect(getAiRecord(OWNER)?.providers["openai"]?.embeddingModel).toBe("text-embedding-3-small");
  });

  it("counts an embedding-model edit as a slot change", () => {
    const saved = { apiKey: API_KEY, embeddingModel: "text-embedding-3-small" };
    expect(aiSlotChanged(saved, { ...saved })).toBe(false);
    expect(aiSlotChanged(saved, { ...saved, embeddingModel: "text-embedding-3-large" })).toBe(true);
    // An unset embedding model and the preset default are the same slot.
    expect(
      aiSlotChanged(
        { apiKey: API_KEY },
        { apiKey: API_KEY, embeddingModel: "text-embedding-3-small" },
        "",
        "text-embedding-3-small",
      ),
    ).toBe(false);
  });
});

describe("getAiEmbeddingTarget", () => {
  it("resolves the Gemini default target", () => {
    saveAiRecord(OWNER, {
      enabled: true,
      activePreset: "gemini",
      providers: { gemini: { apiKey: API_KEY } },
    });
    const target = getAiEmbeddingTarget(OWNER);
    expect(target?.presetId).toBe("gemini");
    expect(target?.mode).toBe("native");
    expect(target?.embeddingModel).toBe("gemini-embedding-001");
    expect(target?.settings.apiKey).toBe(API_KEY);
  });

  it("prefers the slot's saved embedding model over the default", () => {
    saveAiRecord(OWNER, {
      enabled: true,
      activePreset: "gemini",
      providers: { gemini: { apiKey: API_KEY, embeddingModel: "gemini-embedding-001" } },
    });
    expect(getAiEmbeddingTarget(OWNER)?.embeddingModel).toBe("gemini-embedding-001");
    saveAiRecord(OWNER, {
      enabled: true,
      activePreset: "openai",
      providers: { openai: { apiKey: API_KEY, embeddingModel: "text-embedding-3-large" } },
    });
    expect(getAiEmbeddingTarget(OWNER)?.embeddingModel).toBe("text-embedding-3-large");
  });

  it("is null when AI is off, keyless, or the preset has no embeddings service", () => {
    saveAiRecord(OWNER, {
      enabled: false,
      activePreset: "gemini",
      providers: { gemini: { apiKey: API_KEY } },
    });
    expect(getAiEmbeddingTarget(OWNER)).toBeNull();

    saveAiRecord(OWNER, { enabled: true, activePreset: "gemini", providers: {} });
    expect(getAiEmbeddingTarget(OWNER)).toBeNull();

    saveAiRecord(OWNER, {
      enabled: true,
      activePreset: "groq",
      providers: { groq: { apiKey: API_KEY } },
    });
    expect(getAiEmbeddingTarget(OWNER)).toBeNull();
    expect(embeddingCapabilityForPreset("groq").mode).toBe("none");
    expect(embeddingCapabilityForPreset("deepseek").mode).toBe("none");
  });

  it("is null for a compatible preset with no default until the user sets a model", () => {
    saveAiRecord(OWNER, {
      enabled: true,
      activePreset: "together",
      providers: { together: { apiKey: API_KEY } },
    });
    expect(getAiEmbeddingTarget(OWNER)).toBeNull();
    saveAiRecord(OWNER, {
      enabled: true,
      activePreset: "together",
      providers: { together: { apiKey: API_KEY, embeddingModel: "BAAI/bge-large-en-v1.5" } },
    });
    expect(getAiEmbeddingTarget(OWNER)?.embeddingModel).toBe("BAAI/bge-large-en-v1.5");
  });

  it("pins text-embedding-3-large as the OpenAI/OpenRouter embedding default", () => {
    saveAiRecord(OWNER, {
      enabled: true,
      activePreset: "openai",
      providers: { openai: { apiKey: API_KEY } },
    });
    expect(getAiEmbeddingTarget(OWNER)?.embeddingModel).toBe("text-embedding-3-large");
    saveAiRecord(OWNER, {
      enabled: true,
      activePreset: "openrouter",
      providers: { openrouter: { apiKey: API_KEY } },
    });
    expect(getAiEmbeddingTarget(OWNER)?.embeddingModel).toBe("openai/text-embedding-3-large");
  });
});

/* ---------------- Embeddings client (embedTexts) ---------------- */

function geminiEmbedResponse(vectors: number[][], status = 200): Response {
  return new Response(JSON.stringify({ embeddings: vectors.map((values) => ({ values })) }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function compatibleEmbedResponse(vectors: number[][], status = 200): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ index, embedding })),
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

describe("embedTexts — Gemini transport", () => {
  it("posts a batchEmbedContents request with task type and 768 dims, and normalises", async () => {
    const { calls } = stubFetch(() =>
      geminiEmbedResponse([
        [3, 4],
        [0, 2],
      ]),
    );
    const vectors = await embedTexts(
      { enabled: true, apiKey: API_KEY },
      ["first note", "second note"],
      "document",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
    );
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe(API_KEY);
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      requests: Array<{
        model: string;
        content: { parts: Array<{ text: string }> };
        taskType: string;
        outputDimensionality: number;
      }>;
    };
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0]).toEqual({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text: "first note" }] },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 768,
    });
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]![0]).toBeCloseTo(0.6);
    expect(vectors[0]![1]).toBeCloseTo(0.8);
    expect(vectors[1]![0]).toBeCloseTo(0);
    expect(vectors[1]![1]).toBeCloseTo(1);
  });

  it("uses RETRIEVAL_QUERY for query embeddings", async () => {
    const { calls } = stubFetch(() => geminiEmbedResponse([[1, 0]]));
    await embedTexts({ enabled: true, apiKey: API_KEY }, ["monsoon"], "query");
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      requests: Array<{ taskType: string }>;
    };
    expect(body.requests[0]!.taskType).toBe("RETRIEVAL_QUERY");
  });

  it("rejects malformed vectors and wrong counts as bad-response", async () => {
    stubFetch(() => geminiEmbedResponse([[1, 0]]));
    await expect(
      embedTexts({ enabled: true, apiKey: API_KEY }, ["a", "b"], "document"),
    ).rejects.toMatchObject({ kind: "bad-response" });

    stubFetch(
      () =>
        new Response(JSON.stringify({ embeddings: [{ values: [1, "nope"] }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      embedTexts({ enabled: true, apiKey: API_KEY }, ["a"], "document"),
    ).rejects.toMatchObject({ kind: "bad-response" });

    stubFetch(() => geminiEmbedResponse([[0, 0]]));
    await expect(
      embedTexts({ enabled: true, apiKey: API_KEY }, ["a"], "document"),
    ).rejects.toMatchObject({ kind: "bad-response" });
  });

  it("maps a 401 to invalid-key", async () => {
    stubFetch(() => statusResponse(401));
    await expect(
      embedTexts({ enabled: true, apiKey: API_KEY }, ["a"], "document"),
    ).rejects.toMatchObject({ kind: "invalid-key" });
  });
});

describe("embedTexts — OpenAI-compatible transport", () => {
  const openAiSettings = {
    enabled: true,
    apiKey: API_KEY,
    provider: "openai-compatible" as const,
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  };

  it("posts {model, input} to /embeddings with the preset default model", async () => {
    const { calls } = stubFetch(() =>
      compatibleEmbedResponse([
        [1, 0],
        [0, 1],
      ]),
    );
    const vectors = await embedTexts(openAiSettings, ["a", "b"], "document");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/embeddings");
    expect((calls[0]!.init.headers as Record<string, string>)["Authorization"]).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      model: "text-embedding-3-large",
      input: ["a", "b"],
    });
    expect(vectors).toHaveLength(2);
  });

  it("honours the response's index order and the OpenRouter identification headers", async () => {
    const { calls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const vectors = await embedTexts(
      {
        enabled: true,
        apiKey: API_KEY,
        provider: "openai-compatible",
        baseUrl: OPENROUTER_BASE_URL,
        model: "openai/gpt-4o-mini",
      },
      ["a", "b"],
      "query",
    );
    expect(vectors[0]![0]).toBeCloseTo(1);
    expect(vectors[1]![1]).toBeCloseTo(1);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Title"]).toBe("Noma");
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe("openai/text-embedding-3-large");
  });

  it("maps a 429 to rate-limited and rejects a short data array", async () => {
    stubFetch(() => statusResponse(429));
    await expect(embedTexts(openAiSettings, ["a"], "document")).rejects.toMatchObject({
      kind: "rate-limited",
    });

    stubFetch(() => compatibleEmbedResponse([[1, 0]]));
    await expect(embedTexts(openAiSettings, ["a", "b"], "document")).rejects.toMatchObject({
      kind: "bad-response",
    });
  });

  it("refuses a no-embeddings provider without any fetch", async () => {
    const { calls } = stubFetch(() => compatibleEmbedResponse([[1, 0]]));
    await expect(
      embedTexts(
        {
          enabled: true,
          apiKey: API_KEY,
          provider: "openai-compatible",
          baseUrl: "https://api.groq.com/openai/v1",
          model: "llama-3.3-70b-versatile",
        },
        ["a"],
        "document",
      ),
    ).rejects.toMatchObject({ kind: "bad-response" });
    expect(calls).toHaveLength(0);
  });
});

/* ---------------- Ask Noma generation (PR-B) ---------------- */

describe("Ask Noma generation", () => {
  const excerpts: AskExcerpt[] = [
    {
      noteId: "n1",
      chunkIndex: 0,
      title: "Monsoon plan",
      text: "The monsoon arrives in June.",
      similarity: 0.9,
    },
  ];

  function promptOf(call: FetchCall): string {
    const body = JSON.parse(String(call.init.body)) as {
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    return body.contents[0]!.parts[0]!.text;
  }

  it("answers from the excerpts, sends the grounded prompt, and maps citations back", async () => {
    const { calls } = stubFetch(() => geminiResponse("The monsoon arrives in June [1]."));
    const result = await askNotes(API_KEY, {
      question: "When does the monsoon arrive?",
      excerpts,
    });
    expect(result).toEqual({
      status: "answer",
      text: "The monsoon arrives in June [1].",
      citations: [{ n: 1, noteId: "n1", chunkIndex: 0 }],
    });
    expect(calls).toHaveLength(1);
    const prompt = promptOf(calls[0]!);
    expect(prompt).toContain(`[1] From "Monsoon plan": The monsoon arrives in June.`);
    expect(prompt).toContain(ASK_REFUSAL_SENTENCE);
    expect(prompt).toContain("Question: When does the monsoon arrive?");
  });

  it("returns no-evidence without calling the provider when there are no excerpts", async () => {
    const { calls } = stubFetch(() => geminiResponse("never"));
    const result = await askNotes(API_KEY, { question: "anything?", excerpts: [] });
    expect(result).toEqual({ status: "no-evidence" });
    expect(calls).toHaveLength(0);
  });

  it("surfaces the model's refusal as a typed refusal", async () => {
    stubFetch(() => geminiResponse(ASK_REFUSAL_SENTENCE));
    const result = await askNotes(API_KEY, { question: "unanswerable?", excerpts });
    expect(result).toEqual({ status: "refusal" });
  });

  it("keeps provider failures on the existing AiError kinds", async () => {
    const cases: { name: string; handler: () => Promise<Response> | Response; kind: string }[] = [
      {
        name: "network failure",
        handler: () => Promise.reject(new TypeError("fetch failed")),
        kind: "offline",
      },
      { name: "429", handler: () => statusResponse(429), kind: "rate-limited" },
      { name: "403", handler: () => statusResponse(403), kind: "invalid-key" },
      {
        name: "malformed JSON body",
        handler: () => new Response("{oops", { status: 200 }),
        kind: "bad-response",
      },
    ];
    for (const testCase of cases) {
      stubFetch(testCase.handler);
      const error = await askNotes(API_KEY, { question: "q", excerpts }).catch((e: unknown) => e);
      expect(error, testCase.name).toBeInstanceOf(AiError);
      expect((error as AiError).kind, testCase.name).toBe(testCase.kind);
    }
  });

  it("throws no-key without calling fetch when the key is blank", async () => {
    const { calls } = stubFetch(() => geminiResponse("never"));
    const error = await askNotes("  ", { question: "q", excerpts }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).kind).toBe("no-key");
    expect(calls).toHaveLength(0);
  });

  it("passes a previous turn into the prompt as labelled conversation", async () => {
    const { calls } = stubFetch(() => geminiResponse("Still June [1]."));
    const result = await askNotes(API_KEY, {
      question: "And when does it end?",
      excerpts,
      previousTurn: {
        question: "When does the monsoon arrive?",
        answer: "The monsoon arrives in June [1].",
      },
    });
    expect(result.status).toBe("answer");
    const prompt = promptOf(calls[0]!);
    expect(prompt).toContain("Earlier conversation (context only — not evidence):");
    expect(prompt).toContain("Q: When does the monsoon arrive?");
  });
});

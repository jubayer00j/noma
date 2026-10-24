// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import {
  AI_ERROR_MESSAGES,
  AiError,
  GEMINI_MODEL,
  aiActionsAvailable,
  clearAiSettings,
  getAiSettings,
  noteEligibleForAi,
  parseSummaryBlocks,
  parseTagSuggestions,
  prepareNoteText,
  saveAiSettings,
  suggestTags,
  summarizeNote,
  summaryTextToHtml,
  testAiConnection,
  truncateMiddle,
} from "./ai";
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
      { name: "500", handler: () => statusResponse(500), kind: "bad-response" },
      { name: "404", handler: () => statusResponse(404), kind: "bad-response" },
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

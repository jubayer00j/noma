import { beforeEach, describe, expect, it, vi } from "vitest";

/* Native-feel #10: the widget's note door (app.noma.notes://note/<id>).
 * The module keeps its registration flag in module state, so listener
 * tests load a fresh copy per test (vi.resetModules + dynamic import),
 * the shortcut.test.ts pattern. Routing is observed through the real
 * pending-open slot from notification-open.ts. */

const mocks = vi.hoisted(() => ({
  native: true,
  launchUrl: null as { url: string } | null,
  urlOpenListener: null as ((event: { url: string }) => void) | null,
  getLaunchUrlCalls: 0,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    getLaunchUrl: () => {
      mocks.getLaunchUrlCalls += 1;
      return Promise.resolve(mocks.launchUrl);
    },
    addListener: (_event: string, cb: (event: { url: string }) => void) => {
      mocks.urlOpenListener = cb;
      return Promise.resolve({ remove: () => {} });
    },
  },
}));

vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: { addListener: vi.fn(async () => ({ remove: async () => {} })) },
}));

const ID_A = "3f6b8f7e-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const ID_B = "9e107d9d-85a0-4c3d-b2a1-0f9e8d7c6b5a";

async function loadModule() {
  return import("./note-link");
}

/** The pending slot as the freshly loaded note-link sees it (same instance). */
async function pendingNoteId(): Promise<string | null> {
  const slot = await import("./notification-open");
  return slot.getPendingNoteOpen()?.noteId ?? null;
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.resetModules();
  mocks.native = true;
  mocks.launchUrl = null;
  mocks.urlOpenListener = null;
  mocks.getLaunchUrlCalls = 0;
});

describe("parseNoteLinkId — accepts", () => {
  it("accepts a note door URL with a UUID id", async () => {
    const { parseNoteLinkId } = await loadModule();
    expect(parseNoteLinkId(`app.noma.notes://note/${ID_A}`)).toBe(ID_A);
    expect(parseNoteLinkId(`app.noma.notes://note/${ID_B}`)).toBe(ID_B);
    // Upper-case hex is still a UUID shape.
    expect(parseNoteLinkId(`app.noma.notes://note/${ID_A.toUpperCase()}`)).toBe(ID_A.toUpperCase());
  });
});

describe("parseNoteLinkId — rejects", () => {
  it("rejects the other doors and foreign schemes", async () => {
    const { parseNoteLinkId } = await loadModule();
    expect(parseNoteLinkId("app.noma.notes://new-note")).toBeNull();
    expect(parseNoteLinkId("app.noma.notes://today")).toBeNull();
    expect(parseNoteLinkId(`https://note/${ID_A}`)).toBeNull();
    expect(parseNoteLinkId(`app.other.notes://note/${ID_A}`)).toBeNull();
    expect(parseNoteLinkId("app.noma.notes://note.evil.com/" + ID_A)).toBeNull();
  });

  it("rejects missing, malformed, or non-UUID ids", async () => {
    const { parseNoteLinkId } = await loadModule();
    expect(parseNoteLinkId("app.noma.notes://note")).toBeNull();
    expect(parseNoteLinkId("app.noma.notes://note/")).toBeNull();
    expect(parseNoteLinkId("app.noma.notes://note/abc")).toBeNull();
    expect(parseNoteLinkId("app.noma.notes://note/3f6b8f7e1a2b4c3d8e4f5a6b7c8d9e0f")).toBeNull();
    expect(parseNoteLinkId("app.noma.notes://note/3f6b8f7e-1a2b-4c3d-8e4f-5a6b7c8d9e0")).toBeNull();
    expect(
      parseNoteLinkId("app.noma.notes://note/zzzzzzzz-1a2b-4c3d-8e4f-5a6b7c8d9e0f"),
    ).toBeNull();
  });

  it("rejects extra path segments, query, and hash", async () => {
    const { parseNoteLinkId } = await loadModule();
    expect(parseNoteLinkId(`app.noma.notes://note/${ID_A}/extra`)).toBeNull();
    expect(parseNoteLinkId(`app.noma.notes://note/${ID_A}/`)).toBeNull();
    expect(parseNoteLinkId(`app.noma.notes://note/${ID_A}?x=1`)).toBeNull();
    expect(parseNoteLinkId(`app.noma.notes://note/${ID_A}#frag`)).toBeNull();
  });

  it("rejects malformed input", async () => {
    const { parseNoteLinkId } = await loadModule();
    expect(parseNoteLinkId("")).toBeNull();
    expect(parseNoteLinkId("not a url")).toBeNull();
  });
});

describe("processNoteLinkUrl — routing into the pending-open slot", () => {
  it("parks a pending-open request for a valid note door", async () => {
    const { processNoteLinkUrl } = await loadModule();
    processNoteLinkUrl(`app.noma.notes://note/${ID_A}`);
    expect(await pendingNoteId()).toBe(ID_A);
  });

  it("ignores everything else — shortcuts are not this door's business", async () => {
    const { processNoteLinkUrl } = await loadModule();
    processNoteLinkUrl(undefined);
    processNoteLinkUrl("app.noma.notes://today");
    processNoteLinkUrl("app.noma.notes://new-note");
    processNoteLinkUrl("app.noma.notes://note/not-a-uuid");
    expect(await pendingNoteId()).toBeNull();
  });

  it("lets the newest tap win", async () => {
    const { processNoteLinkUrl } = await loadModule();
    processNoteLinkUrl(`app.noma.notes://note/${ID_A}`);
    processNoteLinkUrl(`app.noma.notes://note/${ID_B}`);
    expect(await pendingNoteId()).toBe(ID_B);
  });
});

describe("initNoteLinkListener — native wiring", () => {
  it("delivers a cold-start launch URL into the pending-open slot", async () => {
    mocks.launchUrl = { url: `app.noma.notes://note/${ID_A}` };
    const { initNoteLinkListener } = await loadModule();
    initNoteLinkListener();
    await flushPromises();
    expect(await pendingNoteId()).toBe(ID_A);
  });

  it("delivers warm appUrlOpen events and ignores invalid ones", async () => {
    const { initNoteLinkListener } = await loadModule();
    initNoteLinkListener();
    await flushPromises();
    expect(mocks.urlOpenListener).not.toBeNull();

    mocks.urlOpenListener?.({ url: "app.noma.notes://today" });
    expect(await pendingNoteId()).toBeNull();

    mocks.urlOpenListener?.({ url: `app.noma.notes://note/${ID_B}` });
    expect(await pendingNoteId()).toBe(ID_B);
  });

  it("registers only once", async () => {
    const { initNoteLinkListener } = await loadModule();
    initNoteLinkListener();
    initNoteLinkListener();
    await flushPromises();
    expect(mocks.getLaunchUrlCalls).toBe(1);
  });

  it("never touches the App plugin off native platforms", async () => {
    mocks.native = false;
    const { initNoteLinkListener } = await loadModule();
    initNoteLinkListener();
    await flushPromises();
    expect(mocks.getLaunchUrlCalls).toBe(0);
    expect(mocks.urlOpenListener).toBeNull();
  });
});

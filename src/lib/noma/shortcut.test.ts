import { beforeEach, describe, expect, it, vi } from "vitest";

/* Native-feel #9: the launcher-shortcut validator, slot, listener wiring
 * and PWA boot param. The module keeps its pending slot in module state,
 * so every test loads a fresh copy (vi.resetModules + dynamic import),
 * the splash-handoff pattern. */

const cap = vi.hoisted(() => ({
  nativePlatform: false,
  launchUrl: null as { url: string } | null,
  urlOpenListener: null as ((event: { url: string }) => void) | null,
  getLaunchUrlCalls: 0,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => cap.nativePlatform },
}));

vi.mock("@capacitor/app", () => ({
  App: {
    getLaunchUrl: () => {
      cap.getLaunchUrlCalls += 1;
      return Promise.resolve(cap.launchUrl);
    },
    addListener: (_event: string, cb: (event: { url: string }) => void) => {
      cap.urlOpenListener = cb;
      return Promise.resolve({ remove: () => {} });
    },
  },
}));

async function loadModule() {
  return import("./shortcut");
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const replacedUrls: string[] = [];

function setWindowSearch(search: string) {
  (globalThis as { window?: unknown }).window = {
    location: { search, pathname: "/", hash: "" },
    history: {
      state: null,
      replaceState: (_state: unknown, _title: string, url: string) => {
        replacedUrls.push(url);
      },
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  cap.nativePlatform = false;
  cap.launchUrl = null;
  cap.urlOpenListener = null;
  cap.getLaunchUrlCalls = 0;
  replacedUrls.length = 0;
  delete (globalThis as { window?: unknown }).window;
});

describe("parseShortcutAction — accepts", () => {
  it("accepts both allowlisted hosts, bare and trailing-slash", async () => {
    const { parseShortcutAction } = await loadModule();
    expect(parseShortcutAction("app.noma.notes://new-note")).toBe("new-note");
    expect(parseShortcutAction("app.noma.notes://new-note/")).toBe("new-note");
    expect(parseShortcutAction("app.noma.notes://today")).toBe("today");
    expect(parseShortcutAction("app.noma.notes://today/")).toBe("today");
  });
});

describe("parseShortcutAction — rejects", () => {
  it("rejects wrong schemes and unknown hosts", async () => {
    const { parseShortcutAction } = await loadModule();
    expect(parseShortcutAction("https://new-note")).toBeNull();
    expect(parseShortcutAction("app.noma.notes://search")).toBeNull();
    expect(parseShortcutAction("app.noma.notes://new-note.evil.com")).toBeNull();
    expect(parseShortcutAction("app.noma.notes://today.evil")).toBeNull();
    expect(parseShortcutAction("app.noma.notes://")).toBeNull();
  });

  it("rejects any query, hash, or non-empty path", async () => {
    const { parseShortcutAction } = await loadModule();
    expect(parseShortcutAction("app.noma.notes://today?x=1")).toBeNull();
    expect(parseShortcutAction("app.noma.notes://today#frag")).toBeNull();
    expect(parseShortcutAction("app.noma.notes://today/extra")).toBeNull();
    expect(parseShortcutAction("app.noma.notes://new-note/extra")).toBeNull();
    expect(parseShortcutAction("app.noma.notes://new-note/?capture=1")).toBeNull();
  });

  it("rejects malformed input", async () => {
    const { parseShortcutAction } = await loadModule();
    expect(parseShortcutAction("")).toBeNull();
    expect(parseShortcutAction("not a url")).toBeNull();
    expect(parseShortcutAction("app.noma.notes:today")).toBeNull();
  });
});

describe("isValidNewNoteUrl — compatibility export", () => {
  it("stays true only for the new-note link", async () => {
    const { isValidNewNoteUrl } = await loadModule();
    expect(isValidNewNoteUrl("app.noma.notes://new-note")).toBe(true);
    expect(isValidNewNoteUrl("app.noma.notes://new-note/")).toBe(true);
    expect(isValidNewNoteUrl("app.noma.notes://today")).toBe(false);
    expect(isValidNewNoteUrl("app.noma.notes://today?x=1")).toBe(false);
  });
});

describe("pending slot via processShortcutUrl", () => {
  it("parks a valid action and ignores anything else", async () => {
    const { processShortcutUrl, getPendingShortcutAction } = await loadModule();
    processShortcutUrl(undefined);
    processShortcutUrl("app.noma.notes://search");
    processShortcutUrl("https://today");
    expect(getPendingShortcutAction()).toBeNull();

    processShortcutUrl("app.noma.notes://today");
    expect(getPendingShortcutAction()).toBe("today");
  });
});

describe("initShortcutListener — native wiring", () => {
  it("delivers a cold-start launch URL into the slot", async () => {
    cap.nativePlatform = true;
    cap.launchUrl = { url: "app.noma.notes://today" };
    const { initShortcutListener, getPendingShortcutAction } = await loadModule();
    initShortcutListener();
    await flushPromises();
    expect(getPendingShortcutAction()).toBe("today");
  });

  it("delivers warm appUrlOpen events and ignores invalid ones", async () => {
    cap.nativePlatform = true;
    const { initShortcutListener, getPendingShortcutAction } = await loadModule();
    initShortcutListener();
    await flushPromises();
    expect(cap.urlOpenListener).not.toBeNull();

    cap.urlOpenListener?.({ url: "app.noma.notes://today?x=1" });
    expect(getPendingShortcutAction()).toBeNull();

    cap.urlOpenListener?.({ url: "app.noma.notes://new-note" });
    expect(getPendingShortcutAction()).toBe("new-note");
  });

  it("never touches the App plugin off native platforms", async () => {
    const { initShortcutListener } = await loadModule();
    initShortcutListener();
    await flushPromises();
    expect(cap.getLaunchUrlCalls).toBe(0);
    expect(cap.urlOpenListener).toBeNull();
  });
});

describe("checkWebShortcutParam — PWA boot routing", () => {
  it("routes ?shortcut=today into the pending slot and strips the param", async () => {
    setWindowSearch("?shortcut=today");
    const { checkWebShortcutParam, getPendingShortcutAction } = await loadModule();
    expect(checkWebShortcutParam()).toBe(true);
    expect(getPendingShortcutAction()).toBe("today");
    expect(replacedUrls).toEqual(["/"]);
  });

  it("keeps unrelated params when stripping", async () => {
    setWindowSearch("?shortcut=today&x=1");
    const { checkWebShortcutParam } = await loadModule();
    expect(checkWebShortcutParam()).toBe(true);
    expect(replacedUrls).toEqual(["/?x=1"]);
  });

  it("ignores unknown actions and other doors' params", async () => {
    const { checkWebShortcutParam, getPendingShortcutAction } = await loadModule();

    setWindowSearch("?shortcut=search");
    expect(checkWebShortcutParam()).toBe(false);

    setWindowSearch("?capture=new-note");
    expect(checkWebShortcutParam()).toBe(false);

    setWindowSearch("");
    expect(checkWebShortcutParam()).toBe(false);

    expect(getPendingShortcutAction()).toBeNull();
    expect(replacedUrls).toEqual([]);
  });

  it("is a no-op without a window", async () => {
    const { checkWebShortcutParam } = await loadModule();
    expect(checkWebShortcutParam()).toBe(false);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeCapture,
  dataUrlByteSize,
  enqueueCapture,
  getPendingCapture,
  normalizeSharePayload,
  plainTextToNoteHtml,
  resetCaptureStateForTests,
  MAX_SHARE_IMAGE_BYTES,
  type CaptureRequest,
} from "./capture";
import {
  checkPwaShortcutParam,
  checkWebShareBoot,
  drainNativeShares,
  storePendingWebShare,
  MAX_NATIVE_SHARE_DRAIN,
  WEB_SHARE_STORAGE_KEY,
  type NativeSharedContent,
} from "./share-target";

/* Minimal browser stand-ins: share-target.ts parks web shares in sessionStorage. */
class MemoryStorage {
  map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

const session = new MemoryStorage();
const replacedUrls: string[] = [];
(globalThis as { window?: unknown }).window = {
  sessionStorage: session,
  location: { search: "", pathname: "/", hash: "" },
  history: {
    state: null,
    replaceState: (_state: unknown, _title: string, url: string) => {
      replacedUrls.push(url);
    },
  },
};

const win = (globalThis as { window: { location: { search: string } } }).window;

function imageDataUrl(mimeType = "image/png", base64 = "AAAA"): string {
  return `data:${mimeType};base64,${base64}`;
}

describe("normalizeSharePayload — title", () => {
  it("prefers the subject over the page title", () => {
    const request = normalizeSharePayload(
      { subject: "  Subject wins  ", title: "Page title", text: "body" },
      "android-share",
      "id-1",
    );
    expect(request).toMatchObject({ kind: "share", title: "Subject wins" });
  });

  it("falls back to the page title and caps it at 200 chars", () => {
    const request = normalizeSharePayload(
      { subject: "   ", title: "x".repeat(250), text: "body" },
      "web-share",
      "id-2",
    );
    expect(request.kind).toBe("share");
    if (request.kind === "share") expect(request.title).toHaveLength(200);
  });
});

describe("normalizeSharePayload — text and URL", () => {
  it("does not append the URL twice when the text already contains it", () => {
    const request = normalizeSharePayload(
      { text: "Read https://example.com/a later", url: "https://example.com/a" },
      "web-share",
      "id-3",
    );
    expect(request.kind).toBe("share");
    if (request.kind === "share") {
      expect(request.content.match(/example\.com/g)).toHaveLength(1);
    }
  });

  it("appends a separate URL to the body when it is missing", () => {
    const request = normalizeSharePayload(
      { text: "Worth reading", url: "https://example.com/b" },
      "web-share",
      "id-4",
    );
    expect(request.kind).toBe("share");
    if (request.kind === "share") {
      expect(request.content).toContain("Worth reading");
      expect(request.content).toContain("https://example.com/b");
    }
  });

  it("promotes a bare-URL text to the URL and still shows it once", () => {
    const request = normalizeSharePayload(
      { text: "https://example.com/only" },
      "android-share",
      "id-5",
    );
    expect(request.kind).toBe("share");
    if (request.kind === "share") {
      expect(request.content).toBe("<p>https://example.com/only</p>");
    }
  });

  it("caps the body text at 100k chars", () => {
    const request = normalizeSharePayload(
      { text: "a".repeat(150_000) },
      "web-share",
      "id-6",
    );
    expect(request.kind).toBe("share");
    if (request.kind === "share") {
      expect(request.content.length).toBeLessThan(100_100);
      expect(request.content).toContain("a".repeat(1_000));
    }
  });
});

describe("plainTextToNoteHtml", () => {
  it("escapes markup so shared HTML arrives as inert text", () => {
    const html = plainTextToNoteHtml('<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toBe("<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
  });

  it("splits paragraphs on blank lines and breaks single newlines", () => {
    expect(plainTextToNoteHtml("one\ntwo\n\nthree")).toBe("<p>one<br>two</p><p>three</p>");
  });
});

describe("normalizeSharePayload — degradation and images", () => {
  it("degrades an empty payload to a plain new-note capture", () => {
    const request = normalizeSharePayload(
      { subject: " ", title: null, text: "  ", url: "" },
      "android-share",
      "id-7",
    );
    expect(request).toEqual({ kind: "new-note", source: "android-share", id: "id-7" });
  });

  it("keeps a title-only share as a share, not a new note", () => {
    const request = normalizeSharePayload({ subject: "Just a title" }, "web-share", "id-8");
    expect(request).toMatchObject({ kind: "share", title: "Just a title", content: "" });
  });

  it("keeps at most 10 images and drops non-images", () => {
    const images = Array.from({ length: 12 }, (_, i) => ({
      name: `p${i}.png`,
      mimeType: "image/png",
      dataUrl: imageDataUrl(),
    }));
    images.push({ name: "doc.pdf", mimeType: "application/pdf", dataUrl: imageDataUrl("application/pdf") });
    const request = normalizeSharePayload({ images }, "android-share", "id-9");
    expect(request.kind).toBe("share");
    if (request.kind === "share") expect(request.images).toHaveLength(10);
  });

  it("drops images over the 10 MB cap but keeps the rest of the share", () => {
    const oversized = "A".repeat(Math.ceil(((MAX_SHARE_IMAGE_BYTES + 1024) * 4) / 3) + 4);
    const request = normalizeSharePayload(
      {
        text: "with images",
        images: [
          { name: "big.png", mimeType: "image/png", dataUrl: imageDataUrl("image/png", oversized) },
          { name: "small.png", mimeType: "image/png", dataUrl: imageDataUrl() },
        ],
      },
      "android-share",
      "id-10",
    );
    expect(request.kind).toBe("share");
    if (request.kind === "share") {
      expect(request.images.map((image) => image.name)).toEqual(["small.png"]);
    }
  });

  it("estimates base64 data URL sizes", () => {
    expect(dataUrlByteSize(imageDataUrl("image/png", "AAAA"))).toBe(3);
    expect(dataUrlByteSize(imageDataUrl("image/png", "AAA="))).toBe(2);
  });
});

describe("capture queue", () => {
  beforeEach(() => {
    resetCaptureStateForTests();
  });

  const shareRequest = (id: string): CaptureRequest => ({
    kind: "share",
    source: "web-share",
    id,
    title: "T",
    content: "<p>x</p>",
    images: [],
  });

  it("hands out requests oldest-first and consumes each once", () => {
    expect(enqueueCapture(shareRequest("a"))).toBe(true);
    expect(enqueueCapture({ kind: "new-note", source: "pwa-shortcut", id: "b" })).toBe(true);
    expect(getPendingCapture()?.id).toBe("a");
    consumeCapture("a");
    expect(getPendingCapture()?.id).toBe("b");
    consumeCapture("b");
    expect(getPendingCapture()).toBeNull();
  });

  it("never accepts the same id twice, even after consumption", () => {
    expect(enqueueCapture(shareRequest("dup"))).toBe(true);
    expect(enqueueCapture(shareRequest("dup"))).toBe(false);
    consumeCapture("dup");
    expect(enqueueCapture(shareRequest("dup"))).toBe(false);
    expect(getPendingCapture()).toBeNull();
  });
});

describe("web share boot check", () => {
  beforeEach(() => {
    resetCaptureStateForTests();
    session.map.clear();
    replacedUrls.length = 0;
    win.location.search = "";
  });

  it("round-trips a stored web share into the queue and clears the key", () => {
    storePendingWebShare({ title: "Page", text: "hello world", url: "https://example.com" });
    expect(session.map.has(WEB_SHARE_STORAGE_KEY)).toBe(true);

    expect(checkWebShareBoot()).toBe(true);
    expect(session.map.has(WEB_SHARE_STORAGE_KEY)).toBe(false);

    const request = getPendingCapture();
    expect(request).toMatchObject({ kind: "share", source: "web-share", title: "Page" });
    if (request?.kind === "share") expect(request.content).toContain("hello world");

    // A second boot check finds nothing — the payload was consumed.
    expect(checkWebShareBoot()).toBe(false);
  });

  it("clears a malformed stored payload instead of retrying it forever", () => {
    session.setItem(WEB_SHARE_STORAGE_KEY, "{not json");
    expect(checkWebShareBoot()).toBe(false);
    expect(session.map.has(WEB_SHARE_STORAGE_KEY)).toBe(false);
    expect(getPendingCapture()).toBeNull();
  });

  it("turns the manifest shortcut param into a new-note capture and strips it", () => {
    win.location.search = "?capture=new-note";
    expect(checkPwaShortcutParam()).toBe(true);
    expect(getPendingCapture()).toMatchObject({ kind: "new-note", source: "pwa-shortcut" });
    expect(replacedUrls).toEqual(["/"]);
    // Param was stripped from the URL, so a re-run is a no-op.
    win.location.search = "";
    expect(checkPwaShortcutParam()).toBe(false);
  });
});

describe("drainNativeShares", () => {
  beforeEach(() => {
    resetCaptureStateForTests();
  });

  /** A getSharedContent stand-in that hands out payloads in order, then null. */
  const getterFrom = (payloads: (NativeSharedContent | null)[]) => {
    let index = 0;
    return async (): Promise<NativeSharedContent | null> => payloads[index++] ?? null;
  };

  /** Reads the capture queue oldest-first, consuming as it goes. */
  const queuedRequests = (): CaptureRequest[] => {
    const requests: CaptureRequest[] = [];
    let head = getPendingCapture();
    while (head) {
      requests.push(head);
      consumeCapture(head.id);
      head = getPendingCapture();
    }
    return requests;
  };

  it("drains every queued payload, oldest first", async () => {
    const getContent = getterFrom([
      { title: "First", text: "one" },
      { title: "Second", text: "two" },
      { title: "Third", text: "three" },
      null,
    ]);
    await expect(drainNativeShares(getContent)).resolves.toBe(3);
    const requests = queuedRequests();
    expect(requests.map((r) => (r.kind === "share" ? r.title : ""))).toEqual([
      "First",
      "Second",
      "Third",
    ]);
    expect(requests.every((r) => r.source === "android-share")).toBe(true);
  });

  it("stops at the first null and enqueues nothing", async () => {
    const getContent = getterFrom([null, { title: "Never reached", text: "x" }]);
    await expect(drainNativeShares(getContent)).resolves.toBe(0);
    expect(getPendingCapture()).toBeNull();
  });

  it("stops quietly when a pull fails mid-drain", async () => {
    let calls = 0;
    const getContent = async (): Promise<NativeSharedContent | null> => {
      calls += 1;
      if (calls === 2) throw new Error("bridge gone");
      return { title: `Share ${calls}`, text: "body" };
    };
    await expect(drainNativeShares(getContent)).resolves.toBe(1);
    const requests = queuedRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ kind: "share", title: "Share 1" });
  });

  it("respects the drain bound when the plugin never runs dry", async () => {
    let calls = 0;
    const getContent = async (): Promise<NativeSharedContent | null> => {
      calls += 1;
      return { title: `Share ${calls}`, text: "body" };
    };
    await expect(drainNativeShares(getContent)).resolves.toBe(MAX_NATIVE_SHARE_DRAIN);
    expect(calls).toBe(MAX_NATIVE_SHARE_DRAIN);
    expect(queuedRequests()).toHaveLength(MAX_NATIVE_SHARE_DRAIN);
  });
});

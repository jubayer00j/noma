import { describe, expect, it } from "vitest";
import { buildLinkIndex, extractNoteLinks } from "./links";
import type { Note } from "./types";

function chip(id: string, label = `Note ${id}`): string {
  return `<span data-note-link="" data-note-id="${id}">${label}</span>`;
}

function makeNote(id: string, content: string, extra: Partial<Note> = {}): Note {
  return {
    id,
    title: `Note ${id}`,
    content,
    contentFormat: "tiptap-html",
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    folderId: null,
    tagIds: [],
    pinned: false,
    favorite: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    reminderAt: null,
    wordCount: 0,
    ...extra,
  };
}

describe("extractNoteLinks", () => {
  it("finds ids in the editor's emitted form", () => {
    const html = `<p>See ${chip("a")} and ${chip("b")}.</p>`;
    expect(extractNoteLinks(html)).toEqual(["a", "b"]);
  });

  it("finds ids in the sanitised stored form (attribute order/values as stored)", () => {
    // sanitizeHtml output: the marker serialises with an explicit empty
    // value; attribute order follows the stored markup.
    const stored = `<p>See <span data-note-id="a" data-note-link="">Note a</span>.</p>`;
    expect(extractNoteLinks(stored)).toEqual(["a"]);
  });

  it("de-duplicates repeated links, keeping first-appearance order", () => {
    const html = `<p>${chip("b")} ${chip("a")} ${chip("b")} ${chip("a")}</p>`;
    expect(extractNoteLinks(html)).toEqual(["b", "a"]);
  });

  it("ignores spans without the note-link marker", () => {
    const html = `<p><span data-note-id="a">plain</span> <span style="color: red">red</span></p>`;
    expect(extractNoteLinks(html)).toEqual([]);
  });

  it("ignores data-note-id on other elements", () => {
    const html = `<div data-note-link="" data-note-id="a"></div><p data-note-id="b">x</p>`;
    expect(extractNoteLinks(html)).toEqual([]);
  });

  it("ignores escaped/lookalike text that is not element markup", () => {
    const html = `<pre>&lt;span data-note-link data-note-id="a"&gt;x&lt;/span&gt;</pre>`;
    expect(extractNoteLinks(html)).toEqual([]);
  });

  it("returns [] for empty and link-free content", () => {
    expect(extractNoteLinks("")).toEqual([]);
    expect(extractNoteLinks("<p>Nothing here.</p>")).toEqual([]);
  });

  it("finds nothing in a locked note's ciphertext envelope", () => {
    const envelope = JSON.stringify({
      nomaEnc: 1,
      iv: "AAAA",
      data: "Y2lwaGVydGV4dA==",
    });
    expect(extractNoteLinks(envelope)).toEqual([]);
  });
});

describe("buildLinkIndex", () => {
  it("builds outgoing and incoming maps across notes", () => {
    const notes = [
      makeNote("a", `<p>${chip("b")} ${chip("c")}</p>`),
      makeNote("b", `<p>${chip("a")}</p>`),
      makeNote("c", "<p>No links.</p>"),
    ];
    const index = buildLinkIndex(notes);
    expect(index.outgoing.get("a")).toEqual(["b", "c"]);
    expect(index.outgoing.get("b")).toEqual(["a"]);
    expect(index.outgoing.has("c")).toBe(false);
    expect(index.incoming.get("a")).toEqual(["b"]);
    expect(index.incoming.get("b")).toEqual(["a"]);
    expect(index.incoming.get("c")).toEqual(["a"]);
  });

  it("excludes templates and trashed notes as sources", () => {
    const notes = [
      makeNote("target", "<p>Target.</p>"),
      makeNote("tpl", `<p>${chip("target")}</p>`, { isTemplate: true }),
      makeNote("bin", `<p>${chip("target")}</p>`, { deleted: true, deletedAt: 5 }),
      makeNote("live", `<p>${chip("target")}</p>`),
    ];
    const index = buildLinkIndex(notes);
    expect(index.incoming.get("target")).toEqual(["live"]);
    expect(index.outgoing.has("tpl")).toBe(false);
    expect(index.outgoing.has("bin")).toBe(false);
  });

  it("keeps self-links in outgoing but out of the note's own incoming", () => {
    const notes = [makeNote("a", `<p>${chip("a")} ${chip("b")}</p>`), makeNote("b", "")];
    const index = buildLinkIndex(notes);
    expect(index.outgoing.get("a")).toEqual(["a", "b"]);
    expect(index.incoming.has("a")).toBe(false);
    expect(index.incoming.get("b")).toEqual(["a"]);
  });

  it("collapses duplicate links from one source into one incoming entry", () => {
    const notes = [makeNote("a", `<p>${chip("b")} and again ${chip("b")}</p>`), makeNote("b", "")];
    const index = buildLinkIndex(notes);
    expect(index.incoming.get("b")).toEqual(["a"]);
  });

  it("includes archived notes as sources and lets them receive links", () => {
    const notes = [
      makeNote("a", `<p>${chip("old")}</p>`),
      makeNote("old", `<p>${chip("a")}</p>`, { archived: true }),
    ];
    const index = buildLinkIndex(notes);
    expect(index.incoming.get("a")).toEqual(["old"]);
    expect(index.incoming.get("old")).toEqual(["a"]);
  });

  it("a locked (ciphertext) source contributes nothing but can receive", () => {
    const locked = makeNote("locked", JSON.stringify({ nomaEnc: 1, data: "Y2lwaGVy" }), {
      lock: {
        v: 1,
        slots: {},
        biometric: false,
        failedAttempts: 0,
        lockoutUntil: null,
        lockedAt: 1,
      },
    });
    const notes = [makeNote("a", `<p>${chip("locked")}</p>`), locked];
    const index = buildLinkIndex(notes);
    expect(index.outgoing.has("locked")).toBe(false);
    expect(index.incoming.get("locked")).toEqual(["a"]);
  });
});

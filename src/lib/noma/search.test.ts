// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { searchNotes } from "./search";
import type { Folder, Note, NoteLock, Tag } from "./types";

function makeNote(id: string, extra: Partial<Note> = {}): Note {
  return {
    id,
    title: `Title ${id}`,
    content: `<p>Body ${id}</p>`,
    contentFormat: "tiptap-html",
    createdAt: 1000,
    updatedAt: 1000,
    folderId: null,
    tagIds: [],
    pinned: false,
    favorite: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    reminderAt: null,
    wordCount: 5,
    ...extra,
  };
}

const folders: Folder[] = [];
const tags: Tag[] = [];

/** The reported Testing-note shape from PR #94: three one-item ordered
 * lists (starts 1/2/3), each followed by a bullet list of 1/2/3. Its
 * structure-aware text is "1. Hlw • 1 • 2 • 3 2. Hi • …"; the flat
 * extractor reads "Hlw 1 2 3 Hi 1 2 3 Hey 1 2 3". */
const TESTING_CONTENT =
  '<ol start="1"><li><p>Hlw</p></li></ol>' +
  "<ul><li><p>1</p></li><li><p>2</p></li><li><p>3</p></li></ul>" +
  '<ol start="2"><li><p>Hi</p></li></ol>' +
  "<ul><li><p>1</p></li><li><p>2</p></li><li><p>3</p></li></ul>" +
  '<ol start="3"><li><p>Hey</p></li></ol>' +
  "<ul><li><p>1</p></li><li><p>2</p></li><li><p>3</p></li></ul>";

describe("searchNotes snippets keep list markers", () => {
  it("snippets a Testing-shaped list note with its markers, scored on the flat text", () => {
    const note = makeNote("testing", { title: "Testing", content: TESTING_CONTENT });
    const results = searchNotes("hlw", [note], folders, tags);
    expect(results).toHaveLength(1);
    // Body-only hit: the score is the flat body weight, markers or not.
    expect(results[0]?.score).toBe(3);
    expect(results[0]?.snippet).toContain("1. Hlw");
    expect(results[0]?.snippet).toContain("• 1");
    expect(results[0]?.snippet).toBe("1. Hlw • 1 • 2 • 3 2. Hi • 1 • 2 • 3 3. Hey • 1 • 2 • 3…");
  });

  it("windows around a deep match in the structured text", () => {
    const note = makeNote("deep", {
      title: "Field notes",
      content:
        "<ol><li><p>Alpha bravo charlie delta echo foxtrot golf hotel india juliet</p></li>" +
        "<li><p>zebra crossing</p></li></ol>",
    });
    const results = searchNotes("zebra", [note], folders, tags);
    expect(results).toHaveLength(1);
    const snippet = results[0]?.snippet ?? "";
    // The match sits ~69 chars into the structured text, so the window
    // is cut around it (leading ellipsis), not taken from the head.
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet).toContain("juliet 2. zebra crossing");
    expect(snippet).not.toContain("Alpha");
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("gives a title-only match the structured head snippet", () => {
    const note = makeNote("titled", {
      title: "Zebra plans",
      content:
        '<ol start="1"><li><p>Hlw</p></li></ol>' + "<ul><li><p>1</p></li><li><p>2</p></li></ul>",
    });
    const results = searchNotes("zebra", [note], folders, tags);
    expect(results).toHaveLength(1);
    expect(results[0]?.score).toBe(6);
    expect(results[0]?.snippet).toBe("1. Hlw • 1 • 2");
  });

  it("keeps locked notes title-only with an empty snippet", () => {
    const lock: NoteLock = {
      v: 1,
      slots: {},
      biometric: false,
      failedAttempts: 0,
      lockoutUntil: null,
      lockedAt: 1000,
    };
    const note = makeNote("locked", {
      title: "Bank details",
      content: '<ol start="1"><li><p>account number</p></li></ol>',
      lock,
    });
    const byTitle = searchNotes("bank", [note], folders, tags);
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0]?.snippet).toBe("");
    expect(searchNotes("account", [note], folders, tags)).toHaveLength(0);
  });
});

// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { Editor } from "@tiptap/core";
import type { NomaDatabase } from "./db";
import { collectBackup } from "./backup";
import { createNote } from "./notes";
import { sanitizeHtml } from "./sanitize";
import { createNomaExtensions } from "@/components/noma/tiptap-extensions";
import {
  createImportImageResolver,
  importNotes,
  parseImportZip,
  parseKeepTakeout,
  parseMarkdownFiles,
  type ImportedNote,
  type MarkdownFileInput,
} from "./importers";
import type {
  AppSettings,
  AttachmentMeta,
  Folder,
  Note,
  NoteVersion,
  Reminder,
  SyncState,
  SyncTombstone,
  Tag,
} from "./types";

/* ---------------- Attachment pipeline stub ----------------
 * saveImageAttachment decodes images through FileReader + <img> +
 * canvas, which happy-dom can't do. The stub keeps the contract (a row
 * in db.attachments with a fresh id, returned as the meta) so the
 * import engine's wiring is exercised end to end. */

const attachmentSeq = vi.hoisted(() => ({ next: 0 }));

vi.mock("./media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./media")>();
  return {
    ...actual,
    saveImageAttachment: async (
      db: NomaDatabase,
      noteId: string,
      file: File,
    ): Promise<AttachmentMeta> => {
      attachmentSeq.next += 1;
      const meta: AttachmentMeta = {
        id: `att-imported-${attachmentSeq.next}`,
        noteId,
        name: file.name || "image.png",
        mimeType: file.type || "image/png",
        size: file.size,
        createdAt: 1,
        updatedAt: 1,
        data: "data:image/png;base64,AAAA",
      };
      await db.attachments.put(meta);
      return meta;
    },
  };
});

/* ---------------- Fake Dexie surface ----------------
 * Same in-memory stand-in the other suites use, with `filter().first()`
 * added (createTag needs it). */

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
    const matched = () => [...this.rows.values()].filter(fn);
    return {
      toArray: async () => matched().map((row) => structuredClone(row)),
      first: async () => {
        const row = matched()[0];
        return row ? structuredClone(row) : undefined;
      },
      count: async () => matched().length,
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
  syncMeta = new FakeTable<SyncState>();
  noteVersions = new FakeTable<NoteVersion>();

  async transaction(...args: unknown[]): Promise<void> {
    const fn = args[args.length - 1] as () => Promise<void>;
    await fn();
  }
}

function asDb(fake: FakeDb): NomaDatabase {
  return fake as unknown as NomaDatabase;
}

/* ---------------- Helpers ---------------- */

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

async function makeZip(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return zip.generateAsync({ type: "uint8array" });
}

function mdFile(partial: Partial<MarkdownFileInput> & { text: string }): MarkdownFileInput {
  return {
    name: "note.md",
    path: "note.md",
    lastModified: 1_700_000_000_000,
    ...partial,
  };
}

const CREATED_USEC = 1_700_000_000_000_000; // 2023-11-14T22:13:20Z
const EDITED_USEC = 1_700_003_600_000_000;

/* ---------------- Keep parser ---------------- */

describe("parseKeepTakeout", () => {
  it("imports a text note with paragraphs, line breaks and exact timestamps", async () => {
    const zip = await makeZip({
      "Takeout/Keep/Shopping.json": JSON.stringify({
        title: "Shopping",
        textContent: "Milk\nEggs\n\nBread",
        createdTimestampUsec: CREATED_USEC,
        userEditedTimestampUsec: EDITED_USEC,
      }),
    });
    const result = await parseKeepTakeout(zip);
    expect(result.skippedFiles).toEqual([]);
    expect(result.notes).toHaveLength(1);
    const note = result.notes[0]!;
    expect(note.title).toBe("Shopping");
    expect(note.contentHtml).toBe("<p>Milk<br>Eggs</p><p>Bread</p>");
    expect(note.createdAt).toBe(1_700_000_000_000);
    expect(note.updatedAt).toBe(1_700_003_600_000);
    expect(note.folderName).toBeNull();
  });

  it("imports a list note as a task list with checked states intact", async () => {
    const zip = await makeZip({
      "Takeout/Keep/Todo.json": JSON.stringify({
        title: "Todo",
        listContent: [
          { text: "Done thing", isChecked: true },
          { text: "Pending thing", isChecked: false },
        ],
        createdTimestampUsec: CREATED_USEC,
        userEditedTimestampUsec: CREATED_USEC,
      }),
    });
    const result = await parseKeepTakeout(zip);
    const note = result.notes[0]!;
    expect(note.contentHtml).toContain('<ul data-type="taskList">');
    expect(note.contentHtml).toContain('data-checked="true"');
    expect(note.contentHtml).toContain('data-checked="false"');
    expect(note.contentHtml).toContain("Done thing");
    expect(note.contentHtml).toContain("Pending thing");
    // The checked item carries the checkbox state the editor emits.
    expect(note.contentHtml).toContain('<input type="checkbox" checked="checked">');
  });

  it("maps labels to tags and pinned/archived/trashed flags 1:1", async () => {
    const zip = await makeZip({
      "Takeout/Keep/Flags.json": JSON.stringify({
        title: "Flags",
        textContent: "body",
        labels: [{ name: "Work" }, { name: "Ideas" }],
        isPinned: true,
        isArchived: true,
        isTrashed: true,
        createdTimestampUsec: CREATED_USEC,
        userEditedTimestampUsec: EDITED_USEC,
      }),
    });
    const note = (await parseKeepTakeout(zip)).notes[0]!;
    expect(note.tagNames).toEqual(["Work", "Ideas"]);
    expect(note.pinned).toBe(true);
    expect(note.archived).toBe(true);
    expect(note.deleted).toBe(true);
    expect(note.deletedAt).toBe(1_700_003_600_000);
  });

  it("resolves image attachments and counts non-image attachments as skipped", async () => {
    const zip = await makeZip({
      "Takeout/Keep/With media.json": JSON.stringify({
        title: "With media",
        textContent: "see attached",
        attachments: [
          { filePath: "photo.png", mimetype: "image/png" },
          { filePath: "voice.3gp", mimetype: "audio/3gpp" },
        ],
        createdTimestampUsec: CREATED_USEC,
        userEditedTimestampUsec: CREATED_USEC,
      }),
      "Takeout/Keep/photo.png": PNG_BYTES,
      "Takeout/Keep/voice.3gp": new Uint8Array([1, 2, 3]),
    });
    const result = await parseKeepTakeout(zip);
    const note = result.notes[0]!;
    expect(note.images).toHaveLength(1);
    expect(note.images[0]!.name).toBe("photo.png");
    expect(note.images[0]!.mimeType).toBe("image/png");
    expect(note.images[0]!.token).toBeNull();
    expect(result.attachmentsSkipped).toBe(1);
  });

  it("skips malformed JSON and non-Keep JSON without aborting the run", async () => {
    const zip = await makeZip({
      "Takeout/Keep/Good.json": JSON.stringify({
        title: "Good",
        textContent: "ok",
        createdTimestampUsec: CREATED_USEC,
        userEditedTimestampUsec: CREATED_USEC,
      }),
      "Takeout/Keep/Broken.json": "{ not json",
    });
    const result = await parseKeepTakeout(zip);
    expect(result.notes).toHaveLength(1);
    expect(result.skippedFiles).toHaveLength(1);
    expect(result.skippedFiles[0]!.name).toBe("Broken.json");
  });

  it("prefers the Keep folder and ignores unrelated JSON elsewhere", async () => {
    const zip = await makeZip({
      "Takeout/Keep/Real.json": JSON.stringify({
        title: "Real",
        textContent: "ok",
        createdTimestampUsec: CREATED_USEC,
        userEditedTimestampUsec: CREATED_USEC,
      }),
      "Takeout/Other/settings.json": JSON.stringify({ title: "Not a note", textContent: "junk" }),
    });
    const result = await parseKeepTakeout(zip);
    expect(result.notes.map((n) => n.title)).toEqual(["Real"]);
  });

  it("counts coloured notes for the report line", async () => {
    const zip = await makeZip({
      "Takeout/Keep/Coloured.json": JSON.stringify({
        title: "Coloured",
        textContent: "ok",
        color: "RED",
        createdTimestampUsec: CREATED_USEC,
        userEditedTimestampUsec: CREATED_USEC,
      }),
    });
    const result = await parseKeepTakeout(zip);
    expect(result.coloredNotes).toBe(1);
  });

  it("reports a non-ZIP file instead of throwing", async () => {
    const result = await parseKeepTakeout(new Uint8Array([1, 2, 3, 4]));
    expect(result.notes).toEqual([]);
    expect(result.skippedFiles).toHaveLength(1);
  });
});

/* ---------------- Markdown converter ---------------- */

describe("parseMarkdownFiles", () => {
  it("renders headings (clamped to the editor's H1–H3), emphasis, code and links", async () => {
    const result = await parseMarkdownFiles([
      mdFile({
        text: [
          "# Title heading",
          "",
          "## Section",
          "",
          "#### Deep heading",
          "",
          "Some **bold**, *italic*, ~~struck~~ and `code` text.",
          "",
          "A [good link](https://example.com) and a [bad link](javascript:alert(1)).",
        ].join("\n"),
      }),
    ]);
    const note = result.notes[0]!;
    // The leading H1 is consumed as the note's title (spec D1).
    expect(note.title).toBe("Title heading");
    const html = note.contentHtml;
    expect(html).not.toContain("<h1>Title heading</h1>");
    expect(html).toContain("<h2>Section</h2>");
    expect(html).toContain("<h3>Deep heading</h3>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<s>struck</s>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="https://example.com">good link</a>');
    expect(html).not.toContain("javascript:");
    expect(html).toContain("bad link");
  });

  it("escapes raw HTML instead of passing it through", async () => {
    const result = await parseMarkdownFiles([
      mdFile({ text: 'Text with <script>alert("x")</script> and <b>raw</b> markup.' }),
    ]);
    const html = result.notes[0]!.contentHtml;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(sanitizeHtml(html)).not.toContain("<script>");
  });

  it("renders fenced code literally, blockquotes, rules and lists", async () => {
    const result = await parseMarkdownFiles([
      mdFile({
        text: [
          "Intro",
          "",
          "```",
          "if (a < b) { **not bold** }",
          "```",
          "",
          "> quoted line",
          ">",
          "> second para",
          "",
          "---",
          "",
          "- one",
          "- two",
          "  - nested",
          "",
          "1. first",
          "2. second",
        ].join("\n"),
      }),
    ]);
    const html = result.notes[0]!.contentHtml;
    expect(html).toContain("<pre><code>if (a &lt; b) { **not bold** }</code></pre>");
    expect(html).toContain("<blockquote><p>quoted line</p><p>second para</p></blockquote>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<ul><li><p>one</p></li><li><p>two</p><ul><li><p>nested</p></li></ul></li></ul>");
    expect(html).toContain("<ol><li><p>first</p></li><li><p>second</p></li></ol>");
  });

  it("renders task lists in the editor's serialised shape", async () => {
    const result = await parseMarkdownFiles([
      mdFile({ text: ["- [x] Finished", "- [ ] Open"].join("\n") }),
    ]);
    const html = result.notes[0]!.contentHtml;
    expect(html).toBe(
      '<ul data-type="taskList">' +
        '<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Finished</p></div></li>' +
        '<li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>Open</p></div></li>' +
        "</ul>",
    );
  });

  it("parses front matter: title, date and tags (inline list and comma forms)", async () => {
    const inline = await parseMarkdownFiles([
      mdFile({
        name: "fm.md",
        text: ["---", "title: My Note", "date: 2024-01-15", "tags: [work, ideas]", "---", "", "Body"].join("\n"),
      }),
    ]);
    expect(inline.notes[0]!.title).toBe("My Note");
    expect(inline.notes[0]!.createdAt).toBe(Date.parse("2024-01-15"));
    expect(inline.notes[0]!.tagNames).toEqual(["work", "ideas"]);
    expect(inline.notes[0]!.contentHtml).toBe("<p>Body</p>");

    const comma = await parseMarkdownFiles([
      mdFile({
        name: "fm2.md",
        text: ["---", "created: 2024-02-01T10:00:00Z", "tags: alpha, beta", "---", "Body"].join("\n"),
      }),
    ]);
    expect(comma.notes[0]!.createdAt).toBe(Date.parse("2024-02-01T10:00:00Z"));
    expect(comma.notes[0]!.tagNames).toEqual(["alpha", "beta"]);
    expect(comma.notes[0]!.title).toBe("fm2");
  });

  it("consumes a leading H1 as the title; a front-matter title wins and the H1 stays", async () => {
    const fromH1 = await parseMarkdownFiles([
      mdFile({ name: "file-name.md", text: ["# Real Title", "", "Body text"].join("\n") }),
    ]);
    expect(fromH1.notes[0]!.title).toBe("Real Title");
    expect(fromH1.notes[0]!.contentHtml).toBe("<p>Body text</p>");

    const fromFm = await parseMarkdownFiles([
      mdFile({
        name: "file-name.md",
        text: ["---", "title: FM Title", "---", "# Heading", "", "Body"].join("\n"),
      }),
    ]);
    expect(fromFm.notes[0]!.title).toBe("FM Title");
    expect(fromFm.notes[0]!.contentHtml).toContain("<h1>Heading</h1>");
  });

  it("resolves relative images to attachment placeholders; unresolved keep alt text", async () => {
    const resolver = createImportImageResolver(
      new Map([["pics/cat.png", { name: "cat.png", blob: new Blob([PNG_BYTES], { type: "image/png" }) }]]),
    );
    const result = await parseMarkdownFiles(
      [
        mdFile({
          name: "with-images.md",
          path: "docs/with-images.md",
          text: ["Look:", "", "![A cat](../pics/cat.png)", "", "![Missing](gone.png)"].join("\n"),
        }),
      ],
      resolver,
    );
    const note = result.notes[0]!;
    expect(note.images).toHaveLength(1);
    expect(note.images[0]!.name).toBe("cat.png");
    expect(note.images[0]!.alt).toBe("A cat");
    expect(note.contentHtml).toContain(note.images[0]!.token!);
    expect(note.contentHtml).toContain("Missing");
    expect(result.imagesUnresolved).toBe(1);
  });

  it("never hot-links remote images", async () => {
    const result = await parseMarkdownFiles(
      [mdFile({ text: "![Remote](https://example.com/x.png)" })],
      createImportImageResolver(new Map()),
    );
    expect(result.notes[0]!.images).toEqual([]);
    expect(result.notes[0]!.contentHtml).toContain("Remote");
    expect(result.imagesUnresolved).toBe(1);
  });

  it("imports .txt as plain paragraphs and takes the folder from the parent path", async () => {
    const result = await parseMarkdownFiles([
      mdFile({
        name: "plain.txt",
        path: "Journal/plain.txt",
        text: "First line\nsecond line\n\nNew para",
      }),
      mdFile({ name: "root.md", path: "root.md", text: "Body" }),
    ]);
    expect(result.notes[0]!.contentHtml).toBe("<p>First line<br>second line</p><p>New para</p>");
    expect(result.notes[0]!.folderName).toBe("Journal");
    expect(result.notes[0]!.title).toBe("plain");
    expect(result.notes[1]!.folderName).toBeNull();
  });
});

describe("parseMarkdownFiles — ordered list markers", () => {
  it("keeps a numeric list's start from its first marker", async () => {
    const shifted = await parseMarkdownFiles([mdFile({ text: "3. Third\n4. Fourth" })]);
    expect(shifted.notes[0]!.contentHtml).toBe(
      '<ol start="3"><li><p>Third</p></li><li><p>Fourth</p></li></ol>',
    );
    // The sanitizer keeps the validated start, so it survives into the editor.
    expect(sanitizeHtml(shifted.notes[0]!.contentHtml)).toContain('<ol start="3">');

    const fromOne = await parseMarkdownFiles([mdFile({ text: "1. First\n2. Second" })]);
    expect(fromOne.notes[0]!.contentHtml).toBe(
      "<ol><li><p>First</p></li><li><p>Second</p></li></ol>",
    );

    // The ) delimiter carries the same semantics.
    const parens = await parseMarkdownFiles([mdFile({ text: "3) Third\n4) Fourth" })]);
    expect(parens.notes[0]!.contentHtml).toBe(
      '<ol start="3"><li><p>Third</p></li><li><p>Fourth</p></li></ol>',
    );
  });

  it("imports lettered lists with their type, and start when not a/A", async () => {
    const lower = await parseMarkdownFiles([mdFile({ text: "a. Alpha\nb. Beta" })]);
    expect(lower.notes[0]!.contentHtml).toBe(
      '<ol type="a"><li><p>Alpha</p></li><li><p>Beta</p></li></ol>',
    );

    const shifted = await parseMarkdownFiles([mdFile({ text: "c. Gamma\nd. Delta" })]);
    expect(shifted.notes[0]!.contentHtml).toBe(
      '<ol type="a" start="3"><li><p>Gamma</p></li><li><p>Delta</p></li></ol>',
    );

    const upper = await parseMarkdownFiles([mdFile({ text: "A. Alpha\nB. Beta" })]);
    expect(upper.notes[0]!.contentHtml).toBe(
      '<ol type="A"><li><p>Alpha</p></li><li><p>Beta</p></li></ol>',
    );

    const nested = await parseMarkdownFiles([
      mdFile({ text: "a. One\n  a. Sub\n  b. Sub two\nb. Two" }),
    ]);
    expect(nested.notes[0]!.contentHtml).toBe(
      '<ol type="a"><li><p>One</p><ol type="a"><li><p>Sub</p></li><li><p>Sub two</p></li></ol></li><li><p>Two</p></li></ol>',
    );
  });

  it("reads i/ii/iii as roman, not alpha, and keeps a roman start", async () => {
    const roman = await parseMarkdownFiles([mdFile({ text: "i. One\nii. Two\niii. Three" })]);
    expect(roman.notes[0]!.contentHtml).toBe(
      '<ol type="i"><li><p>One</p></li><li><p>Two</p></li><li><p>Three</p></li></ol>',
    );

    const shifted = await parseMarkdownFiles([mdFile({ text: "ii. Two\niii. Three" })]);
    expect(shifted.notes[0]!.contentHtml).toBe(
      '<ol type="i" start="2"><li><p>Two</p></li><li><p>Three</p></li></ol>',
    );

    const upper = await parseMarkdownFiles([mdFile({ text: "I. One\nII. Two" })]);
    expect(upper.notes[0]!.contentHtml).toBe(
      '<ol type="I"><li><p>One</p></li><li><p>Two</p></li></ol>',
    );
  });

  it("keeps unconfirmed lettered lines as prose", async () => {
    const lone = await parseMarkdownFiles([mdFile({ text: "a. Some sentence." })]);
    expect(lone.notes[0]!.contentHtml).toBe("<p>a. Some sentence.</p>");

    const abbrev = await parseMarkdownFiles([mdFile({ text: "i. e. an abbreviation in use." })]);
    expect(abbrev.notes[0]!.contentHtml).toBe("<p>i. e. an abbreviation in use.</p>");

    // A candidate whose next line does not continue the sequence is prose,
    // and so is the non-sequential candidate after it.
    const broken = await parseMarkdownFiles([
      mdFile({ text: "a. First claim\nc. Not a sequence" }),
    ]);
    expect(broken.notes[0]!.contentHtml).toBe("<p>a. First claim c. Not a sequence</p>");

    const followedByProse = await parseMarkdownFiles([
      mdFile({ text: "b. A bold claim\nfollowed by ordinary prose" }),
    ]);
    expect(followedByProse.notes[0]!.contentHtml).toBe(
      "<p>b. A bold claim followed by ordinary prose</p>",
    );
  });

  it("ends a lettered run at a marker that breaks the sequence", async () => {
    const result = await parseMarkdownFiles([mdFile({ text: "a. x\nb. y\nd. z" })]);
    expect(result.notes[0]!.contentHtml).toBe(
      '<ol type="a"><li><p>x</p></li><li><p>y</p></li></ol><p>d. z</p>',
    );
  });

  it("renders a numeric list and a lettered list as two separate lists", async () => {
    const result = await parseMarkdownFiles([
      mdFile({ text: "1. First\n2. Second\na. Alpha\nb. Beta" }),
    ]);
    expect(result.notes[0]!.contentHtml).toBe(
      "<ol><li><p>First</p></li><li><p>Second</p></li></ol>" +
        '<ol type="a"><li><p>Alpha</p></li><li><p>Beta</p></li></ol>',
    );
  });

  it("imports a lettered list that runs past z (aa, ab, …)", async () => {
    // Spreadsheet-style markers, as the exporter emits them (note-export's
    // toAlpha): a … z, then aa, ab — one list, not prose from item 27 on.
    const markers = Array.from({ length: 28 }, (_, k) => {
      let n = k + 1;
      let marker = "";
      while (n > 0) {
        n -= 1;
        marker = String.fromCharCode(97 + (n % 26)) + marker;
        n = Math.floor(n / 26);
      }
      return `${marker}. Item ${k + 1}`;
    });
    const result = await parseMarkdownFiles([mdFile({ text: markers.join("\n") })]);
    const html = result.notes[0]!.contentHtml;
    expect(html.startsWith('<ol type="a">')).toBe(true);
    expect(html.match(/<li>/g)).toHaveLength(28);
    expect(html.endsWith("<li><p>Item 27</p></li><li><p>Item 28</p></li></ol>")).toBe(true);
  });

  it("keeps a lettered start past z", async () => {
    const lower = await parseMarkdownFiles([mdFile({ text: "z. x\naa. y\nab. z" })]);
    expect(lower.notes[0]!.contentHtml).toBe(
      '<ol type="a" start="26"><li><p>x</p></li><li><p>y</p></li><li><p>z</p></li></ol>',
    );

    const upper = await parseMarkdownFiles([mdFile({ text: "Z. x\nAA. y" })]);
    expect(upper.notes[0]!.contentHtml).toBe(
      '<ol type="A" start="26"><li><p>x</p></li><li><p>y</p></li></ol>',
    );
  });

  it("keeps unconfirmed multi-letter lines as prose", async () => {
    const lone = await parseMarkdownFiles([mdFile({ text: "aa. Some sentence." })]);
    expect(lone.notes[0]!.contentHtml).toBe("<p>aa. Some sentence.</p>");

    // Skipping ab breaks the sequence, so neither line is a list item.
    const skipped = await parseMarkdownFiles([mdFile({ text: "aa. x\nac. y" })]);
    expect(skipped.notes[0]!.contentHtml).toBe("<p>aa. x ac. y</p>");
  });
});

/* ---------------- Markdown in a ZIP ---------------- */

describe("parseImportZip", () => {
  it("imports text entries and resolves images from the same ZIP", async () => {
    const zip = await makeZip({
      "notes/first.md": "# First\n\n![Pic](img/pic.png)",
      "notes/img/pic.png": PNG_BYTES,
      "notes/second.txt": "plain body",
    });
    const result = await parseImportZip(zip);
    expect(result.notes).toHaveLength(2);
    const first = result.notes.find((n) => n.title === "First")!;
    expect(first.images).toHaveLength(1);
    expect(first.folderName).toBe("notes");
    const second = result.notes.find((n) => n.title === "second")!;
    expect(second.contentHtml).toBe("<p>plain body</p>");
  });
});

/* ---------------- Sanitizer gate ---------------- */

describe("sanitizer round-trip gate", () => {
  it("every converter construct survives sanitizeHtml structurally intact", async () => {
    const result = await parseMarkdownFiles([
      mdFile({
        text: [
          "---",
          "title: Gate doc",
          "---",
          "",
          "# Heading",
          "",
          "Para with **bold**, *italic*, ~~strike~~, `code` and a [link](https://example.com).",
          "",
          "- [x] done task",
          "- [ ] open task",
          "",
          "- bullet",
          "  - nested bullet",
          "",
          "1. ordered",
          "",
          "> a quote",
          "",
          "```",
          "code <block>",
          "```",
          "",
          "---",
        ].join("\n"),
      }),
    ]);
    const html = result.notes[0]!.contentHtml;
    const clean = sanitizeHtml(html);
    const doc = new DOMParser().parseFromString(clean, "text/html");
    expect(doc.querySelector("h1")?.textContent).toBe("Heading");
    expect(doc.querySelector("strong")?.textContent).toBe("bold");
    expect(doc.querySelector("em")?.textContent).toBe("italic");
    expect(doc.querySelector("s")?.textContent).toBe("strike");
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    const items = doc.querySelectorAll('li[data-type="taskItem"]');
    expect(items).toHaveLength(2);
    expect(items[0]!.getAttribute("data-checked")).toBe("true");
    expect(items[1]!.getAttribute("data-checked")).toBe("false");
    expect(doc.querySelector("pre code")?.textContent).toBe("code <block>");
    expect(doc.querySelector("blockquote")?.textContent).toContain("a quote");
    expect(doc.querySelector("hr")).not.toBeNull();
    expect(clean).toContain("nested bullet");
    // Sanitising is idempotent on converter output: a second pass
    // (the editor's next autosave) changes nothing further.
    expect(sanitizeHtml(clean)).toBe(clean);
  });

  it("Keep task-list HTML survives sanitizeHtml with checked states", async () => {
    const zip = await makeZip({
      "Takeout/Keep/List.json": JSON.stringify({
        title: "List",
        listContent: [
          { text: "Yes", isChecked: true },
          { text: "No", isChecked: false },
        ],
        createdTimestampUsec: CREATED_USEC,
        userEditedTimestampUsec: CREATED_USEC,
      }),
    });
    const html = (await parseKeepTakeout(zip)).notes[0]!.contentHtml;
    const clean = sanitizeHtml(html);
    const doc = new DOMParser().parseFromString(clean, "text/html");
    const items = doc.querySelectorAll('li[data-type="taskItem"]');
    expect(items).toHaveLength(2);
    expect(items[0]!.getAttribute("data-checked")).toBe("true");
    expect(items[1]!.getAttribute("data-checked")).toBe("false");
    expect(sanitizeHtml(clean)).toBe(clean);
  });
});

/* ---------------- Real-editor round trip ---------------- */

describe("real editor round trip", () => {
  it("the editor parses imported task lists and images without losing state", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: createNomaExtensions(),
      content:
        '<ul data-type="taskList">' +
        '<li data-checked="true" data-type="taskItem"><label><input type="checkbox" checked="checked"><span></span></label><div><p>Finished</p></div></li>' +
        '<li data-checked="false" data-type="taskItem"><label><input type="checkbox"><span></span></label><div><p>Open</p></div></li>' +
        "</ul>" +
        '<p><img src="noma-attachment://att-1" alt="photo.png"></p>',
    });
    const out = editor.getHTML();
    expect(out).toContain('data-checked="true"');
    expect(out).toContain('data-checked="false"');
    expect(out).toContain("Finished");
    expect(out).toContain("Open");
    expect(out).toContain('src="noma-attachment://att-1"');
    editor.destroy();
  });
});

/* ---------------- Import engine ---------------- */

function importedNote(partial: Partial<ImportedNote>): ImportedNote {
  return {
    title: "Imported",
    contentHtml: "<p>body</p>",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    pinned: false,
    archived: false,
    deleted: false,
    deletedAt: null,
    tagNames: [],
    folderName: null,
    images: [],
    sourceName: "note.md",
    ...partial,
  };
}

describe("importNotes", () => {
  it("creates ordinary notes with preserved timestamps, folders, tags and word count", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const report = await importNotes(db, null, [
      importedNote({ title: "One", folderName: "Projects", tagNames: ["Work", "work"] }),
      importedNote({
        title: "Two",
        createdAt: 1_700_000_200_000,
        folderName: "projects",
        contentHtml: "<p>four word body here</p>",
      }),
    ]);
    expect(report).toEqual({ imported: 2, duplicates: 0, failed: 0, failedNames: [] });

    const notes = await fake.notes.toArray();
    expect(notes).toHaveLength(2);
    const one = notes.find((n) => n.title === "One")!;
    expect(one.createdAt).toBe(1_700_000_000_000);
    expect(one.updatedAt).toBe(1_700_000_100_000);
    // Both notes landed in ONE folder (matched case-insensitively).
    expect(await fake.folders.count()).toBe(1);
    expect(one.folderId).toBe((await fake.folders.toArray())[0]!.id);
    expect(notes.find((n) => n.title === "Two")!.folderId).toBe(one.folderId);
    // "Work"/"work" collapsed into a single tag.
    expect(await fake.tags.count()).toBe(1);
    expect(one.tagIds).toHaveLength(1);
    expect(notes.find((n) => n.title === "Two")!.wordCount).toBe(4);
    // Imported notes start with no version history.
    expect(await fake.noteVersions.count()).toBe(0);
  });

  it("is a no-op when the same import runs twice (dedupe on title + createdAt)", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const batch = [
      importedNote({ title: "A" }),
      importedNote({ title: "B", createdAt: 1_700_000_500_000 }),
    ];
    const first = await importNotes(db, null, batch);
    expect(first.imported).toBe(2);
    const second = await importNotes(db, null, batch);
    expect(second).toEqual({ imported: 0, duplicates: 2, failed: 0, failedNames: [] });
    expect(await fake.notes.count()).toBe(2);
  });

  it("dedupes against trashed notes too, and within the same batch", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    await createNote(db, { title: "Trashed twin", createdAt: 42, deleted: true, deletedAt: 43 });
    const report = await importNotes(db, null, [
      importedNote({ title: "Trashed twin", createdAt: 42 }),
      importedNote({ title: "Twin", createdAt: 7 }),
      importedNote({ title: "Twin", createdAt: 7 }),
    ]);
    expect(report.imported).toBe(1);
    expect(report.duplicates).toBe(2);
  });

  it("saves Keep attachments and appends their embeds at the end of the content", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const report = await importNotes(db, null, [
      importedNote({
        title: "With photo",
        contentHtml: "<p>see this</p>",
        images: [
          {
            name: "photo.png",
            mimeType: "image/png",
            blob: new Blob([PNG_BYTES], { type: "image/png" }),
            alt: "photo.png",
            token: null,
          },
        ],
      }),
    ]);
    expect(report.imported).toBe(1);
    const note = (await fake.notes.toArray())[0]!;
    const attachments = await fake.attachments.toArray();
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.noteId).toBe(note.id);
    expect(note.content).toBe(
      `<p>see this</p><p><img src="noma-attachment://${attachments[0]!.id}" alt="photo.png"></p>`,
    );
  });

  it("replaces Markdown image tokens inline with the saved attachment embed", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const parsed = await parseMarkdownFiles(
      [mdFile({ name: "img.md", path: "img.md", text: "Before ![Alt text](pic.png) after" })],
      createImportImageResolver(
        new Map([["pic.png", { name: "pic.png", blob: new Blob([PNG_BYTES], { type: "image/png" }) }]]),
      ),
    );
    const report = await importNotes(db, null, parsed.notes);
    expect(report.imported).toBe(1);
    const note = (await fake.notes.toArray())[0]!;
    const attachment = (await fake.attachments.toArray())[0]!;
    expect(note.content).toContain(
      `Before <img src="noma-attachment://${attachment.id}" alt="Alt text"> after`,
    );
    expect(note.content).not.toContain("%%NOMA_IMPORT_IMAGE");
  });

  it("reports progress and per-note failures without aborting the run", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const originalPut = fake.notes.put.bind(fake.notes);
    fake.notes.put = async (row: Note) => {
      if (row.title === "Boom") throw new Error("disk full");
      return originalPut(row);
    };
    const progress: [number, number][] = [];
    const report = await importNotes(
      db,
      null,
      [
        importedNote({ title: "Fine", sourceName: "fine.md" }),
        importedNote({ title: "Boom", createdAt: 9, sourceName: "boom.md" }),
        importedNote({ title: "Also fine", createdAt: 10, sourceName: "also.md" }),
      ],
      (done, total) => progress.push([done, total]),
    );
    expect(report.imported).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.failedNames).toEqual(["boom.md"]);
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("keeps archived and trashed Keep notes in their state", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const zip = await makeZip({
      "Takeout/Keep/Old.json": JSON.stringify({
        title: "Old",
        textContent: "archived body",
        isArchived: true,
        createdTimestampUsec: CREATED_USEC,
        userEditedTimestampUsec: CREATED_USEC,
      }),
      "Takeout/Keep/Gone.json": JSON.stringify({
        title: "Gone",
        textContent: "trashed body",
        isTrashed: true,
        createdTimestampUsec: CREATED_USEC + 1000,
        userEditedTimestampUsec: EDITED_USEC,
      }),
    });
    const parsed = await parseKeepTakeout(zip);
    const report = await importNotes(db, null, parsed.notes);
    expect(report.imported).toBe(2);
    const notes = await fake.notes.toArray();
    expect(notes.find((n) => n.title === "Old")!.archived).toBe(true);
    const gone = notes.find((n) => n.title === "Gone")!;
    expect(gone.deleted).toBe(true);
    expect(gone.deletedAt).toBe(1_700_003_600_000);
  });

  it("round-trips an imported note through the backup payload unchanged", async () => {
    const fake = new FakeDb();
    const db = asDb(fake);
    const parsed = await parseMarkdownFiles([
      mdFile({
        name: "rt.md",
        path: "rt.md",
        text: ["---", "title: Round trip", "date: 2024-03-01", "tags: [keep]", "---", "", "- [x] task", "", "Body **text**"].join("\n"),
      }),
    ]);
    await importNotes(db, null, parsed.notes);
    const stored = (await fake.notes.toArray())[0]!;

    const payload = await collectBackup(db, null);
    const backedUp = payload.notes.find((n) => n.id === stored.id)!;
    expect(backedUp.title).toBe(stored.title);
    expect(backedUp.content).toBe(stored.content);
    expect(backedUp.createdAt).toBe(stored.createdAt);
    expect(backedUp.updatedAt).toBe(stored.updatedAt);
    expect(backedUp.content).toContain('data-checked="true"');
    expect(payload.tags.map((t) => t.name)).toEqual(["keep"]);
  });
});

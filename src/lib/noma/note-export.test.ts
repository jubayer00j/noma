// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  buildHtmlExport,
  buildNoteExport,
  collectAttachmentIds,
  exportFilename,
  noteToMarkdown,
  noteToPlainText,
  resolveExportContent,
  type AttachmentResolver,
} from "./note-export";

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";
const resolver: AttachmentResolver = (id) => (id === "att-1" ? DATA_URL : null);

describe("noteToMarkdown — ordered lists honour start and type", () => {
  it("a typed-style list keeps its starting number", () => {
    const md = noteToMarkdown({
      title: "List",
      content: `<ol start="3"><li><p>Third</p></li><li><p>Fourth</p></li></ol>`,
    });
    expect(md).toBe("# List\n\n3. Third\n4. Fourth\n");
  });

  it("separate one-item lists keep their own numbers (the recording's note)", () => {
    const md = noteToMarkdown({
      title: "Testing",
      content:
        `<ol><li><p>Hlw</p></li></ol>` +
        `<ol start="2"><li><p>Hi</p></li></ol>` +
        `<ol start="3"><li><p>Hey</p></li></ol>`,
    });
    expect(md).toContain("1. Hlw");
    expect(md).toContain("2. Hi");
    expect(md).toContain("3. Hey");
  });

  it("lettered lists export lettered markers", () => {
    const md = noteToMarkdown({
      title: "Alpha",
      content: `<ol type="a"><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ol>`,
    });
    expect(md).toContain("a. one\nb. two\nc. three");
  });

  it("roman lists honour both type and start", () => {
    const md = noteToMarkdown({
      title: "Roman",
      content: `<ol type="i" start="4"><li><p>fourth</p></li><li><p>fifth</p></li></ol>`,
    });
    expect(md).toContain("iv. fourth\nv. fifth");
  });

  it("nested lists indent one level per depth", () => {
    const md = noteToMarkdown({
      title: "Nested",
      content: `<ul><li><p>Parent</p><ul><li><p>Child</p></li></ul></li><li><p>Sibling</p></li></ul>`,
    });
    expect(md).toContain("- Parent\n  - Child\n- Sibling");
  });
});

describe("noteToMarkdown — constructs", () => {
  it("renders task list checkboxes from data-checked", () => {
    const item = (checked: boolean, text: string) =>
      `<li data-checked="${checked}" data-type="taskItem"><label><input type="checkbox"${checked ? ' checked="checked"' : ""}><span></span></label><div><p>${text}</p></div></li>`;
    const md = noteToMarkdown({
      title: "Tasks",
      content: `<ul data-type="taskList">${item(true, "Done thing")}${item(false, "Open thing")}</ul>`,
    });
    expect(md).toContain("- [x] Done thing\n- [ ] Open thing");
    expect(md).not.toContain("checkbox");
  });

  it("renders headings, emphasis, inline code, links and quotes", () => {
    const md = noteToMarkdown({
      title: "Doc",
      content:
        `<h2>Section</h2>` +
        `<p>Some <strong>bold</strong>, <em>italic</em>, <u>under</u>, <s>gone</s>, <mark>lit</mark> and <code>x = 1</code>.</p>` +
        `<p>See <a href="https://example.com">the site</a>.</p>` +
        `<blockquote><p>Quoted words</p></blockquote>`,
    });
    expect(md).toContain("## Section");
    expect(md).toContain(
      "Some **bold**, *italic*, <u>under</u>, ~~gone~~, <mark>lit</mark> and `x = 1`.",
    );
    expect(md).toContain("[the site](https://example.com)");
    expect(md).toContain("> Quoted words");
  });

  it("renders fenced code blocks and escapes Markdown in prose", () => {
    const md = noteToMarkdown({
      title: "Code",
      content: `<pre><code>const a = 1;\nconst b = 2;</code></pre><p>2 * 3 = 6</p>`,
    });
    expect(md).toContain("```\nconst a = 1;\nconst b = 2;\n```");
    expect(md).toContain("2 \\* 3 = 6");
  });

  it("renders a table as a GitHub-flavoured pipe table", () => {
    const md = noteToMarkdown({
      title: "Table",
      content:
        `<table><tbody><tr><th>Name</th><th>Qty</th></tr>` +
        `<tr><td>Apples</td><td>3</td></tr><tr><td>Pears</td><td>5</td></tr></tbody></table>`,
    });
    expect(md).toContain("| Name | Qty |\n| --- | --- |\n| Apples | 3 |\n| Pears | 5 |");
  });

  it("note-link chips export as their label text", () => {
    const md = noteToMarkdown({
      title: "Links",
      content: `<p>See <span data-note-link="" data-note-id="note-42">Quarterly plan</span> next.</p>`,
    });
    expect(md).toContain("See Quarterly plan next.");
  });

  it("chart divs export as a placeholder naming the chart type", () => {
    const md = noteToMarkdown({
      title: "Charts",
      content: `<div data-type="noma-chart" data-chart-type="bar" data-version="2"></div><div data-type="noma-chart" data-chart-type="scatter"></div>`,
    });
    expect(md).toContain("[Bar chart]");
    expect(md).toContain("[Chart]");
  });
});

describe("noteToMarkdown — images", () => {
  it("embeds the resolved data URL", () => {
    const md = noteToMarkdown(
      { title: "Pic", content: `<p><img src="noma-attachment://att-1" alt="Cat"></p>` },
      resolver,
    );
    expect(md).toContain(`![Cat](${DATA_URL})`);
  });

  it("degrades to [Image] when the resolver has nothing", () => {
    const md = noteToMarkdown(
      { title: "Pic", content: `<p><img src="noma-attachment://att-9" alt="Cat"></p>` },
      resolver,
    );
    expect(md).toContain("[Image]");
    expect(md).not.toContain("noma-attachment://");
  });

  it("keeps external image URLs", () => {
    const md = noteToMarkdown({
      title: "Pic",
      content: `<p><img src="https://example.com/x.png" alt="Web"></p>`,
    });
    expect(md).toContain("![Web](https://example.com/x.png)");
  });
});

describe("noteToPlainText", () => {
  it("keeps typed list numbers and never glues blocks together", () => {
    const text = noteToPlainText({
      title: "Testing",
      content:
        `<ol><li><p>Hlw</p></li></ol>` +
        `<ol start="2"><li><p>Hi</p></li></ol>` +
        `<p>Alpha</p><p>Beta</p>`,
    });
    expect(text).toBe("Testing\n\n1. Hlw\n\n2. Hi\n\nAlpha\n\nBeta\n");
  });

  it("uses bullets for unordered lists and names images instead of embedding them", () => {
    const text = noteToPlainText(
      {
        title: "Plain",
        content: `<ul><li><p>one</p></li><li><p>two</p></li></ul><p><img src="noma-attachment://att-1" alt="Cat"></p>`,
      },
      resolver,
    );
    expect(text).toContain("• one\n• two");
    expect(text).toContain("[Image: Cat]");
    expect(text).not.toContain("data:image");
  });

  it("keeps link targets readable", () => {
    const text = noteToPlainText({
      title: "Links",
      content: `<p><a href="https://example.com">Example</a></p>`,
    });
    expect(text).toContain("Example (https://example.com)");
  });
});

describe("collectAttachmentIds", () => {
  it("collects referenced ids once, in first-use order", () => {
    const ids = collectAttachmentIds(
      `<p><img src="noma-attachment://a-1"></p><p><img src="noma-attachment://b-2"></p><p><img src="noma-attachment://a-1"></p><p><img src="https://example.com/x.png"></p>`,
    );
    expect(ids).toEqual(["a-1", "b-2"]);
  });
});

describe("resolveExportContent + buildHtmlExport", () => {
  it("builds a standalone document with the title escaped", () => {
    const html = buildHtmlExport({ title: "A <b> title" }, "<p>Body</p>");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<title>A &lt;b&gt; title</title>");
    expect(html).toContain("<h1>A &lt;b&gt; title</h1>");
    expect(html).toContain("<style>");
    expect(html).toContain("<p>Body</p>");
  });

  it("resolves attachment images and sanitises on the way through", () => {
    const out = resolveExportContent(
      `<p><img src="noma-attachment://att-1" alt="Cat"></p><script>alert(1)</script>`,
      resolver,
    );
    expect(out).toContain(`src="${DATA_URL}"`);
    expect(out).not.toContain("script");
    expect(out).not.toContain("noma-attachment://");
  });

  it("unresolved images and charts become placeholders; chips unwrap to labels", () => {
    const out = resolveExportContent(
      `<p><img src="noma-attachment://att-9" alt="Cat"></p>` +
        `<div data-type="noma-chart" data-chart-type="pie"></div>` +
        `<p>See <span data-note-link="" data-note-id="n1">Quarterly plan</span></p>`,
      resolver,
    );
    expect(out).toContain("[Image]");
    expect(out).toContain('<p class="noma-chart-placeholder">[Pie chart]</p>');
    expect(out).toContain("Quarterly plan");
    expect(out).not.toContain("data-note-link");
  });
});

describe("buildNoteExport", () => {
  it("assembles name, MIME type and content per format", () => {
    const note = { title: "Trip plan", content: `<p>Hello</p>` };
    const html = buildNoteExport(note, "html");
    expect(html.fileName).toBe("Trip plan.html");
    expect(html.mimeType).toBe("text/html");
    expect(html.content).toContain("<h1>Trip plan</h1>");
    const md = buildNoteExport(note, "markdown");
    expect(md.fileName).toBe("Trip plan.md");
    expect(md.mimeType).toBe("text/markdown");
    expect(md.content).toBe("# Trip plan\n\nHello\n");
    const txt = buildNoteExport(note, "text");
    expect(txt.fileName).toBe("Trip plan.txt");
    expect(txt.mimeType).toBe("text/plain");
    expect(txt.content).toBe("Trip plan\n\nHello\n");
  });
});

describe("exportFilename", () => {
  it("strips path-hostile characters", () => {
    expect(exportFilename({ title: 'a/b\\c:d*e?f"g<h>i|j' }, "markdown")).toBe(
      "a b c d e f g h i j.md",
    );
  });

  it("keeps Bengali titles intact", () => {
    expect(exportFilename({ title: "আমার নোট" }, "markdown")).toBe("আমার নোট.md");
  });

  it("falls back to Untitled note for empty or all-hostile titles", () => {
    expect(exportFilename({ title: "" }, "text")).toBe("Untitled note.txt");
    expect(exportFilename({ title: "???" }, "html")).toBe("Untitled note.html");
  });

  it("caps the base name at 80 characters", () => {
    const name = exportFilename({ title: "x".repeat(120) }, "html");
    expect(name).toBe(`${"x".repeat(80)}.html`);
  });
});

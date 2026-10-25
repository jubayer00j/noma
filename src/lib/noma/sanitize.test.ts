// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { extractNoteLinks } from "./links";
import { countWords, htmlToPlainText, sanitizeHtml } from "./sanitize";

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

const CHIP = `<span data-note-link="" data-note-id="note-42">Quarterly plan</span>`;

describe("sanitizeHtml — note-link chips (release gate)", () => {
  it("keeps a link chip intact: marker, target id and label", () => {
    const out = sanitizeHtml(`<p>See ${CHIP} for details.</p>`);
    const chip = parse(out).querySelector("span[data-note-link]");
    expect(chip).not.toBeNull();
    expect(chip?.getAttribute("data-note-id")).toBe("note-42");
    expect(chip?.textContent).toBe("Quarterly plan");
  });

  it("survives a sanitise → extract round trip (what updateNote does on save)", () => {
    const stored = sanitizeHtml(`<p>See ${CHIP}.</p>`);
    expect(extractNoteLinks(stored)).toEqual(["note-42"]);
  });

  it("is idempotent: sanitising stored content again changes nothing", () => {
    const once = sanitizeHtml(`<p>See ${CHIP}.</p>`);
    expect(sanitizeHtml(once)).toBe(once);
  });

  it("still strips other data attributes and event handlers from spans", () => {
    const out = sanitizeHtml(
      `<span data-evil="x" data-note-id="note-42" onclick="steal()">text</span>`,
    );
    const span = parse(out).querySelector("span");
    expect(span?.hasAttribute("data-evil")).toBe(false);
    expect(span?.hasAttribute("onclick")).toBe(false);
    // The allowlisted id attribute itself is inert data, kept as before.
    expect(span?.getAttribute("data-note-id")).toBe("note-42");
  });

  it("still strips non-allowlisted attributes from chips", () => {
    const out = sanitizeHtml(
      `<span data-note-link="" data-note-id="note-42" style="position:fixed" href="https://x">L</span>`,
    );
    const chip = parse(out).querySelector("span[data-note-link]");
    expect(chip?.hasAttribute("href")).toBe(false);
    // SPAN may carry colour-only styles; positioning must not survive.
    expect(chip?.getAttribute("style") ?? "").not.toContain("position");
  });

  it("keeps ordinary formatting spans working (colour style survives)", () => {
    const out = sanitizeHtml(`<p><span style="color: #b3261e">red</span></p>`);
    const span = parse(out).querySelector("span");
    expect(span?.getAttribute("style")).toContain("color:");
    expect(span?.textContent).toBe("red");
  });
});

describe("sanitizeHtml — ordered-list fidelity", () => {
  it("round-trips the start of a list created by typing \"3. \"", () => {
    // Typing "1. " / "2. " / "3. " builds one-item lists whose number
    // lives in the OL start attribute; stripping it (the old behaviour)
    // made every line restart at 1 after save.
    const out = sanitizeHtml(`<ol start="3"><li><p>x</p></li></ol>`);
    expect(parse(out).querySelector("ol")?.getAttribute("start")).toBe("3");
    // And it survives the sanitise-on-every-save loop unchanged.
    expect(sanitizeHtml(out)).toBe(out);
  });

  it("keeps a real list style and drops an invented one", () => {
    const kept = sanitizeHtml(`<ol type="a"><li><p>x</p></li></ol>`);
    expect(parse(kept).querySelector("ol")?.getAttribute("type")).toBe("a");
    const dropped = sanitizeHtml(`<ol type="evil"><li><p>x</p></li></ol>`);
    expect(parse(dropped).querySelector("ol")?.hasAttribute("type")).toBe(false);
  });

  it("drops start values that are not positive integers in range", () => {
    for (const bad of ["0", "-2", "abc"]) {
      const out = sanitizeHtml(`<ol start="${bad}"><li><p>x</p></li></ol>`);
      expect(parse(out).querySelector("ol")?.hasAttribute("start")).toBe(false);
    }
  });
});

describe("htmlToPlainText — block boundaries", () => {
  it("separates list items instead of gluing them into one word", () => {
    const html = `<ul><li><p>Alpha</p></li><li><p>Beta</p></li></ul>`;
    expect(htmlToPlainText(html)).toBe("Alpha Beta");
    expect(countWords(html)).toBe(2);
  });

  it("separates paragraphs and headings from what follows", () => {
    expect(htmlToPlainText(`<h2>Plan</h2><p>Hello</p><p>world</p>`)).toBe("Plan Hello world");
  });

  it("keeps inline formatting glued, as before", () => {
    expect(htmlToPlainText(`<p>Hel<strong>lo</strong> world</p>`)).toBe("Hello world");
  });
});

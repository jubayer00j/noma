// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { extractNoteLinks } from "./links";
import { sanitizeHtml } from "./sanitize";

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

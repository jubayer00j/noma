import { htmlToPlainText, sanitizeHtml } from "./sanitize";
import type { Note } from "./types";

/**
 * Per-note export: turn one note's stored HTML into a portable file —
 * a standalone HTML document, Markdown, or plain text — that can be
 * shared with anyone and opened anywhere, no Noma required.
 *
 * The converters are hand-rolled DOM walks in the same spirit as the
 * Markdown importer (importers.ts): no new parsing dependency, and the
 * input is the post-sanitise shape the editor actually stores, so the
 * constructs handled here are exactly the ones a note can contain.
 *
 * Images live outside the content as attachment rows; content refers to
 * them as `img[src^="noma-attachment://<id>"]`. Callers pre-resolve the
 * ids a note references (see collectAttachmentIds) and pass a sync
 * resolver — resolved images embed as data URLs so the exported file is
 * self-contained, unresolved ones degrade to an "[Image]" placeholder.
 */

export type ExportFormat = "html" | "markdown" | "text";

/** Resolves a local attachment id to a data URL, or null when unavailable. */
export type AttachmentResolver = (attachmentId: string) => string | null;

export interface NoteExportArtifact {
  fileName: string;
  mimeType: string;
  content: string;
}

const ATTACHMENT_PREFIX = "noma-attachment://";

type NoteContent = Pick<Note, "title" | "content">;

/** The note's display title, matching noteTitle() in notes.ts. */
function exportTitle(note: Pick<Note, "title">): string {
  return note.title.trim() || "Untitled note";
}

function parseBody(html: string): HTMLElement | null {
  if (typeof DOMParser === "undefined") return null;
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
}

/** Attachment ids a note's content references, in first-use order. */
export function collectAttachmentIds(html: string): string[] {
  const body = parseBody(html);
  if (!body) {
    // No DOM (SSR): fall back to the same scan media.ts uses.
    const ids: string[] = [];
    for (const match of html.matchAll(/noma-attachment:\/\/([a-zA-Z0-9_-]+)/g)) {
      if (match[1] && !ids.includes(match[1])) ids.push(match[1]);
    }
    return ids;
  }
  const ids: string[] = [];
  for (const img of Array.from(body.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (src.startsWith(ATTACHMENT_PREFIX)) {
      const id = src.slice(ATTACHMENT_PREFIX.length);
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/* ---------------- Ordered-list markers ---------------- */

/** Spreadsheet-style letters: 1 → a, 26 → z, 27 → aa. */
function toAlpha(value: number): string {
  let out = "";
  let n = value;
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out || "a";
}

const ROMAN_TABLE: [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

/** Roman numerals for 1–3999; anything outside falls back to decimal. */
function toRoman(value: number): string {
  if (value < 1 || value > 3999) return String(value);
  let out = "";
  let n = value;
  for (const [amount, glyph] of ROMAN_TABLE) {
    while (n >= amount) {
      out += glyph;
      n -= amount;
    }
  }
  return out;
}

/** The marker text for the `index`-th item of a list with the given type. */
function orderedMarker(index: number, type: string | null): string {
  switch (type) {
    case "a":
      return toAlpha(index);
    case "A":
      return toAlpha(index).toUpperCase();
    case "i":
      return toRoman(index);
    case "I":
      return toRoman(index).toUpperCase();
    default:
      return String(index);
  }
}

/* ---------------- Charts ---------------- */

const CHART_TYPE_LABELS: Record<string, string> = {
  bar: "Bar",
  line: "Line",
  area: "Area",
  pie: "Pie",
  donut: "Donut",
  radar: "Radar",
  composed: "Composed",
};

/** "[Bar chart]" for a known chart type, "[Chart]" for anything else. */
export function chartPlaceholder(chartType: string | null | undefined): string {
  const label = chartType ? CHART_TYPE_LABELS[chartType.toLowerCase()] : undefined;
  return label ? `[${label} chart]` : "[Chart]";
}

function isChartDiv(el: Element): boolean {
  return el.tagName === "DIV" && el.getAttribute("data-type") === "noma-chart";
}

/* ---------------- Markdown ---------------- */

/** Escapes the characters that would re-parse as Markdown structure. */
function escapeMdText(text: string): string {
  return text.replace(/([\\`*_[\]<])/g, "\\$1");
}

function mdCodeSpan(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  return text.startsWith("`") || text.endsWith("`")
    ? `${fence} ${text} ${fence}`
    : fence + text + fence;
}

function mdImage(el: Element, resolveImage: AttachmentResolver | undefined): string {
  const src = el.getAttribute("src") ?? "";
  const alt = (el.getAttribute("alt") ?? "").replace(/[[\]]/g, "");
  if (src.startsWith(ATTACHMENT_PREFIX)) {
    const data = resolveImage?.(src.slice(ATTACHMENT_PREFIX.length));
    return data ? `![${alt}](${data})` : "[Image]";
  }
  // External (and already-inline data:) images keep their URL.
  return src ? `![${alt}](${src})` : "[Image]";
}

function mdInline(node: Node, resolveImage: AttachmentResolver | undefined): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out += escapeMdText(child.textContent ?? "");
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    switch (el.tagName) {
      case "STRONG":
      case "B": {
        const inner = mdInline(el, resolveImage);
        out += inner ? `**${inner}**` : "";
        break;
      }
      case "EM":
      case "I": {
        const inner = mdInline(el, resolveImage);
        out += inner ? `*${inner}*` : "";
        break;
      }
      case "U":
        out += `<u>${mdInline(el, resolveImage)}</u>`;
        break;
      case "S": {
        const inner = mdInline(el, resolveImage);
        out += inner ? `~~${inner}~~` : "";
        break;
      }
      case "MARK":
        out += `<mark>${mdInline(el, resolveImage)}</mark>`;
        break;
      case "CODE":
        out += mdCodeSpan(el.textContent ?? "");
        break;
      case "A": {
        const inner = mdInline(el, resolveImage);
        const href = el.getAttribute("href");
        out += href ? `[${inner}](${href})` : inner;
        break;
      }
      case "BR":
        out += "  \n";
        break;
      case "IMG":
        out += mdImage(el, resolveImage);
        break;
      default:
        // Spans (note-link chips carry their label as text, styled spans
        // drop their colours) and anything unrecognised: keep the text.
        out += mdInline(el, resolveImage);
    }
  }
  return out;
}

function mdList(el: Element, depth: number, resolveImage: AttachmentResolver | undefined): string {
  const isTaskList = el.tagName === "UL" && el.getAttribute("data-type") === "taskList";
  const ordered = el.tagName === "OL";
  const start = Number.parseInt(el.getAttribute("start") ?? "1", 10) || 1;
  const type = el.getAttribute("type");
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let counter = start;

  for (const li of Array.from(el.children)) {
    if (li.tagName !== "LI") continue;
    let marker: string;
    if (isTaskList) marker = li.getAttribute("data-checked") === "true" ? "- [x] " : "- [ ] ";
    else if (ordered) marker = `${orderedMarker(counter, type)}. `;
    else marker = "- ";
    counter += 1;

    // Item content: everything except nested lists (rendered after the
    // item's own line, one level deeper) and the task checkbox chrome
    // (LABEL/INPUT), which is presentation, not content.
    const textParts: string[] = [];
    const nested: string[] = [];
    const collect = (parent: Element) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === 3) {
          const part = escapeMdText(child.textContent ?? "").trim();
          if (part) textParts.push(part);
          continue;
        }
        if (child.nodeType !== 1) continue;
        const childEl = child as Element;
        if (childEl.tagName === "UL" || childEl.tagName === "OL") {
          nested.push(mdList(childEl, depth + 1, resolveImage));
          continue;
        }
        if (childEl.tagName === "LABEL" || childEl.tagName === "INPUT") continue;
        if (childEl.tagName === "DIV") {
          collect(childEl);
          continue;
        }
        const part = mdInline(childEl, resolveImage).trim();
        if (part) textParts.push(part);
      }
    };
    collect(li);

    lines.push(`${indent}${marker}${textParts.join(" ")}`);
    for (const block of nested) lines.push(block);
  }
  return lines.join("\n");
}

function mdTable(el: Element, resolveImage: AttachmentResolver | undefined): string {
  const rows = Array.from(el.querySelectorAll("tr"));
  if (rows.length === 0) return "";
  const grid = rows.map((tr) =>
    Array.from(tr.children)
      .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
      .map((cell) =>
        mdInline(cell, resolveImage)
          .replace(/\|/g, "\\|")
          .replace(/\s*\n\s*/g, " ")
          .trim(),
      ),
  );
  const columns = Math.max(...grid.map((row) => row.length), 0);
  if (columns === 0) return "";
  const renderRow = (cells: string[]) =>
    `| ${Array.from({ length: columns }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [header, ...body] = grid;
  return [
    renderRow(header ?? []),
    renderRow(Array.from({ length: columns }, () => "---")),
    ...body.map(renderRow),
  ].join("\n");
}

function mdBlocks(node: Node, resolveImage: AttachmentResolver | undefined): string[] {
  const blocks: string[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      const text = escapeMdText(child.textContent ?? "").trim();
      if (text) blocks.push(text);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    switch (el.tagName) {
      case "H1":
      case "H2":
      case "H3":
      case "H4": {
        const level = Number(el.tagName[1]);
        blocks.push(`${"#".repeat(level)} ${mdInline(el, resolveImage).trim()}`);
        break;
      }
      case "P": {
        const text = mdInline(el, resolveImage).trim();
        if (text) blocks.push(text);
        break;
      }
      case "PRE": {
        const content = (el.textContent ?? "").replace(/\n+$/, "");
        const fence = content.includes("```") ? "````" : "```";
        blocks.push(`${fence}\n${content}\n${fence}`);
        break;
      }
      case "BLOCKQUOTE": {
        const inner = mdBlocks(el, resolveImage).join("\n\n");
        blocks.push(
          inner
            .split("\n")
            .map((line) => (line ? `> ${line}` : ">"))
            .join("\n"),
        );
        break;
      }
      case "HR":
        blocks.push("---");
        break;
      case "UL":
      case "OL": {
        const list = mdList(el, 0, resolveImage);
        if (list) blocks.push(list);
        break;
      }
      case "TABLE": {
        const table = mdTable(el, resolveImage);
        if (table) blocks.push(table);
        break;
      }
      case "IMG":
        blocks.push(mdImage(el, resolveImage));
        break;
      case "DIV":
        if (isChartDiv(el)) blocks.push(chartPlaceholder(el.getAttribute("data-chart-type")));
        else blocks.push(...mdBlocks(el, resolveImage));
        break;
      default: {
        const text = mdInline(el, resolveImage).trim();
        if (text) blocks.push(text);
      }
    }
  }
  return blocks;
}

/** The note as a Markdown document: title heading, then the body. */
export function noteToMarkdown(note: NoteContent, resolveImage?: AttachmentResolver): string {
  const blocks = [`# ${escapeMdText(exportTitle(note))}`];
  const body = parseBody(note.content);
  if (body) blocks.push(...mdBlocks(body, resolveImage));
  return `${blocks.filter((b) => b.trim()).join("\n\n")}\n`;
}

/* ---------------- Plain text ---------------- */

function textImage(el: Element): string {
  const alt = (el.getAttribute("alt") ?? "").trim();
  return alt ? `[Image: ${alt}]` : "[Image]";
}

interface TextRenderOptions {
  /**
   * Append " (href)" after a link's text. File exports do (the URL is part
   * of the exported document); card previews don't (link text alone).
   */
  linkUrls: boolean;
}

function textInline(node: Node, opts: TextRenderOptions): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out += child.textContent ?? "";
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    switch (el.tagName) {
      case "BR":
        out += "\n";
        break;
      case "A": {
        const inner = textInline(el, opts);
        const href = el.getAttribute("href");
        out += opts.linkUrls && href && href !== inner.trim() ? `${inner} (${href})` : inner;
        break;
      }
      case "IMG":
        out += textImage(el);
        break;
      default:
        out += textInline(el, opts);
    }
  }
  return out;
}

function textList(el: Element, depth: number, opts: TextRenderOptions): string {
  const isTaskList = el.tagName === "UL" && el.getAttribute("data-type") === "taskList";
  const ordered = el.tagName === "OL";
  const start = Number.parseInt(el.getAttribute("start") ?? "1", 10) || 1;
  const type = el.getAttribute("type");
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let counter = start;

  for (const li of Array.from(el.children)) {
    if (li.tagName !== "LI") continue;
    let marker: string;
    if (isTaskList) marker = li.getAttribute("data-checked") === "true" ? "• [x] " : "• [ ] ";
    else if (ordered) marker = `${orderedMarker(counter, type)}. `;
    else marker = "• ";
    counter += 1;

    const textParts: string[] = [];
    const nested: string[] = [];
    const collect = (parent: Element) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === 3) {
          const part = (child.textContent ?? "").replace(/\s+/g, " ").trim();
          if (part) textParts.push(part);
          continue;
        }
        if (child.nodeType !== 1) continue;
        const childEl = child as Element;
        if (childEl.tagName === "UL" || childEl.tagName === "OL") {
          nested.push(textList(childEl, depth + 1, opts));
          continue;
        }
        if (childEl.tagName === "LABEL" || childEl.tagName === "INPUT") continue;
        if (childEl.tagName === "DIV") {
          collect(childEl);
          continue;
        }
        const part = textInline(childEl, opts).replace(/\s+/g, " ").trim();
        if (part) textParts.push(part);
      }
    };
    collect(li);

    lines.push(`${indent}${marker}${textParts.join(" ")}`);
    for (const block of nested) lines.push(block);
  }
  return lines.join("\n");
}

function textBlocks(node: Node, opts: TextRenderOptions): string[] {
  const blocks: string[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      const text = (child.textContent ?? "").replace(/\s+/g, " ").trim();
      if (text) blocks.push(text);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    switch (el.tagName) {
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "P": {
        const text = textInline(el, opts).trim();
        if (text) blocks.push(text);
        break;
      }
      case "PRE":
        blocks.push((el.textContent ?? "").replace(/\n+$/, ""));
        break;
      case "BLOCKQUOTE": {
        const inner = textBlocks(el, opts).join("\n");
        blocks.push(
          inner
            .split("\n")
            .map((line) => (line ? `> ${line}` : ">"))
            .join("\n"),
        );
        break;
      }
      case "HR":
        blocks.push("---");
        break;
      case "UL":
      case "OL": {
        const list = textList(el, 0, opts);
        if (list) blocks.push(list);
        break;
      }
      case "TABLE": {
        const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
          Array.from(tr.children)
            .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
            .map((cell) => textInline(cell, opts).replace(/\s+/g, " ").trim())
            .join(" | "),
        );
        if (rows.length) blocks.push(rows.join("\n"));
        break;
      }
      case "IMG":
        blocks.push(textImage(el));
        break;
      case "DIV":
        if (isChartDiv(el)) blocks.push(chartPlaceholder(el.getAttribute("data-chart-type")));
        else blocks.push(...textBlocks(el, opts));
        break;
      default: {
        const text = textInline(el, opts).trim();
        if (text) blocks.push(text);
      }
    }
  }
  return blocks;
}

/** The note as plain text: title line, then the body, blocks unglued. */
export function noteToPlainText(note: NoteContent, resolveImage?: AttachmentResolver): string {
  // Plain text never embeds data URLs — images become named placeholders,
  // so the resolver is accepted for signature symmetry but not consulted.
  void resolveImage;
  const blocks = [exportTitle(note)];
  const body = parseBody(note.content);
  if (body) blocks.push(...textBlocks(body, { linkUrls: true }));
  return `${blocks.filter((b) => b.trim()).join("\n\n")}\n`;
}

/**
 * Structure-aware text for note-list card previews: the plain-text walk
 * above — list items keep their markers — minus the export's title line
 * (the card shows the title itself) and link URLs (link text alone),
 * flattened to the single space-separated flow the cards render, the same
 * contract htmlToPlainText gives the flat-text consumers. Word counts
 * and AI prompts keep using htmlToPlainText; the card preview and the
 * search-result snippets use this text, so both can show a list's
 * ordering at a glance.
 */
export function notePreviewText(html: string): string {
  const body = parseBody(html);
  if (!body) return htmlToPlainText(html);
  const blocks = textBlocks(body, { linkUrls: false });
  return blocks
    .filter((b) => b.trim())
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------------- Standalone HTML ---------------- */

/** escapeHtml's twin from importers.ts, kept local to stay dependency-light. */
function escapeHtmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The content half of an HTML export: sanitised, with attachment images
 * resolved to data URLs (or an "[Image]" placeholder), note-link chips
 * unwrapped to their label text, and chart divs replaced by a styled
 * placeholder paragraph naming the chart type.
 */
export function resolveExportContent(html: string, resolveImage?: AttachmentResolver): string {
  const clean = sanitizeHtml(html);
  const body = parseBody(clean);
  if (!body) return clean;
  const doc = body.ownerDocument;

  for (const img of Array.from(body.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    if (!src.startsWith(ATTACHMENT_PREFIX)) continue;
    const data = resolveImage?.(src.slice(ATTACHMENT_PREFIX.length));
    if (data) {
      img.setAttribute("src", data);
    } else {
      const placeholder = doc.createElement("span");
      placeholder.textContent = "[Image]";
      img.replaceWith(placeholder);
    }
  }
  for (const chip of Array.from(body.querySelectorAll("span[data-note-link]"))) {
    chip.replaceWith(doc.createTextNode(chip.textContent ?? ""));
  }
  for (const div of Array.from(body.querySelectorAll('div[data-type="noma-chart"]'))) {
    const placeholder = doc.createElement("p");
    placeholder.setAttribute("class", "noma-chart-placeholder");
    placeholder.textContent = chartPlaceholder(div.getAttribute("data-chart-type"));
    div.replaceWith(placeholder);
  }
  return body.innerHTML;
}

const EXPORT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #ffffff; color: #1f1f23; }
  main {
    max-width: 44rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem;
    font-family: ui-serif, Georgia, "Times New Roman", serif;
    font-size: 17px; line-height: 1.7;
  }
  h1 {
    font-size: 1.9em; font-weight: 600; line-height: 1.25; letter-spacing: -0.01em;
    margin: 0 0 1em; padding-bottom: 0.4em; border-bottom: 1px solid #e7e7ea;
  }
  h2 { font-size: 1.4em; font-weight: 600; line-height: 1.25; margin-top: 1.6em; }
  h3 { font-size: 1.18em; font-weight: 600; line-height: 1.25; margin-top: 1.6em; }
  h4 { font-size: 1em; font-weight: 600; line-height: 1.25; margin-top: 1.6em; }
  main > * + * { margin-top: 0.85em; }
  ul, ol { padding-left: 1.4em; }
  li > p { margin: 0; }
  ul[data-type="taskList"] { list-style: none; padding-left: 0.15em; }
  ul[data-type="taskList"] li { display: flex; gap: 0.6em; align-items: flex-start; }
  ul[data-type="taskList"] input[type="checkbox"] { margin-top: 0.45em; }
  blockquote { border-left: 2px solid #d9d9de; padding-left: 1em; margin-left: 0; color: #55555c; font-style: italic; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.87em; background: #f4f4f5; padding: 0.12em 0.35em; border-radius: 4px; }
  pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 8px; padding: 0.9em 1em; overflow-x: auto; font-size: 0.88em; }
  pre code { background: none; padding: 0; }
  mark { background: rgba(93, 95, 239, 0.28); color: inherit; border-radius: 3px; padding: 0 0.15em; }
  a { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
  img { max-width: 100%; height: auto; border-radius: 8px; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #e4e4e7; padding: 0.4em 0.6em; text-align: left; }
  hr { border: none; border-top: 1px solid #e4e4e7; }
  .noma-chart-placeholder {
    border: 1px dashed #c6c6cc; border-radius: 8px; padding: 1em;
    text-align: center; color: #66666d; font-family: system-ui, sans-serif; font-size: 0.9em;
  }
`.trim();

/**
 * A complete standalone HTML document for the note: inline styles only,
 * the title as the page heading, then the resolved content. The content
 * must already have passed through resolveExportContent (which sanitises).
 */
export function buildHtmlExport(note: Pick<Note, "title">, resolvedContentHtml: string): string {
  const title = escapeHtmlText(exportTitle(note));
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>\n${EXPORT_CSS}\n</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<h1>${title}</h1>`,
    resolvedContentHtml,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/* ---------------- File names + assembly ---------------- */

const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  html: "html",
  markdown: "md",
  text: "txt",
};

const FORMAT_MIME_TYPES: Record<ExportFormat, string> = {
  html: "text/html",
  markdown: "text/markdown",
  text: "text/plain",
};

/**
 * A filesystem-safe file name from the note title: path-hostile and
 * control characters stripped, whitespace collapsed, capped at ~80
 * characters. Unicode letters survive — a Bengali title stays Bengali.
 */
export function exportFilename(note: Pick<Note, "title">, format: ExportFormat): string {
  const cleaned = exportTitle(note)
    .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  const capped = [...cleaned].slice(0, 80).join("").trim() || "Untitled note";
  return `${capped}.${FORMAT_EXTENSIONS[format]}`;
}

/** Builds the final export file (name, MIME type, content) for a format. */
export function buildNoteExport(
  note: NoteContent,
  format: ExportFormat,
  resolveImage?: AttachmentResolver,
): NoteExportArtifact {
  let content: string;
  switch (format) {
    case "html":
      content = buildHtmlExport(note, resolveExportContent(note.content, resolveImage));
      break;
    case "markdown":
      content = noteToMarkdown(note, resolveImage);
      break;
    case "text":
      content = noteToPlainText(note, resolveImage);
      break;
  }
  return { fileName: exportFilename(note, format), mimeType: FORMAT_MIME_TYPES[format], content };
}

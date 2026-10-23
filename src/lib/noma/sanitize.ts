const ALLOWED_TAGS = new Set([
  "P",
  "BR",
  "H1",
  "H2",
  "H3",
  "H4",
  "STRONG",
  "B",
  "EM",
  "I",
  "U",
  "S",
  "MARK",
  "CODE",
  "PRE",
  "BLOCKQUOTE",
  "UL",
  "OL",
  "LI",
  "A",
  "IMG",
  "HR",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TH",
  "TD",
  "SPAN",
  "DIV",
  "LABEL",
  "INPUT",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  A: new Set(["href", "target", "rel"]),
  IMG: new Set(["src", "alt", "title", "data-attachment-id"]),
  UL: new Set(["data-type"]),
  LI: new Set(["data-checked", "data-type"]),
  INPUT: new Set(["type", "checked", "disabled"]),
  TD: new Set(["colspan", "rowspan"]),
  TH: new Set(["colspan", "rowspan"]),
  // Note-link chips (see links.ts): the marker + target id must survive
  // sanitising or every link would be stripped on the next autosave.
  SPAN: new Set(["data-note-link", "data-note-id"]),
  DIV: new Set([
    "data-type",
    "data-version",
    "data-chart-type",
    "data-title",
    "data-subtitle",
    "data-categories",
    "data-series",
    "data-options",
    "data-chart",
  ]),
};

/** Tags allowed to carry an inline `style` limited to colour declarations. */
const STYLE_TAGS = new Set([
  "SPAN",
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "LI",
  "TD",
  "TH",
  "STRONG",
  "EM",
  "U",
  "S",
  "MARK",
  "BLOCKQUOTE",
  "DIV",
]);

const COLOR_VALUE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|[a-z]+)$/i;

/** Keeps only colour/background-colour declarations with safe values. */
function safeStyle(value: string): string | null {
  const kept: string[] = [];
  for (const part of value.split(";")) {
    const [rawProp, ...rest] = part.split(":");
    if (!rawProp || rest.length === 0) continue;
    const prop = rawProp.trim().toLowerCase();
    const val = rest.join(":").trim();
    if (prop !== "color" && prop !== "background-color") continue;
    if (!COLOR_VALUE.test(val)) continue;
    kept.push(`${prop}: ${val}`);
  }
  return kept.length ? kept.join("; ") : null;
}

function safeUrl(value: string, allowData: boolean): string | null {
  const trimmed = value.trim();
  if (/^(https?:|mailto:|#|\/|noma-attachment:\/\/)/i.test(trimmed)) return trimmed;
  if (allowData && /^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(trimmed)) return trimmed;
  return null;
}

/** Strips everything outside the editor's allowlist so imported notes can't inject scripts. */
export function sanitizeHtml(html: string): string {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    // No DOM available (SSR): drop markup rather than trusting it.
    return html.replace(/<[^>]*>/g, "");
  }
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");

  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (!ALLOWED_TAGS.has(child.tagName)) {
        child.replaceWith(...Array.from(child.childNodes));
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        const allowed = ALLOWED_ATTRS[child.tagName];
        const name = attr.name.toLowerCase();
        if (name === "style" && STYLE_TAGS.has(child.tagName)) {
          const style = safeStyle(attr.value);
          if (style) child.setAttribute("style", style);
          else child.removeAttribute("style");
          continue;
        }
        if (!allowed?.has(name)) {
          child.removeAttribute(attr.name);
          continue;
        }
        if (name === "href" || name === "src") {
          const url = safeUrl(attr.value, name === "src");
          if (!url) child.removeAttribute(attr.name);
          else child.setAttribute(attr.name, url);
        }
      }
      if (child.tagName === "A") {
        child.setAttribute("rel", "noopener noreferrer nofollow");
        child.setAttribute("target", "_blank");
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export function htmlToPlainText(html: string): string {
  if (typeof window === "undefined" || typeof DOMParser === "undefined") {
    return html.replace(/<[^>]*>/g, " ");
  }
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  return (doc.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function countWords(html: string): number {
  const text = htmlToPlainText(html);
  return text ? text.split(/\s+/).length : 0;
}

import { notePreviewText } from "./note-export";
import { htmlToPlainText } from "./sanitize";
import type { Folder, Note, Tag } from "./types";

export interface SearchResult {
  note: Note;
  score: number;
  snippet: string;
}

/**
 * The index just past the token when the occurrence of `term` at `idx`
 * in the lowercased preview text is part of a generated ordered-list
 * marker, or -1 when it isn't. Generated markers are the one place the
 * preview text contains characters the note itself doesn't — they
 * render as "<token>. ", the token being the item's number, letter or
 * roman numeral — so an occurrence only counts as marker-shaped when it
 * starts at a token boundary (start of text, or a non-alphanumeric char
 * before it), the term sits inside that maximal alphanumeric token, and
 * the token is immediately followed by "." and a space (or "." at the
 * end of the text).
 */
function markerTokenEnd(lowerText: string, idx: number, term: string): number {
  if (idx > 0 && /[a-z0-9]/.test(lowerText.charAt(idx - 1))) return -1;
  let end = idx;
  while (end < lowerText.length && /[a-z0-9]/.test(lowerText.charAt(end))) end += 1;
  if (end - idx < term.length) return -1;
  if (lowerText.charAt(end) !== ".") return -1;
  const after = lowerText.charAt(end + 1);
  return after === "" || after === " " ? end : -1;
}

/**
 * Where to window the snippet for a body match: the first occurrence of
 * `term` in the preview text that is real note content, skipping
 * occurrences that are generated list markers — a numeric query would
 * otherwise window on an item's printed number instead of the match the
 * flat-text scoring actually found. When every occurrence is
 * marker-shaped (typed text can itself look like "2. …"), fall back to
 * the first occurrence overall, the previous behaviour; -1 when the
 * term doesn't occur in the structured text at all.
 */
function findSnippetMatch(lowerText: string, term: string): number {
  let firstIdx = -1;
  let from = 0;
  for (;;) {
    const idx = lowerText.indexOf(term, from);
    if (idx < 0) return firstIdx;
    if (firstIdx < 0) firstIdx = idx;
    const end = markerTokenEnd(lowerText, idx, term);
    if (end < 0) return idx;
    from = end;
  }
}

/**
 * The result snippet, cut from the structure-aware preview text (the
 * same text the note-list cards render since PR #94) so list items keep
 * their markers. Scoring runs on the flat extractor above; only this
 * display text is structured. The match window is located in the
 * structured text because the markers shift every offset, skipping
 * generated markers so a numeric term windows on typed digits rather
 * than an item's printed number; when the flat body match can't be
 * found there (e.g. it spanned a marker boundary), fall back to the
 * head of the note, exactly like a title-only match.
 * Only ever called for notes that matched, so the DOM walk behind
 * notePreviewText never runs for non-results.
 */
function buildSnippet(note: Note, firstTerm: string, bodyMatched: boolean): string {
  const text = notePreviewText(note.content);
  if (bodyMatched) {
    const idx = findSnippetMatch(text.toLowerCase(), firstTerm);
    if (idx >= 0) {
      return `${idx > 30 ? "…" : ""}${text.slice(Math.max(0, idx - 30), idx + 110)}…`;
    }
  }
  return text.slice(0, 120);
}

/** Modular local search — swap the scoring here to add fuzzy/semantic search later. */
export function searchNotes(
  query: string,
  notes: Note[],
  folders: Folder[],
  tags: Tag[],
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const folderName = new Map(folders.map((f) => [f.id, f.name.toLowerCase()]));
  const tagName = new Map(tags.map((t) => [t.id, t.name.toLowerCase()]));

  const results: SearchResult[] = [];
  for (const note of notes) {
    // Templates are starting points, not notes: never search them.
    if (note.isTemplate) continue;
    const title = note.title.toLowerCase();
    // Locked notes are title-only: their sealed body is never searched and
    // never appears in a snippet.
    const body = note.lock ? "" : htmlToPlainText(note.content).toLowerCase();
    const haystackTags = note.tagIds.map((id) => tagName.get(id) ?? "").join(" ");
    const haystackFolder = note.folderId ? (folderName.get(note.folderId) ?? "") : "";

    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      let termScore = 0;
      if (title.includes(term)) termScore += 6;
      if (body.includes(term)) termScore += 3;
      if (haystackTags.includes(term)) termScore += 2;
      if (haystackFolder.includes(term)) termScore += 1;
      if (termScore === 0) matchedAll = false;
      score += termScore;
    }
    if (!matchedAll) continue;

    const idx = body.indexOf(terms[0]!);
    const snippet = note.lock ? "" : buildSnippet(note, terms[0]!, idx >= 0);
    results.push({ note, score, snippet });
  }
  return results.sort((a, b) => b.score - a.score || b.note.updatedAt - a.note.updatedAt);
}

export function highlightTerms(
  text: string,
  query: string,
): Array<{ text: string; match: boolean }> {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [{ text, match: false }];
  const pattern = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part) => ({ text: part, match: terms.includes(part.toLowerCase()) }));
}

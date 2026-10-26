import { notePreviewText } from "./note-export";
import { htmlToPlainText } from "./sanitize";
import type { Folder, Note, Tag } from "./types";

export interface SearchResult {
  note: Note;
  score: number;
  snippet: string;
}

/**
 * The result snippet, cut from the structure-aware preview text (the
 * same text the note-list cards render since PR #94) so list items keep
 * their markers. Scoring runs on the flat extractor above; only this
 * display text is structured. The match window is located in the
 * structured text because the markers shift every offset; when the flat
 * body match can't be found there (e.g. it spanned a marker boundary),
 * fall back to the head of the note, exactly like a title-only match.
 * Only ever called for notes that matched, so the DOM walk behind
 * notePreviewText never runs for non-results.
 */
function buildSnippet(note: Note, firstTerm: string, bodyMatched: boolean): string {
  const text = notePreviewText(note.content);
  if (bodyMatched) {
    const idx = text.toLowerCase().indexOf(firstTerm);
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

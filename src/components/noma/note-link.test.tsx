// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { SuggestionPluginKey } from "@tiptap/suggestion";
import { sanitizeHtml } from "@/lib/noma/sanitize";
import { createNomaExtensions } from "./tiptap-extensions";
import type { NoteLinkItem } from "./note-link-picker";

(globalThis as unknown as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const CANDIDATES: NoteLinkItem[] = [
  { id: "id-quarterly", title: "Quarterly plan" },
  { id: "id-quotes", title: "Quotes to keep" },
  { id: "id-garden", title: "Garden log" },
];

let editor: Editor | null = null;

function createEditor(content = "<p></p>") {
  const element = document.createElement("div");
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: createNomaExtensions({
      noteLinkItems: (query) =>
        CANDIDATES.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())),
    }),
    content,
  });
  editor.commands.focus("end");
  return editor;
}

function suggestionState(instance: Editor) {
  return SuggestionPluginKey.getState(instance.state);
}

function keydown(instance: Editor, key: string) {
  instance.view.dom.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = "";
});

describe("noteLink [[ suggestion (real editor)", () => {
  it("typing [[ activates the suggestion with the typed query", async () => {
    const instance = createEditor();
    instance.commands.insertContent("[[Quar");

    const state = suggestionState(instance);
    expect(state?.active).toBe(true);
    expect(state?.query).toBe("Quar");

    // The picker mounted with the matching candidate only.
    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
    });
    const options = Array.from(document.body.querySelectorAll('[role="option"]')).map((el) =>
      el.textContent?.trim(),
    );
    expect(options).toEqual(["Quarterly plan"]);
  });

  it("Enter inserts the chip: doc node, serialized HTML, sanitize round trip", async () => {
    const instance = createEditor();
    instance.commands.insertContent("[[Quar");
    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
    });

    keydown(instance, "Enter");

    const linkNodes: { attrs: Record<string, unknown> }[] = [];
    instance.state.doc.descendants((node) => {
      if (node.type.name === "noteLink") {
        linkNodes.push({ attrs: node.attrs as Record<string, unknown> });
      }
    });
    expect(linkNodes).toEqual([{ attrs: { noteId: "id-quarterly", label: "Quarterly plan" } }]);
    expect(suggestionState(instance)?.active).toBe(false);

    const html = instance.getHTML();
    expect(html).toContain('data-note-link=""');
    expect(html).toContain('data-note-id="id-quarterly"');
    expect(html).toContain("Quarterly plan");

    // The release gate: what updateNote stores must keep the chip whole.
    const stored = sanitizeHtml(html);
    const chip = new DOMParser()
      .parseFromString(stored, "text/html")
      .querySelector("span[data-note-link]");
    expect(chip?.getAttribute("data-note-id")).toBe("id-quarterly");
    expect(chip?.textContent).toBe("Quarterly plan");
  });

  it("Escape dismisses the picker without changing the document", async () => {
    const instance = createEditor();
    instance.commands.insertContent("[[Ga");
    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="listbox"]')).not.toBeNull();
    });

    keydown(instance, "Escape");

    expect(suggestionState(instance)?.active).toBe(false);
    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="listbox"]')).toBeNull();
    });
    // The literal text stays; only the picker went away.
    expect(instance.state.doc.textContent).toContain("[[Ga");
  });

  it("typing [[ inside a code block does not activate the suggestion", async () => {
    // Trailing space so the `[[` has an allowed prefix and the suggestion
    // matcher genuinely finds a match — only the code guard can stop it.
    const instance = createEditor("<pre><code>const x = </code></pre>");
    instance.commands.insertContent("[[Quar");

    expect(suggestionState(instance)?.active).toBe(false);
    // Give the picker a chance to mount — it must not.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
    // The typed text landed in the code block, exactly as typed.
    const codeBlocks: string[] = [];
    instance.state.doc.descendants((node) => {
      if (node.type.name === "codeBlock") codeBlocks.push(node.textContent);
    });
    expect(codeBlocks).toEqual(["const x = [[Quar"]);
  });

  it("typing [[ inside inline code does not activate the suggestion", async () => {
    const instance = createEditor("<p>see <code>git log</code> end</p>");
    // "git log" spans doc positions 5–12; position 9 sits inside the code
    // segment, right after its space — an allowed prefix for the matcher,
    // so again only the code guard can stop the suggestion.
    instance.commands.setTextSelection(9);
    instance.commands.insertContent("[[Gi");

    expect(suggestionState(instance)?.active).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
    expect(instance.state.doc.textContent).toContain("git [[Gilog");
  });

  it("a stored chip parses back into a noteLink node (schema parity)", () => {
    const element = document.createElement("div");
    document.body.appendChild(element);
    const reader = new Editor({
      element,
      extensions: createNomaExtensions(),
      content: `<p>See <span data-note-link="" data-note-id="id-garden">Garden log</span> today.</p>`,
    });
    const types: string[] = [];
    reader.state.doc.descendants((node) => {
      types.push(node.type.name);
    });
    expect(types).toContain("noteLink");
    reader.destroy();
  });
});

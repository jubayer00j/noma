import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { attachCaretAboveKeyboard } from "@/lib/noma/keyboard-scroll";
import {
  Bold,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Image as ImageIcon,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Strikethrough,
  Baseline,
  PaintBucket,
  Table as TableIcon,
  Underline as UnderlineIcon,
  Upload,
  Globe,
  BarChart2,
  Plus,
  Trash2,
  Mic,
  Loader2,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import type { Note, SpeechLanguageSetting } from "@/lib/noma/types";
import {
  createSpeechSession,
  defaultSpeechEngine,
  dictationInsertionText,
  resolveSpeechLanguageTag,
  type SpeechErrorKind,
  type SpeechSessionSnapshot,
} from "@/lib/noma/speech";
import { useDatabase } from "@/lib/noma/DatabaseContext";
import { saveImageAttachment, scheduleDebouncedAttachmentCleanup } from "@/lib/noma/media";
import { ChartEditorDialog, type AdvancedChartData } from "./chart-node";
import { createNomaExtensions } from "./tiptap-extensions";
import type { NoteLinkItem } from "./note-link-picker";

export type SaveState = "idle" | "saving" | "saved" | "offline";

interface NoteEditorProps {
  note: Note;
  onChange: (patch: { title?: string; content?: string }) => void;
  fontSize: number;
  editorWidth: number;
  lineHeight: number;
  /** Dictation language for voice capture; defaults to the system language. */
  speechLanguage?: SpeechLanguageSetting;
  /** Candidates for the `[[` note-link picker; omit to disable inserting links. */
  noteLinkItems?: (query: string) => NoteLinkItem[];
}

/** Calm one-liners for the dictation strip, one per error kind. */
const SPEECH_ERROR_LINES: Record<SpeechErrorKind, string> = {
  permission: "Microphone access was denied — you can allow it in your device settings.",
  unavailable: "Voice capture isn't available on this device.",
  "no-speech": "Didn't catch that — try again, a little closer to the mic.",
  "no-match": "Didn't catch that — try again.",
  "speech-timeout": "Didn't catch that — try again.",
  network: "The speech service needs a connection on this device.",
  audio: "The microphone couldn't be read.",
  busy: "The recogniser is busy — try again in a moment.",
  server: "The speech service had a problem — try again.",
  client: "Voice capture stopped unexpectedly.",
};

function ToolbarButton({
  onClick,
  active,
  disabled,
  label,
  children,
  className,
}: {
  onClick: (e: React.MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
  className?: string | undefined;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        "inline-flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40",
        active && "bg-accent text-foreground font-medium shadow-xs ring-1 ring-border/50",
        className,
      )}
    >
      {children}
    </button>
  );
}

const TEXT_COLORS = [
  { name: "Default", value: null },
  { name: "Ink", value: "#1f1b16" },
  { name: "Slate", value: "#4b5563" },
  { name: "Red", value: "#b3261e" },
  { name: "Amber", value: "#b45309" },
  { name: "Green", value: "#15803d" },
  { name: "Blue", value: "#1d4ed8" },
  { name: "Violet", value: "#6d28d9" },
];

const BG_COLORS = [
  { name: "None", value: null },
  { name: "Sand", value: "#f4ead9" },
  { name: "Rose", value: "#fbe0e0" },
  { name: "Peach", value: "#fde4cf" },
  { name: "Lemon", value: "#fbf1c7" },
  { name: "Mint", value: "#dcf3e4" },
  { name: "Sky", value: "#dde9fb" },
  { name: "Lilac", value: "#e8e0fb" },
];

function ColorPicker({
  label,
  icon,
  swatches,
  current,
  onPick,
}: {
  label: string;
  icon: React.ReactNode;
  swatches: { name: string; value: string | null }[];
  current?: string | undefined;
  onPick: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          aria-label={label}
          title={label}
          className="relative inline-flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {icon}
          <span
            aria-hidden
            className="absolute bottom-1.5 left-1/2 h-1 w-4 -translate-x-1/2 rounded-full border border-border"
            style={{ backgroundColor: current ?? "transparent" }}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-52 p-3"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <p className="mb-2 text-xs font-medium text-muted-foreground">{label}</p>
        <div className="grid grid-cols-4 gap-2">
          {swatches.map((swatch) => {
            const selected = (current ?? null) === swatch.value;
            return (
              <button
                key={swatch.name}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onPick(swatch.value);
                  setOpen(false);
                }}
                title={swatch.name}
                aria-label={swatch.name}
                aria-pressed={selected}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-md border border-border transition-transform hover:scale-105 touch-manipulation",
                  selected && "ring-2 ring-ring ring-offset-1 ring-offset-background",
                )}
                style={{ backgroundColor: swatch.value ?? "transparent" }}
              >
                {swatch.value === null && (
                  <span className="text-[10px] text-muted-foreground">/</span>
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ContextualTableBar({ editor }: { editor: Editor }) {
  if (!editor.isActive("table")) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1 rounded-lg border border-border bg-card/90 p-1.5 backdrop-blur-xs text-xs">
      <span className="px-2 font-semibold text-muted-foreground">Table:</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs gap-1"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().addRowBefore().run()}
      >
        <Plus className="size-3" /> Row Above
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs gap-1"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().addRowAfter().run()}
      >
        <Plus className="size-3" /> Row Below
      </Button>
      <Separator orientation="vertical" className="!h-4" />
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs gap-1"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().addColumnBefore().run()}
      >
        <Plus className="size-3" /> Col Left
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs gap-1"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().addColumnAfter().run()}
      >
        <Plus className="size-3" /> Col Right
      </Button>
      <Separator orientation="vertical" className="!h-4" />
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs gap-1 text-destructive hover:text-destructive"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().deleteRow().run()}
      >
        Delete Row
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs gap-1 text-destructive hover:text-destructive"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().deleteColumn().run()}
      >
        Delete Col
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs gap-1 font-semibold text-destructive hover:text-destructive"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor.chain().focus().deleteTable().run()}
      >
        <Trash2 className="size-3" /> Remove Table
      </Button>
    </div>
  );
}

function Toolbar({
  editor,
  onUploadImageClick,
  onInsertTableClick,
  onInsertChartClick,
}: {
  editor: Editor;
  onUploadImageClick: () => void;
  onInsertTableClick: () => void;
  onInsertChartClick: () => void;
}) {
  const addLink = () => {
    const previous = editor.getAttributes("link")["href"] as string | undefined;
    const url = window.prompt("Link URL", previous ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const addImageUrl = () => {
    const url = window.prompt("Image URL", "https://");
    if (url) editor.chain().focus().setImage({ src: url }).run();
  };

  return (
    <div className="noma-scroll flex items-center gap-0.5 overflow-x-auto py-0.5">
      <ToolbarButton
        label="Bold"
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Italic"
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Underline"
        active={editor.isActive("underline")}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        <UnderlineIcon className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Strikethrough"
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        <Strikethrough className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Highlight"
        active={editor.isActive("highlight")}
        onClick={() => editor.chain().focus().toggleHighlight().run()}
      >
        <Highlighter className="size-4" />
      </ToolbarButton>

      <ColorPicker
        label="Font colour"
        icon={<Baseline className="size-4" />}
        swatches={TEXT_COLORS}
        current={editor.getAttributes("textStyle")["color"] as string | undefined}
        onPick={(value) =>
          value
            ? editor.chain().focus().setColor(value).run()
            : editor.chain().focus().unsetColor().run()
        }
      />
      <ColorPicker
        label="Paragraph colour"
        icon={<PaintBucket className="size-4" />}
        swatches={BG_COLORS}
        current={editor.getAttributes("textStyle")["backgroundColor"] as string | undefined}
        onPick={(value) => {
          if (value) {
            editor.chain().focus().setBackgroundColor(value).run();
          } else {
            editor.chain().focus().unsetBackgroundColor().run();
          }
        }}
      />

      <Separator orientation="vertical" className="mx-1 !h-5" />

      <ToolbarButton
        label="Heading 1"
        active={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Heading 2"
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Heading 3"
        active={editor.isActive("heading", { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 className="size-4" />
      </ToolbarButton>

      <Separator orientation="vertical" className="mx-1 !h-5" />

      <ToolbarButton
        label="Bullet list"
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Numbered list"
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Checklist"
        active={editor.isActive("taskList")}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      >
        <ListTodo className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Quote"
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote className="size-4" />
      </ToolbarButton>
      <ToolbarButton
        label="Code block"
        active={editor.isActive("codeBlock")}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        <Code2 className="size-4" />
      </ToolbarButton>

      <Separator orientation="vertical" className="mx-1 !h-5" />

      <ToolbarButton label="Link" active={editor.isActive("link")} onClick={addLink}>
        <Link2 className="size-4" />
      </ToolbarButton>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            title="Insert Image"
            aria-label="Insert Image"
            className="inline-flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ImageIcon className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={onUploadImageClick} className="gap-2 text-xs">
            <Upload className="size-4" /> Upload Photo from Device
          </DropdownMenuItem>
          <DropdownMenuItem onClick={addImageUrl} className="gap-2 text-xs">
            <Globe className="size-4" /> Insert Image URL
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ToolbarButton label="Table" active={editor.isActive("table")} onClick={onInsertTableClick}>
        <TableIcon className="size-4" />
      </ToolbarButton>

      <ToolbarButton label="Chart" onClick={onInsertChartClick}>
        <BarChart2 className="size-4" />
      </ToolbarButton>

      <ToolbarButton
        label="Divider"
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      >
        <Minus className="size-4" />
      </ToolbarButton>
    </div>
  );
}

export function NoteEditor({
  note,
  onChange,
  fontSize,
  editorWidth,
  lineHeight,
  speechLanguage = "system",
  noteLinkItems,
}: NoteEditorProps) {
  const { db } = useDatabase();
  const [showToolbar, setShowToolbar] = useState(true);
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [tableRows, setTableRows] = useState("3");
  const [tableCols, setTableCols] = useState("3");
  const [tableHeader, setTableHeader] = useState(true);

  const [chartDialogOpen, setChartDialogOpen] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const loadedNoteId = useRef(note.id);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // The editor (and its extension set) is created once per note; route the
  // `[[` candidate lookup through a ref so the picker always sees the
  // freshest library, not the notes as of editor creation.
  const noteLinkItemsRef = useRef(noteLinkItems);
  useEffect(() => {
    noteLinkItemsRef.current = noteLinkItems;
  }, [noteLinkItems]);

  const dbRef = useRef(db);
  useEffect(() => {
    dbRef.current = db;
  }, [db]);

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: createNomaExtensions(
        noteLinkItems
          ? { noteLinkItems: (query) => noteLinkItemsRef.current?.(query) ?? [] }
          : {},
      ),
      content: note.content,
      editorProps: { attributes: { class: "tiptap", spellcheck: "true" } },
      onUpdate: ({ editor: instance }) => {
        const html = instance.getHTML();
        onChangeRef.current({ content: html });
        if (dbRef.current) {
          scheduleDebouncedAttachmentCleanup(dbRef.current);
        }
      },
    },
    [note.id],
  );

  // Swap document when a different note is opened, without clobbering typing.
  useEffect(() => {
    if (!editor || loadedNoteId.current === note.id) return;
    loadedNoteId.current = note.id;
    editor.commands.setContent(note.content || "", { emitUpdate: false });
  }, [editor, note.id, note.content]);

  useEffect(() => {
    const textarea = titleRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [note.title, note.id]);

  // Caret-above-keyboard: while editing, keep the current line above the
  // on-screen keyboard (see keyboard-scroll.ts). The note surface is the
  // editor's scroll container; finding it from the editor DOM keeps
  // workspace.tsx's scroll preservation untouched, and this effect only
  // exists in edit mode (NoteEditor never mounts for the read view).
  useEffect(() => {
    if (!editor) return;
    const scroller = editor.view.dom.closest('[data-testid="note-surface"]');
    if (!(scroller instanceof HTMLElement)) return;
    return attachCaretAboveKeyboard(editor, scroller);
  }, [editor]);

  // Voice capture (PR-B): one speech session per editor mount. The
  // workspace keys this component by note id, so a note switch, an App
  // Lock or leaving edit mode unmounts it — the cleanup cancels the
  // session, and no transcript can leak across notes. The mic is only
  // offered once the engine probe says a recogniser exists.
  const speechRuntime = useMemo(() => {
    const engine = defaultSpeechEngine();
    return engine ? { engine, session: createSpeechSession(engine) } : null;
  }, []);
  const [speechAvailable, setSpeechAvailable] = useState(false);
  const [speechSnapshot, setSpeechSnapshot] = useState<SpeechSessionSnapshot | null>(null);
  const insertedSegmentsRef = useRef(0);

  useEffect(() => {
    if (!speechRuntime) return;
    let live = true;
    speechRuntime.engine
      .probe()
      .then((probe) => {
        if (live) setSpeechAvailable(probe.available);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [speechRuntime]);

  useEffect(() => {
    if (!speechRuntime) return;
    const { session } = speechRuntime;
    setSpeechSnapshot(session.getSnapshot());
    const unsubscribe = session.subscribe(setSpeechSnapshot);
    return () => {
      unsubscribe();
      session.cancel();
    };
  }, [speechRuntime]);

  // Committed finals land at the caret, in order, exactly once each.
  useEffect(() => {
    if (!editor || !speechSnapshot) return;
    const committed = speechSnapshot.committed;
    while (insertedSegmentsRef.current < committed.length) {
      const segment = committed[insertedSegmentsRef.current];
      insertedSegmentsRef.current += 1;
      if (!segment) continue;
      const { from } = editor.state.selection;
      const beforeChar = from > 0 ? editor.state.doc.textBetween(from - 1, from) : "";
      const text = dictationInsertionText(beforeChar, segment);
      if (text) editor.chain().focus().insertContent(text).run();
    }
  }, [editor, speechSnapshot]);

  const toggleDictation = () => {
    if (!speechRuntime) return;
    const { session } = speechRuntime;
    const state = session.getSnapshot().state;
    if (state === "listening") {
      session.stop();
    } else if (state === "idle" || state === "error") {
      void session.start(resolveSpeechLanguageTag(speechLanguage, navigator.language));
    }
  };

  const dismissSpeechError = () => {
    if (!speechRuntime) return;
    insertedSegmentsRef.current = 0;
    speechRuntime.session.reset();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0 || !editor || !db) return;

    const file = files[0];
    if (!file || !file.type.startsWith("image/")) {
      toast.error("Please select a valid image file");
      return;
    }

    try {
      toast.loading("Processing photo...", { id: "photo-upload" });
      const attachment = await saveImageAttachment(db, note.id, file);
      // Store single-source attachment reference rather than raw data URL
      editor
        .chain()
        .focus()
        .setImage({ src: `noma-attachment://${attachment.id}`, alt: attachment.name })
        .run();
      toast.success("Photo added to note", { id: "photo-upload" });
    } catch (err) {
      console.error("Failed to upload image", err);
      toast.error("Failed to save image attachment", { id: "photo-upload" });
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleCreateTable = () => {
    if (!editor) return;
    const rows = Math.max(1, Math.min(20, parseInt(tableRows, 10) || 3));
    const cols = Math.max(1, Math.min(10, parseInt(tableCols, 10) || 3));
    editor.chain().focus().insertTable({ rows, cols, withHeaderRow: tableHeader }).run();
    setTableDialogOpen(false);
  };

  const handleSaveChart = (chartAttrs: AdvancedChartData) => {
    if (!editor) return;
    editor.chain().focus().insertContent({ type: "nomaChart", attrs: chartAttrs }).run();
  };

  return (
    <div
      className="noma-editor mx-auto w-full px-5 pb-32 sm:px-8"
      style={
        {
          maxWidth: `${editorWidth}px`,
          "--noma-font-size": `${fontSize}px`,
          "--noma-line-height": String(lineHeight),
        } as React.CSSProperties
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        aria-label="Upload photo"
        className="hidden"
        onChange={handleFileChange}
      />

      <textarea
        ref={titleRef}
        enterKeyHint="next"
        value={note.title}
        onChange={(event) => onChange({ title: event.target.value.replace(/\n/g, "") })}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            editor?.commands.focus("start");
          }
        }}
        rows={1}
        placeholder="Untitled"
        aria-label="Note title"
        className="mt-8 mb-4 w-full resize-none border-0 bg-transparent font-serif text-3xl leading-tight font-semibold tracking-tight text-foreground placeholder:text-muted-foreground/50 focus:outline-none sm:text-4xl"
      />

      {editor && (
        <>
          <div className="sticky top-0 z-10 -mx-2 mb-4 flex flex-col border-b border-border/70 bg-background/85 px-2 py-1.5 backdrop-blur-sm">
            <div className="flex items-center gap-1">
              {showToolbar ? (
                <Toolbar
                  editor={editor}
                  onUploadImageClick={() => fileInputRef.current?.click()}
                  onInsertTableClick={() => setTableDialogOpen(true)}
                  onInsertChartClick={() => setChartDialogOpen(true)}
                />
              ) : (
                <span className="px-1 text-xs text-muted-foreground">Formatting hidden</span>
              )}
              {speechAvailable && speechSnapshot && (
                <ToolbarButton
                  label={speechSnapshot.state === "listening" ? "Stop dictation" : "Dictate"}
                  active={speechSnapshot.state === "listening"}
                  disabled={
                    speechSnapshot.state === "requesting-permission" ||
                    speechSnapshot.state === "stopping"
                  }
                  onClick={toggleDictation}
                  className={
                    speechSnapshot.state === "listening"
                      ? "text-destructive hover:text-destructive"
                      : undefined
                  }
                >
                  {speechSnapshot.state === "requesting-permission" ||
                  speechSnapshot.state === "stopping" ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Mic className="size-4" />
                  )}
                </ToolbarButton>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto shrink-0 text-xs text-muted-foreground"
                onClick={() => setShowToolbar((value) => !value)}
              >
                {showToolbar ? "Hide" : "Format"}
              </Button>
            </div>
            {speechSnapshot && speechSnapshot.state !== "idle" && (
              <div className="flex items-center gap-2 px-1 pt-1 text-xs" aria-live="polite">
                {speechSnapshot.state === "error" ? (
                  <>
                    <span className="text-destructive">
                      {SPEECH_ERROR_LINES[speechSnapshot.errorKind ?? "client"]}
                    </span>
                    <button
                      type="button"
                      onClick={dismissSpeechError}
                      aria-label="Dismiss"
                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </>
                ) : (
                  <>
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        speechSnapshot.state === "listening"
                          ? "animate-pulse bg-destructive"
                          : "bg-muted-foreground/50",
                      )}
                    />
                    <span className="truncate text-muted-foreground italic">
                      {speechSnapshot.partial ||
                        (speechSnapshot.state === "listening" ? "Listening…" : "…")}
                    </span>
                  </>
                )}
              </div>
            )}
            <ContextualTableBar editor={editor} />
          </div>

          <EditorContent editor={editor} />
        </>
      )}

      {/* Table Insertion Dialog */}
      <Dialog open={tableDialogOpen} onOpenChange={setTableDialogOpen}>
        <DialogContent className="max-w-xs p-5 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-lg font-semibold">Insert Table</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Rows</Label>
                <Input
                  type="number"
                  min="1"
                  max="20"
                  value={tableRows}
                  onChange={(e) => setTableRows(e.target.value)}
                  className="mt-1 h-9"
                />
              </div>
              <div>
                <Label className="text-xs">Columns</Label>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={tableCols}
                  onChange={(e) => setTableCols(e.target.value)}
                  className="mt-1 h-9"
                />
              </div>
            </div>
            <div className="flex items-center space-x-2 pt-1">
              <Checkbox
                id="header-row"
                checked={tableHeader}
                onCheckedChange={(checked) => setTableHeader(Boolean(checked))}
              />
              <Label htmlFor="header-row" className="text-xs font-normal cursor-pointer">
                Include header row
              </Label>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setTableDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateTable} className="noma-cta">
              Insert Table
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Advanced Chart Insertion Dialog */}
      {chartDialogOpen && (
        <ChartEditorDialog
          open={chartDialogOpen}
          onOpenChange={setChartDialogOpen}
          onSave={handleSaveChart}
        />
      )}
    </div>
  );
}

import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  Check,
  Hash,
  Lock,
  Menu,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Star,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { toast } from "sonner";
import { format } from "date-fns";
import { Bell } from "lucide-react";
import { NoteEditor, type SaveState } from "./note-editor";
import { NoteReadView } from "./note-read-view";
import { NoteList, type NoteActions } from "./note-list";
import { useStableNotes } from "./use-stable-notes";
import type { VirtualListHandle } from "./virtual-list";
import { NotesListSurfaceContext } from "./notes-list-surface-context";
import { PromptDialog, type PromptRequest } from "./prompt-dialog";
import { NoteLockDialog } from "./note-lock-dialog";
import { NoteLockGate } from "./note-lock-gate";
import { NoteSessionAttachmentsContext } from "./note-session-context";
import { ReminderDialog } from "./reminder-dialog";
import { RemindersView } from "./reminders-view";
import { NomaSidebar } from "./sidebar";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useOnline, useSettings } from "@/hooks/use-noma";
import { useDatabase } from "@/lib/noma/DatabaseContext";
import { useAppLock } from "@/lib/noma/AppLockContext";
import { usePendingShortcut } from "@/lib/noma/shortcut";
import { usePendingCapture, type CaptureRequest } from "@/lib/noma/capture";
import { initShareTarget } from "@/lib/noma/share-target";
import { saveImageAttachment } from "@/lib/noma/media";
import {
  createFolder,
  createNote,
  createTag,
  deleteFolder,
  deleteNoteForever,
  deleteNoteReminder,
  deleteTag,
  duplicateNote,
  emptyTrash,
  moveNote,
  notePreview,
  noteTitle,
  pruneNotePreviewCache,
  renameFolder,
  renameTag,
  restoreNote,
  setArchived,
  setNoteReminder,
  setNoteTags,
  toggleFavorite,
  togglePinned,
  trashNote,
  updateNote,
  cleanupOrphanedReminders,
} from "@/lib/noma/notes";
import { highlightTerms, searchNotes } from "@/lib/noma/search";
import { getOrCreateDailyNote } from "@/lib/noma/daily";
import {
  createNoteFromTemplate,
  ensureBuiltinTemplates,
  saveAsTemplate,
  setDailyDefault,
} from "@/lib/noma/templates";
import { saveLockedNoteContent, type UnlockedNoteData } from "@/lib/noma/note-lock";
import type { Folder, Note, Reminder, Tag } from "@/lib/noma/types";
import { filterNotes, viewTitle, type ViewState } from "@/lib/noma/view";
import { cn } from "@/lib/utils";

interface Confirmation {
  title: string;
  description: string;
  actionLabel: string;
  onConfirm: () => void | Promise<void>;
}

interface NoteOverflowMenuProps {
  note: Note;
  tags: Tag[];
  folders: Folder[];
  onCreateTag: () => void;
  onToggleTag: (tagId: string, checked: boolean) => void;
  onMoveToFolder: (folderId: string | null) => void;
  onSetReminder: () => void;
  onDuplicate: () => void;
  onToggleArchive: () => void;
  onTrash: () => void;
  onRestore: () => void;
  onDeleteForever: () => void;
  onLockNote: () => void;
  onManageLock: () => void;
  onSaveAsTemplate?: () => void;
  onUseTemplate?: () => void;
  onToggleDailyDefault?: () => void;
}

/**
 * Secondary note actions (tags, folder, reminder, duplicate, archive, trash)
 * shared by the Read View and editor headers so both stay in sync.
 */
function NoteOverflowMenu({
  note,
  tags,
  folders,
  onCreateTag,
  onToggleTag,
  onMoveToFolder,
  onSetReminder,
  onDuplicate,
  onToggleArchive,
  onTrash,
  onRestore,
  onDeleteForever,
  onLockNote,
  onManageLock,
  onSaveAsTemplate,
  onUseTemplate,
  onToggleDailyDefault,
}: NoteOverflowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Note options">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {note.deleted ? (
          <>
            <DropdownMenuItem onClick={onRestore}>
              <RotateCcw className="size-4" /> Restore
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onDeleteForever}
            >
              <Trash2 className="size-4" /> Delete permanently
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Tags
            </DropdownMenuLabel>
            {tags.length === 0 && (
              <DropdownMenuItem onClick={onCreateTag}>
                <Plus className="size-4" /> Create a tag
              </DropdownMenuItem>
            )}
            {tags.map((tag) => (
              <DropdownMenuCheckboxItem
                key={tag.id}
                checked={note.tagIds.includes(tag.id)}
                onCheckedChange={(checked) => onToggleTag(tag.id, checked)}
              >
                <Hash className="size-3.5" /> {tag.name}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Folder
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => onMoveToFolder(null)}>
              {note.folderId === null && <Check className="size-4" />} No folder
            </DropdownMenuItem>
            {folders.map((folder) => (
              <DropdownMenuItem key={folder.id} onClick={() => onMoveToFolder(folder.id)}>
                {note.folderId === folder.id && <Check className="size-4" />} {folder.name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onSetReminder}>
              <Bell className="size-4 text-primary" />
              {note.reminderAt ? "Edit Reminder" : "Set Reminder"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate}>Duplicate</DropdownMenuItem>
            {note.isTemplate ? (
              <>
                {onUseTemplate && (
                  <DropdownMenuItem onClick={onUseTemplate}>Use template</DropdownMenuItem>
                )}
                {onToggleDailyDefault && (
                  <DropdownMenuItem onClick={onToggleDailyDefault}>
                    {note.dailyDefault && <Check className="size-4" />} Use as daily template
                  </DropdownMenuItem>
                )}
              </>
            ) : (
              !note.lock &&
              onSaveAsTemplate && (
                <DropdownMenuItem onClick={onSaveAsTemplate}>Save as template</DropdownMenuItem>
              )
            )}
            {!note.isTemplate &&
              (note.lock ? (
                <DropdownMenuItem onClick={onManageLock}>
                  <Lock className="size-4" /> Manage note lock
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={onLockNote}>
                  <Lock className="size-4" /> Lock note
                </DropdownMenuItem>
              ))}
            <DropdownMenuItem onClick={onToggleArchive}>
              {note.archived ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={onTrash}>
              <Trash2 className="size-4" /> Move to Trash
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface WorkspaceSurfacesProps {
  activeNote: Note | null;
  activeNoteId: string | null;
  noteMode: "read" | "edit";
  view: ViewState;
  /** True while the notes live query has not returned yet. */
  notesLoading: boolean;
  visibleNotes: Note[];
  allNotes: Note[];
  allFolders: Folder[];
  allTags: Tag[];
  reminders: Reminder[] | undefined;
  actions: NoteActions;
  phoneAlarmNoteIds: Set<string>;
  onOpenNote: (note: Note) => void;
  onNoteChange: (patch: { title?: string; content?: string }) => void;
  /** Unlocked session for the open locked note (decrypted attachments). */
  noteSession: { noteId: string; attachments: Map<string, string> } | null;
  onUnlockNote: (nek: Uint8Array, data: UnlockedNoteData) => void;
  fontSize: number;
  editorWidth: number;
  lineHeight: number;
}

/**
 * The two main content surfaces of the workspace.
 *
 * The notes-list surface stays mounted for the lifetime of the workspace:
 * opening a note hides it instead of unmounting it, so returning to the
 * list is instant and the list's filter/sort state is preserved. The list
 * itself is virtualized, so only the visible window plus overscan rows
 * (~20 rows) stay mounted — the retained DOM that made a full-list
 * keep-alive too expensive on low-end devices is gone. The `hidden`
 * attribute (plus an explicit CSS guard) removes the surface from layout,
 * the accessibility tree, and keyboard/pointer interaction, so the hidden
 * list is fully inert while a note is open.
 *
 * Scroll position is mirrored continuously via onScroll, so the value is
 * already saved before the surface hides (never relying on the browser
 * preserving scroll across `display: none`); it is restored explicitly —
 * plus a virtualizer viewport re-sync — when the surface shows again.
 *
 * The note surface is still mounted on demand (keyed by note id) — it is
 * cheap to construct and must always start at the top of the note.
 */
export function WorkspaceSurfaces({
  activeNote,
  activeNoteId,
  noteMode,
  view,
  notesLoading,
  visibleNotes,
  allNotes,
  allFolders,
  allTags,
  reminders,
  actions,
  phoneAlarmNoteIds,
  onOpenNote,
  onNoteChange,
  noteSession,
  onUnlockNote,
  fontSize,
  editorWidth,
  lineHeight,
}: WorkspaceSurfacesProps) {
  const noteOpen = activeNote != null;
  const sessionForActive =
    activeNote && noteSession?.noteId === activeNote.id ? noteSession : null;
  /** A locked note without a live session shows the unlock gate, never content. */
  const gateClosed = Boolean(activeNote?.lock) && !sessionForActive;
  // The list surface doubles as the virtualized list's scroll element, so
  // sibling views (reminders, loading skeletons) share the same scroller.
  // Published via state (not a ref object): the virtualizer is a child of
  // this div, and child layout effects run before the parent's ref attaches
  // — state re-renders the tree with the element as an ordinary prop,
  // synchronously during commit, before paint.
  const [surfaceEl, setSurfaceEl] = useState<HTMLDivElement | null>(null);
  const setSurfaceElCallback = useCallback((el: HTMLDivElement | null) => {
    setSurfaceEl(el);
  }, []);
  const listHandleRef = useRef<VirtualListHandle | null>(null);
  // Live scroll position, mirrored on every scroll event so the value is
  // already saved before the surface is hidden (no reliance on the browser
  // preserving scrollTop across display:none).
  const savedScrollTop = useRef(0);
  const wasNoteOpenRef = useRef(noteOpen);

  const surfaceApi = useMemo(() => ({ scrollElement: surfaceEl, listHandleRef }), [surfaceEl]);

  useEffect(() => {
    const wasOpen = wasNoteOpenRef.current;
    wasNoteOpenRef.current = noteOpen;
    if (noteOpen || wasOpen || !surfaceEl) return;
    // Restore after unhide, in the next frame so the element has layout
    // again, then re-sync the virtualizer's cached viewport height.
    const top = savedScrollTop.current;
    const raf = requestAnimationFrame(() => {
      surfaceEl.scrollTop = top;
      listHandleRef.current?.syncViewport();
    });
    return () => cancelAnimationFrame(raf);
  }, [noteOpen, surfaceEl]);

  return (
    <>
      {activeNote ? (
        <div className="noma-scroll flex-1 overflow-y-auto" data-testid="note-surface">
          {activeNote.isTemplate && (
            <div className="border-b border-border bg-accent/50 px-4 py-2 text-center text-xs text-muted-foreground">
              Template — changes here apply to future notes created from it.
            </div>
          )}
          {gateClosed ? (
            <NoteLockGate key={activeNote.id} note={activeNote} onUnlocked={onUnlockNote} />
          ) : (
            <NoteSessionAttachmentsContext.Provider
              value={sessionForActive?.attachments ?? null}
            >
              {noteMode === "read" ? (
                <NoteReadView
                  key={activeNote.id}
                  note={activeNote}
                  folders={allFolders}
                  tags={allTags}
                  fontSize={fontSize}
                  editorWidth={editorWidth}
                  lineHeight={lineHeight}
                />
              ) : (
                <NoteEditor
                  key={activeNote.id}
                  note={activeNote}
                  onChange={onNoteChange}
                  fontSize={fontSize}
                  editorWidth={editorWidth}
                  lineHeight={lineHeight}
                />
              )}
            </NoteSessionAttachmentsContext.Provider>
          )}
        </div>
      ) : null}
      <NotesListSurfaceContext.Provider value={surfaceApi}>
        <div
          ref={setSurfaceElCallback}
          className="noma-scroll notes-list-surface min-h-0 flex-1 overflow-y-auto"
          hidden={noteOpen}
          tabIndex={-1}
          data-testid="notes-list-surface"
          onScroll={(e) => {
            savedScrollTop.current = e.currentTarget.scrollTop;
          }}
        >
          {view.kind === "reminders" ? (
            <RemindersView reminders={reminders ?? []} notes={allNotes} onOpenNote={onOpenNote} />
          ) : notesLoading ? (
            <div className="space-y-3 p-4 sm:p-6" aria-busy="true" aria-label="Loading notes">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="rounded-xl border border-border/60 bg-card p-4 shadow-xs">
                  <div className="h-4 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                  <div className="mt-2.5 h-3 w-3/4 animate-pulse rounded bg-muted/70 motion-reduce:animate-none" />
                  <div className="mt-2 h-3 w-1/5 animate-pulse rounded bg-muted/50 motion-reduce:animate-none" />
                </div>
              ))}
            </div>
          ) : (
            <>
              {view.kind === "templates" && (
                <div className="mx-auto w-full max-w-3xl px-4 pt-4 sm:px-6">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Templates are starting points for new notes — open one or use it from its
                    menu. <code className="rounded bg-secondary px-1 py-0.5">{"{{date}}"}</code>{" "}
                    in a template becomes today's date when you use it.
                  </p>
                </div>
              )}
              <NoteList
                notes={visibleNotes}
                folders={allFolders}
                tags={allTags}
                view={view}
                activeNoteId={activeNoteId}
                actions={actions}
                phoneAlarmNoteIds={phoneAlarmNoteIds}
              />
            </>
          )}
        </div>
      </NotesListSurfaceContext.Provider>
    </>
  );
}

/**
 * Structural stand-in for the workspace while the database opens: same
 * sidebar/header/list geometry as the real shell, with the same skeleton
 * cards the notes list uses, so startup reads as the app materializing —
 * not a spinner on an empty screen.
 */
function WorkspaceShellSkeleton() {
  return (
    <div className="flex h-dvh overflow-hidden bg-background" aria-busy="true" aria-label="Loading workspace">
      <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar md:block">
        <div className="space-y-3 px-4 pt-5">
          <div className="flex items-center gap-2.5">
            <img
              src="/noma-icon-192.png"
              alt=""
              width={32}
              height={32}
              className="size-8 rounded-[10px]"
            />
            <div className="h-4 w-16 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
          {[0, 1, 2, 3, 4].map((row) => (
            <div
              key={row}
              className="h-8 animate-pulse rounded-lg bg-muted/60 motion-reduce:animate-none"
            />
          ))}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5">
          <div className="h-4 w-28 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <div className="ml-auto h-8 w-24 animate-pulse rounded-md bg-muted/60 motion-reduce:animate-none" />
        </header>
        <div className="noma-scroll flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-4 sm:px-6">
            {[0, 1, 2, 3].map((row) => (
              <div key={row} className="rounded-xl border border-border/60 bg-card p-4 shadow-xs">
                <div className="h-4 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                <div className="mt-2.5 h-3 w-3/4 animate-pulse rounded bg-muted/70 motion-reduce:animate-none" />
                <div className="mt-2 h-3 w-1/5 animate-pulse rounded bg-muted/50 motion-reduce:animate-none" />
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

/** Converts a shared image's data URL back into a File for the attachment pipeline. */
async function dataUrlToFile(dataUrl: string, name: string, mimeType: string): Promise<File> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], name, { type: mimeType });
}

export function Workspace() {
  const { db, loading: dbLoading } = useDatabase();
  const notes = useLiveQuery(() => db?.notes.toArray() ?? [], [db], undefined);
  const folders = useLiveQuery(() => db?.folders.orderBy("name").toArray() ?? [], [db], undefined);
  const tags = useLiveQuery(() => db?.tags.orderBy("name").toArray() ?? [], [db], undefined);
  const reminders = useLiveQuery(() => db?.reminders.toArray() ?? [], [db], undefined);
  // Note IDs whose pending reminder hands off to the device Clock app.
  const phoneAlarmNoteIds = useMemo(
    () =>
      new Set(
        (reminders ?? [])
          .filter((r) => r.alertType === "phone-alarm" && r.status === "pending")
          .map((r) => r.noteId),
      ),
    [reminders],
  );
  const { settings, update: updateSettings } = useSettings();
  const online = useOnline();
  const { isLocked, isLockStateResolving } = useAppLock();
  const { action: shortcutAction, consumeShortcut } = usePendingShortcut();
  const { request: captureRequest, consumeCapture } = usePendingCapture();

  // Wire the share-target doors (Android plugin + web boot checks) into the
  // capture queue once; requests wait there until the gate below consumes them.
  useEffect(() => {
    initShareTarget();
  }, []);

  const [view, setView] = useState<ViewState>({ kind: "all" });
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  /** Whether the open note is shown in the Read View or the editor. */
  const [noteMode, setNoteMode] = useState<"read" | "edit">("read");
  /** Where back navigation from the editor should land. */
  const [editReturnTo, setEditReturnTo] = useState<"read" | "list">("read");
  const [draft, setDraft] = useState<{ id: string; title?: string; content?: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [reminderTargetNote, setReminderTargetNote] = useState<Note | null>(null);
  /**
   * Unlocked session for the open locked note: its key and decrypted data,
   * held in memory only. Cleared when the note closes, another note opens,
   * or the app lock engages — the note re-locks at each of those points.
   */
  const [noteSession, setNoteSession] = useState<{
    noteId: string;
    nek: Uint8Array;
    content: string;
    attachments: Map<string, string>;
  } | null>(null);
  const noteSessionRef = useRef<typeof noteSession>(null);
  noteSessionRef.current = noteSession;
  const [lockDialog, setLockDialog] = useState<{ note: Note; mode: "setup" | "manage" } | null>(
    null,
  );

  // When the app lock engages, any unlocked note session ends with it.
  useEffect(() => {
    if (isLocked) setNoteSession(null);
  }, [isLocked]);

  useEffect(() => {
    if (db) {
      void cleanupOrphanedReminders(db);
    }
  }, [db]);

  // Built-in templates seed lazily the first time the Templates view opens.
  useEffect(() => {
    if (db && view.kind === "templates") void ensureBuiltinTemplates(db);
  }, [db, view.kind]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Accumulates unsaved patches so back-navigation can flush them immediately
   * instead of racing the debounced autosave.
   */
  const pendingSaveRef = useRef<{
    id: string;
    patch: { title?: string; content?: string };
  } | null>(null);

  // Stabilize row identities: useLiveQuery hands out fresh objects for every
  // row on each notes-table commit, which would defeat memo(NoteItem) and
  // re-render all rendered rows on every single-note mutation or autosave.
  // Stabilization runs before virtualization so the window only re-renders
  // rows whose fields actually changed.
  const allNotes = useStableNotes(notes);
  // Keep the note-preview cache bounded: drop entries for notes that no
  // longer exist whenever the live note set changes.
  useEffect(() => {
    pruneNotePreviewCache(allNotes.map((note) => note.id));
  }, [allNotes]);
  const allFolders = useMemo(() => folders ?? [], [folders]);
  const allTags = useMemo(() => tags ?? [], [tags]);

  const visibleNotes = useMemo(() => filterNotes(allNotes, view), [allNotes, view]);
  const storedNote = allNotes.find((note) => note.id === activeNoteId) ?? null;
  const sessionForStored =
    storedNote && noteSession?.noteId === storedNote.id ? noteSession : null;
  const activeNote: Note | null = storedNote
    ? {
        ...storedNote,
        // In an unlocked session the surfaces see decrypted content; storage
        // keeps the ciphertext. Draft edits overlay the decrypted content.
        ...(sessionForStored ? { content: sessionForStored.content } : {}),
        ...(draft?.id === storedNote.id ? draft : {}),
      }
    : null;

  const flushSave = useCallback(
    async (id: string, patch: { title?: string; content?: string }) => {
      if (!db) return;
      try {
        const stored = await db.notes.get(id);
        const session = noteSessionRef.current;
        if (stored?.lock && patch.content !== undefined) {
          if (!session || session.noteId !== id) {
            // Locked with no live session: refuse the write outright rather
            // than risk plaintext landing over the ciphertext.
            throw new Error("Note is locked.");
          }
          if (patch.title !== undefined) await updateNote(db, id, { title: patch.title });
          await saveLockedNoteContent(db, stored, session.nek, patch.content);
        } else {
          await updateNote(db, id, patch);
        }
        pendingSaveRef.current = null;
        setSaveState(navigator.onLine ? "saved" : "offline");
      } catch {
        setSaveState("idle");
        toast.error("Noma couldn't save to this device's storage.");
      }
    },
    [db],
  );

  const handleChange = useCallback(
    (patch: { title?: string; content?: string }) => {
      if (!activeNoteId) return;
      setDraft((current) => ({
        ...(current?.id === activeNoteId ? current : { id: activeNoteId }),
        id: activeNoteId,
        ...patch,
      }));
      pendingSaveRef.current = {
        id: activeNoteId,
        patch: { ...pendingSaveRef.current?.patch, ...patch },
      };
      setSaveState("saving");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        if (pending) void flushSave(pending.id, pending.patch);
      }, 400);
    },
    [activeNoteId, flushSave],
  );

  /** Flush any pending autosave immediately (used before navigation). */
  const flushPendingSave = useCallback(async () => {
    const pending = pendingSaveRef.current;
    if (!pending) return;
    pendingSaveRef.current = null;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    await flushSave(pending.id, pending.patch);
  }, [flushSave]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  /**
   * Tapping an existing note opens the dedicated Read View. Empty notes have
   * nothing to read, so they open directly in the editor instead.
   */
  const openNote = useCallback((note: Note) => {
    setDraft(null);
    setSaveState("idle");
    setActiveNoteId(note.id);
    // Opening a different note ends the previous note's unlocked session.
    setNoteSession((prev) => (prev && prev.noteId === note.id ? prev : null));
    if (note.lock) {
      // Locked notes land on the unlock gate (rendered by the surfaces).
      setNoteMode("read");
      setEditReturnTo("read");
      return;
    }
    const isEmpty = !note.title.trim() && !notePreview(note);
    setNoteMode(isEmpty ? "edit" : "read");
    setEditReturnTo(isEmpty ? "list" : "read");
  }, []);

  /** Gate success: adopt the decrypted session and show the note. */
  const handleNoteUnlocked = useCallback(
    (nek: Uint8Array, data: UnlockedNoteData) => {
      if (!activeNoteId) return;
      setNoteSession({
        noteId: activeNoteId,
        nek,
        content: data.content,
        attachments: data.attachments,
      });
      setNoteMode("read");
      setEditReturnTo("read");
    },
    [activeNoteId],
  );

  /** Enter the editor for the currently open note (from the Read View). */
  const openNoteForEdit = useCallback(() => {
    setEditReturnTo("read");
    setNoteMode("edit");
  }, []);

  /** Leave the open note entirely, flushing any pending save first. */
  const closeNote = useCallback(async () => {
    await flushPendingSave();
    setDraft(null);
    setSaveState("idle");
    setActiveNoteId(null);
    setNoteMode("read");
    // Closing a note re-locks it: the decrypted session is dropped.
    setNoteSession(null);
  }, [flushPendingSave]);

  /**
   * Back navigation out of the editor: return to the Read View when the note
   * was opened for reading, otherwise back to the Notes list.
   */
  const goBackFromEditor = useCallback(async () => {
    if (editReturnTo === "read") {
      await flushPendingSave();
      setNoteMode("read");
    } else {
      await closeNote();
    }
  }, [flushPendingSave, closeNote, editReturnTo]);

  const handleNewNote = useCallback(async () => {
    if (!db) return;
    const note = await createNote(db!, {
      folderId: view.kind === "folder" ? (view.id ?? null) : null,
      tagIds: view.kind === "tag" && view.id ? [view.id] : [],
    });
    setMobileNavOpen(false);
    setDraft(null);
    setSaveState("idle");
    setActiveNoteId(note.id);
    setNoteMode("edit");
    setEditReturnTo("list");
  }, [view, db]);

  /** Opens today's daily note (creating or restoring it if needed)
   * straight in the editor — the sidebar's Today action. */
  const openTodayNote = useCallback(async () => {
    if (!db) return;
    const note = await getOrCreateDailyNote(db);
    setMobileNavOpen(false);
    setDraft(null);
    setSaveState("idle");
    setActiveNoteId(note.id);
    setNoteMode("edit");
    setEditReturnTo("list");
  }, [db]);

  /** Blank template note, opened in the editor from the Templates view. */
  const handleNewTemplate = useCallback(async () => {
    if (!db) return;
    const note = await createNote(db, { isTemplate: true });
    setMobileNavOpen(false);
    setDraft(null);
    setSaveState("idle");
    setActiveNoteId(note.id);
    setNoteMode("edit");
    setEditReturnTo("list");
  }, [db]);

  /**
   * Turns a consumed share capture into a real note: body text first, then
   * each shared image saved through the normal attachment pipeline and
   * embedded in the body, then the note opens in the editor — the same end
   * state as handleNewNote, just with content.
   */
  const handleShareCapture = useCallback(
    async (request: Extract<CaptureRequest, { kind: "share" }>) => {
      if (!db) return;
      const note = await createNote(db, { title: request.title, content: request.content });
      let content = request.content;
      for (const image of request.images) {
        try {
          const file = await dataUrlToFile(image.dataUrl, image.name, image.mimeType);
          const attachment = await saveImageAttachment(db, note.id, file);
          const alt = attachment.name.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
          content += `<p><img src="noma-attachment://${attachment.id}" alt="${alt}"></p>`;
        } catch {
          /* one unreadable image shouldn't sink the whole capture */
        }
      }
      // updateNote re-sanitises and recounts words (createNote stores raw init).
      if (content) await updateNote(db, note.id, { content });
      setMobileNavOpen(false);
      setDraft(null);
      setSaveState("idle");
      setActiveNoteId(note.id);
      setNoteMode("edit");
      setEditReturnTo("list");
    },
    [db],
  );

  // Respond to Android shortcut triggers once DB is loaded and App Lock is unlocked
  useEffect(() => {
    if (shortcutAction === "new-note" && db && !isLockStateResolving && !isLocked) {
      consumeShortcut();
      void handleNewNote();
    }
  }, [shortcutAction, db, isLockStateResolving, isLocked, consumeShortcut, handleNewNote]);

  // Consume quick-capture requests (share target, widget, tile, PWA doors)
  // under the same gate as the launcher shortcut: DB loaded, App Lock open.
  useEffect(() => {
    if (!captureRequest || !db || isLockStateResolving || isLocked) return;
    consumeCapture(captureRequest.id);
    if (captureRequest.kind === "share") void handleShareCapture(captureRequest);
    else void handleNewNote();
  }, [
    captureRequest,
    db,
    isLockStateResolving,
    isLocked,
    consumeCapture,
    handleShareCapture,
    handleNewNote,
  ]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if (meta && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void handleNewNote();
      }
      if (event.key === "Escape" && !searchOpen) {
        if (activeNoteId && noteMode === "edit") void goBackFromEditor();
        else if (activeNoteId) void closeNote();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleNewNote, searchOpen, activeNoteId, noteMode, goBackFromEditor, closeNote]);

  // Latest navigation state for the Android hardware back button, avoiding
  // stale closures in the native listener.
  const backStateRef = useRef<{
    searchOpen: boolean;
    prompt: PromptRequest | null;
    confirmation: Confirmation | null;
    reminderTargetNote: Note | null;
    activeNoteId: string | null;
    noteMode: "read" | "edit";
  }>({
    searchOpen: false,
    prompt: null,
    confirmation: null,
    reminderTargetNote: null,
    activeNoteId: null,
    noteMode: "read",
  });
  backStateRef.current = {
    searchOpen,
    prompt,
    confirmation,
    reminderTargetNote,
    activeNoteId,
    noteMode,
  };

  /**
   * Android hardware back: dialogs -> search -> editor -> Read View ->
   * Notes list. Returns true when the press was consumed.
   */
  const handleSystemBack = useCallback((): boolean => {
    const state = backStateRef.current;
    if (state.reminderTargetNote) {
      setReminderTargetNote(null);
      return true;
    }
    if (state.confirmation) {
      setConfirmation(null);
      return true;
    }
    if (state.prompt) {
      setPrompt(null);
      return true;
    }
    if (state.searchOpen) {
      setSearchOpen(false);
      setQuery("");
      return true;
    }
    if (state.activeNoteId && state.noteMode === "edit") {
      void goBackFromEditor();
      return true;
    }
    if (state.activeNoteId) {
      void closeNote();
      return true;
    }
    return false;
  }, [goBackFromEditor, closeNote]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    let handle: PluginListenerHandle | undefined;
    void CapacitorApp.addListener("backButton", () => {
      if (!handleSystemBack()) {
        void CapacitorApp.minimizeApp();
      }
    }).then((listener) => {
      if (cancelled) void listener.remove();
      else handle = listener;
    });
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, [handleSystemBack]);

  const actions: NoteActions = useMemo(
    () => ({
      open: openNote,
      togglePin: (note) => {
        if (db) void togglePinned(db, note);
      },
      toggleFavorite: (note) => {
        if (db) void toggleFavorite(db, note);
      },
      setArchived: (note, archived) => {
        if (db) void setArchived(db, note, archived);
      },
      setReminder: (note) => setReminderTargetNote(note),
      lockNote: (note) => setLockDialog({ note, mode: "setup" }),
      saveAsTemplate: (note) =>
        setPrompt({
          title: "Save as template",
          description: "The note stays as it is; a copy becomes the template.",
          initialValue: noteTitle(note),
          confirmLabel: "Save template",
          onConfirm: async (name) => {
            if (!db) return;
            const template = await saveAsTemplate(db, note.id, name);
            if (template) toast.success("Template saved");
            else toast.error("That note can't be saved as a template.");
          },
        }),
      useTemplate: async (note) => {
        if (!db) return;
        const created = await createNoteFromTemplate(db, note.id);
        if (!created) return;
        setMobileNavOpen(false);
        setDraft(null);
        setSaveState("idle");
        setActiveNoteId(created.id);
        setNoteMode("edit");
        setEditReturnTo("list");
      },
      toggleDailyDefault: (note) => {
        if (db) void setDailyDefault(db, note.dailyDefault ? null : note.id);
      },
      duplicate: async (note) => {
        if (!db) return;
        if (note.lock) {
          toast.info("Unlock this note first — then you can duplicate it.");
          openNote(note);
          return;
        }
        const copy = await duplicateNote(db, note.id);
        if (copy) toast.success("Note duplicated");
      },
      move: (note, folderId) => {
        if (db) void moveNote(db, note.id, folderId);
      },
      trash: (note) => {
        if (!db) return;
        void trashNote(db, note.id);
        // Use functional update to avoid depending on activeNoteId (which would
        // recreate the actions object on every note open, defeating NoteItem memo).
        setActiveNoteId((prev) => (prev === note.id ? null : prev));
        toast.success("Moved to Trash", {
          action: { label: "Undo", onClick: () => void restoreNote(db, note.id) },
        });
      },
      restore: (note) => {
        if (db) {
          void restoreNote(db, note.id);
          toast.success("Note restored");
        }
      },
      deleteForever: (note) =>
        setConfirmation({
          title: "Delete this note permanently?",
          description: `“${noteTitle(note)}” and its attachments will be removed from this device. This can't be undone.`,
          actionLabel: "Delete permanently",
          onConfirm: async () => {
            if (!db) return;
            await deleteNoteForever(db, note.id);
            // Functional update avoids activeNoteId dep (see trash above).
            setActiveNoteId((prev) => (prev === note.id ? null : prev));
            toast.success("Note deleted");
          },
        }),
    }),
    [db, openNote],
  );

  const searchResults = useMemo(
    () =>
      searchOpen
        ? searchNotes(
            query,
            allNotes.filter((note) => !note.deleted),
            allFolders,
            allTags,
          )
        : [],
    [searchOpen, query, allNotes, allFolders, allTags],
  );

  if (dbLoading || !db) {
    return <WorkspaceShellSkeleton />;
  }

  const sidebar = (
    <NomaSidebar
      notes={allNotes}
      folders={allFolders}
      tags={allTags}
      view={view}
      onSelectView={(next) => {
        setView(next);
        setMobileNavOpen(false);
        void closeNote();
      }}
      onNewNote={handleNewNote}
      onOpenToday={openTodayNote}
      onCreateFolder={() =>
        setPrompt({
          title: "New folder",
          confirmLabel: "Create",
          onConfirm: async (name) => {
            await createFolder(db!, name);
          },
        })
      }
      onRenameFolder={(folder) =>
        setPrompt({
          title: "Rename folder",
          initialValue: folder.name,
          onConfirm: async (name) => {
            await renameFolder(db!, folder.id, name);
          },
        })
      }
      onDeleteFolder={(folder) =>
        setConfirmation({
          title: `Delete “${folder.name}”?`,
          description: "Notes inside stay in Noma and move out of this folder.",
          actionLabel: "Delete folder",
          onConfirm: async () => {
            await deleteFolder(db!, folder.id);
            setView({ kind: "all" });
          },
        })
      }
      onCreateTag={() =>
        setPrompt({
          title: "New tag",
          confirmLabel: "Create",
          onConfirm: async (name) => {
            await createTag(db!, name);
          },
        })
      }
      onRenameTag={(tag) =>
        setPrompt({
          title: "Rename tag",
          initialValue: tag.name,
          onConfirm: async (name) => {
            await renameTag(db!, tag.id, name);
          },
        })
      }
      onDeleteTag={(tag) =>
        setConfirmation({
          title: `Delete #${tag.name}?`,
          description: "The tag is removed from every note. Your notes stay untouched.",
          actionLabel: "Delete tag",
          onConfirm: async () => {
            await deleteTag(db!, tag.id);
            setView({ kind: "all" });
          },
        })
      }
      onCollapse={() => void updateSettings({ sidebarCollapsed: true })}
    />
  );

  /** Secondary note actions shared by the Read View and editor headers. */
  const overflowMenu = activeNote ? (
    <NoteOverflowMenu
      note={activeNote}
      tags={allTags}
      folders={allFolders}
      onCreateTag={() =>
        setPrompt({
          title: "New tag",
          confirmLabel: "Create",
          onConfirm: async (name) => {
            const tag = await createTag(db!, name);
            await setNoteTags(db!, activeNote.id, [...activeNote.tagIds, tag.id]);
          },
        })
      }
      onToggleTag={(tagId, checked) =>
        void setNoteTags(
          db!,
          activeNote.id,
          checked ? [...activeNote.tagIds, tagId] : activeNote.tagIds.filter((id) => id !== tagId),
        )
      }
      onMoveToFolder={(folderId) => void moveNote(db!, activeNote.id, folderId)}
      onSetReminder={() => setReminderTargetNote(activeNote)}
      onDuplicate={() => actions.duplicate(activeNote)}
      onLockNote={() => setLockDialog({ note: activeNote, mode: "setup" })}
      onManageLock={() => setLockDialog({ note: activeNote, mode: "manage" })}
      onSaveAsTemplate={() => actions.saveAsTemplate?.(activeNote)}
      onUseTemplate={() => actions.useTemplate?.(activeNote)}
      onToggleDailyDefault={() => actions.toggleDailyDefault?.(activeNote)}
      onToggleArchive={() => actions.setArchived(activeNote, !activeNote.archived)}
      onTrash={() => actions.trash(activeNote)}
      onRestore={() => actions.restore(activeNote)}
      onDeleteForever={() => actions.deleteForever(activeNote)}
    />
  ) : null;

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      {!settings.sidebarCollapsed && (
        <aside className="hidden w-64 shrink-0 border-r border-sidebar-border md:block">
          {sidebar}
        </aside>
      )}

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">Noma navigation</SheetTitle>
          {sidebar}
        </SheetContent>
      </Sheet>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open navigation"
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
          {settings.sidebarCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:inline-flex"
              aria-label="Show sidebar"
              onClick={() => void updateSettings({ sidebarCollapsed: false })}
            >
              <PanelLeft className="size-5" />
            </Button>
          )}

          {activeNote && Boolean(activeNote.lock) && noteSession?.noteId !== activeNote.id ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground"
                onClick={() => void closeNote()}
              >
                <ArrowLeft className="size-4" />
                <span className="hidden sm:inline">{viewTitle(view, allFolders, allTags)}</span>
              </Button>
              <span className="ml-auto flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Lock className="size-3.5" aria-hidden="true" /> Locked note
              </span>
            </>
          ) : activeNote && noteMode === "edit" ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground"
                onClick={() => void goBackFromEditor()}
              >
                <ArrowLeft className="size-4" />
                <span className="hidden sm:inline">{viewTitle(view, allFolders, allTags)}</span>
              </Button>
              <span
                className="ml-auto flex items-center gap-1 text-xs text-muted-foreground animate-in fade-in duration-200 motion-reduce:animate-none"
                aria-live="polite"
                role="status"
              >
                {!online ? (
                  <>
                    <WifiOff className="size-3.5" aria-hidden="true" /> Saved offline
                  </>
                ) : saveState === "saving" ? (
                  "Saving…"
                ) : saveState === "saved" ? (
                  <>
                    <Check className="size-3.5" aria-hidden="true" /> Saved
                  </>
                ) : (
                  ""
                )}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={activeNote.reminderAt ? "Edit Reminder" : "Set Reminder"}
                onClick={() => setReminderTargetNote(activeNote)}
                className={cn(
                  "gap-1 text-xs",
                  activeNote.reminderAt ? "text-primary font-medium" : "text-muted-foreground",
                )}
              >
                <Bell className={cn("size-4", activeNote.reminderAt && "fill-current")} />
                {activeNote.reminderAt ? (
                  <span className="hidden sm:inline">
                    {format(activeNote.reminderAt, "MMM d, p")}
                  </span>
                ) : (
                  <span className="hidden sm:inline">Set Reminder</span>
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={activeNote.pinned ? "Unpin note" : "Pin note"}
                onClick={() => void togglePinned(db!, activeNote)}
                className={cn(activeNote.pinned && "text-foreground")}
              >
                <Pin className={cn("size-4", activeNote.pinned && "fill-current")} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={activeNote.favorite ? "Remove favorite" : "Add favorite"}
                onClick={() => void toggleFavorite(db!, activeNote)}
              >
                <Star className={cn("size-4", activeNote.favorite && "fill-current")} />
              </Button>
              {overflowMenu}
            </>
          ) : activeNote ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground"
                onClick={() => void closeNote()}
              >
                <ArrowLeft className="size-4" />
                <span className="hidden sm:inline">{viewTitle(view, allFolders, allTags)}</span>
              </Button>
              <div className="ml-auto flex items-center gap-1">
                <Button size="sm" className="noma-cta gap-1.5" onClick={openNoteForEdit}>
                  <Pencil className="size-4" />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={activeNote.pinned ? "Unpin note" : "Pin note"}
                  onClick={() => void togglePinned(db!, activeNote)}
                  className={cn(activeNote.pinned && "text-foreground")}
                >
                  <Pin className={cn("size-4", activeNote.pinned && "fill-current")} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={activeNote.favorite ? "Remove favorite" : "Add favorite"}
                  onClick={() => void toggleFavorite(db!, activeNote)}
                >
                  <Star className={cn("size-4", activeNote.favorite && "fill-current")} />
                </Button>
                {overflowMenu}
              </div>
            </>
          ) : (
            <>
              <h1 className="truncate font-serif text-lg font-medium">
                {viewTitle(view, allFolders, allTags)}
              </h1>
              <span className="ml-1 text-xs text-muted-foreground tabular-nums">
                {visibleNotes.length}
              </span>
              <div className="ml-auto flex items-center gap-1">
                {!online && (
                  <span className="mr-1 hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
                    <WifiOff className="size-3.5" /> Offline
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Search notes"
                  onClick={() => setSearchOpen(true)}
                >
                  <Search className="size-4" />
                </Button>
                {view.kind === "trash" && visibleNotes.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() =>
                      setConfirmation({
                        title: "Empty Trash?",
                        description: `${visibleNotes.length} note(s) will be permanently deleted from this device.`,
                        actionLabel: "Empty Trash",
                        onConfirm: async () => {
                          const count = await emptyTrash(db!);
                          toast.success(`${count} note(s) deleted`);
                        },
                      })
                    }
                  >
                    Empty Trash
                  </Button>
                )}
                {view.kind === "templates" ? (
                  <Button size="sm" className="gap-1.5" onClick={handleNewTemplate}>
                    <Plus className="size-4" />
                    <span className="hidden sm:inline">New template</span>
                  </Button>
                ) : (
                  <Button size="sm" className="gap-1.5" onClick={handleNewNote}>
                    <Plus className="size-4" />
                    <span className="hidden sm:inline">New Note</span>
                  </Button>
                )}
              </div>
            </>
          )}
        </header>

        <WorkspaceSurfaces
          activeNote={activeNote}
          activeNoteId={activeNoteId}
          noteMode={noteMode}
          view={view}
          notesLoading={notes === undefined}
          visibleNotes={visibleNotes}
          allNotes={allNotes}
          allFolders={allFolders}
          allTags={allTags}
          reminders={reminders}
          actions={actions}
          phoneAlarmNoteIds={phoneAlarmNoteIds}
          onOpenNote={openNote}
          onNoteChange={handleChange}
          noteSession={
            noteSession
              ? { noteId: noteSession.noteId, attachments: noteSession.attachments }
              : null
          }
          onUnlockNote={handleNoteUnlocked}
          fontSize={settings.fontSize}
          editorWidth={settings.editorWidth}
          lineHeight={settings.lineHeight}
        />
      </main>

      <Dialog
        open={searchOpen}
        onOpenChange={(open) => {
          setSearchOpen(open);
          if (!open) setQuery("");
        }}
      >
        <DialogContent className="top-24 max-w-xl translate-y-0 p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>Search notes</DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search className="size-4 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search titles, content, tags and folders…"
              className="h-12 border-0 px-0 shadow-none focus-visible:ring-0"
            />
          </div>
          <div className="noma-scroll max-h-80 overflow-y-auto p-2">
            {query.trim() === "" ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Search works offline across your whole library.
              </p>
            ) : searchResults.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                No notes match “{query.trim()}”.
              </p>
            ) : (
              searchResults.slice(0, 30).map(({ note, snippet }) => (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => {
                    openNote(note);
                    setSearchOpen(false);
                    setQuery("");
                  }}
                  className="w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-accent/60"
                >
                  <span className="block truncate font-serif text-[15px] font-medium">
                    {noteTitle(note)}
                  </span>
                  {note.lock ? (
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      <Lock className="size-3" aria-hidden="true" /> Locked note
                    </span>
                  ) : (
                    <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                      {highlightTerms(snippet, query).map((part, index) =>
                        part.match ? (
                          <mark
                            key={index}
                            className="rounded bg-transparent font-medium text-foreground"
                          >
                            {part.text}
                          </mark>
                        ) : (
                          <span key={index}>{part.text}</span>
                        ),
                      )}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      <PromptDialog request={prompt} onClose={() => setPrompt(null)} />

      {reminderTargetNote && (
        <ReminderDialog
          open={Boolean(reminderTargetNote)}
          onOpenChange={(open) => !open && setReminderTargetNote(null)}
          noteTitle={noteTitle(reminderTargetNote)}
          existingReminder={(reminders ?? []).find((r) => r.noteId === reminderTargetNote.id)}
          onSave={async (scheduledAt, options) => {
            await setNoteReminder(db!, reminderTargetNote.id, scheduledAt, options);
            toast.success("Reminder set");
          }}
          onDelete={async () => {
            await deleteNoteReminder(db!, reminderTargetNote.id);
            toast.success("Reminder removed");
          }}
        />
      )}

      <AlertDialog
        open={Boolean(confirmation)}
        onOpenChange={(open) => !open && setConfirmation(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif">{confirmation?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                await confirmation?.onConfirm();
                setConfirmation(null);
              }}
            >
              {confirmation?.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {lockDialog &&
        (() => {
          // Always hand the dialog the freshest row so lock state stays live.
          const dialogNote =
            allNotes.find((n) => n.id === lockDialog.note.id) ?? lockDialog.note;
          return (
            <NoteLockDialog
              note={dialogNote}
              mode={lockDialog.mode}
              nek={
                lockDialog.mode === "manage" && noteSession?.noteId === dialogNote.id
                  ? noteSession.nek
                  : null
              }
              onClose={() => setLockDialog(null)}
              onLocked={() =>
                setNoteSession((prev) =>
                  prev?.noteId === dialogNote.id ? null : prev,
                )
              }
              onLockRemoved={() => setNoteSession(null)}
            />
          );
        })()}
    </div>
  );
}

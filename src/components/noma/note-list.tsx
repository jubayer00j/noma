import React, { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNowStrict, format } from "date-fns";
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  Bell,
  CalendarCheck,
  Check,
  Copy,
  FolderInput,
  History,
  Image as ImageIcon,
  LayoutTemplate,
  Lock,
  LockOpen,
  MoreHorizontal,
  NotebookPen,
  Pin,
  PinOff,
  RotateCcw,
  Star,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { notePreview, noteTitle } from "@/lib/noma/notes";
import { noteAccentBucket, noteAccentClass } from "@/lib/noma/note-accent";
import {
  idleSwipeGesture,
  swipeActionsFor,
  swipePointerCancel,
  swipePointerDown,
  swipePointerMove,
  swipePointerUp,
  swipeWouldCommit,
  type SwipeActionKind,
  type SwipeGesture,
} from "@/lib/noma/swipe";
import type { LucideIcon } from "lucide-react";
import { VirtualList } from "./virtual-list";
import { NotesListSurfaceContext } from "./notes-list-surface-context";

// Module-level so the virtualizer's offset prefix-sums aren't recomputed on
// every NoteList render due to a new function identity.
const getNoteKey = (note: Note) => note.id;
import type { Folder, Note, Tag } from "@/lib/noma/types";
import type { ViewKind, ViewState } from "@/lib/noma/view";

export interface NoteActions {
  open: (note: Note) => void;
  togglePin: (note: Note) => void;
  toggleFavorite: (note: Note) => void;
  setArchived: (note: Note, archived: boolean) => void;
  setReminder?: (note: Note) => void;
  duplicate: (note: Note) => void;
  /** Opens the per-note version history dialog (hidden for locked notes). */
  viewHistory?: (note: Note) => void;
  move: (note: Note, folderId: string | null) => void;
  trash: (note: Note) => void;
  restore: (note: Note) => void;
  deleteForever: (note: Note) => void;
  /** Opens the per-note lock setup dialog (unlocked notes only). */
  lockNote?: (note: Note) => void;
  /** Copies the note into a template (hidden for locked notes and templates). */
  saveAsTemplate?: (note: Note) => void;
  /** Creates a fresh note from a template note. */
  useTemplate?: (note: Note) => void;
  /** Toggles whether a template seeds new daily notes. */
  toggleDailyDefault?: (note: Note) => void;
}

interface NoteListProps {
  notes: Note[];
  folders: Folder[];
  tags: Tag[];
  view: ViewState;
  activeNoteId: string | null;
  actions: NoteActions;
  /** Note IDs whose pending reminder is a phone alarm (shows an alarm icon instead of a bell). */
  phoneAlarmNoteIds?: Set<string>;
}

const EMPTY_COPY: Record<string, { title: string; body: string }> = {
  trash: {
    title: "Trash is empty",
    body: "Deleted notes will appear here before they're removed for good.",
  },
  archive: {
    title: "Nothing archived",
    body: "Archive notes you want out of the way but not deleted.",
  },
  pinned: { title: "No pinned notes", body: "Pin a note to keep it at the top of your list." },
  favorites: { title: "No favorites yet", body: "Star the notes you return to most." },
  reminders: {
    title: "No reminders set",
    body: "Set reminders on your notes to keep track of tasks.",
  },
  daily: {
    title: "No daily notes yet",
    body: "Tap Today in the sidebar to start today's page.",
  },
  templates: {
    title: "No templates yet",
    body: "Save any note as a template, or start from a blank one. {{date}} in a template becomes today's date when you use it.",
  },
  default: {
    title: "No notes here yet",
    body: "Start a new note — it saves to this device as you type.",
  },
};

interface NoteItemProps {
  note: Note;
  folders: Folder[];
  tagNameMap: Map<string, string>;
  folderNameMap: Map<string, string>;
  isActive: boolean;
  actions: NoteActions;
  isPhoneAlarm: boolean;
  /** Which list view the row sits in — decides the swipe gesture map. */
  viewKind: ViewKind;
}

/** Underlay presentation per swipe action (native-feel #3). The panel
 * sits behind the card and is revealed by the card's translateX. */
function swipePanelFor(
  kind: SwipeActionKind,
  pinned: boolean,
): { label: string; className: string; Icon: LucideIcon } {
  switch (kind) {
    case "trash":
      return {
        label: "Trash",
        className: "bg-destructive text-destructive-foreground",
        Icon: Trash2,
      };
    case "deleteForever":
      return {
        label: "Delete",
        className: "bg-destructive text-destructive-foreground",
        Icon: Trash2,
      };
    case "restore":
      return { label: "Restore", className: "bg-emerald-600 text-white", Icon: RotateCcw };
    case "pin":
      return pinned
        ? { label: "Unpin", className: "bg-primary text-primary-foreground", Icon: PinOff }
        : { label: "Pin", className: "bg-primary text-primary-foreground", Icon: Pin };
  }
}

const NoteItem = memo(function NoteItem({
  note,
  folders,
  tagNameMap,
  folderNameMap,
  isActive,
  actions,
  isPhoneAlarm,
  viewKind,
}: NoteItemProps) {
  const title = noteTitle(note);
  const locked = Boolean(note.lock);
  const preview = notePreview(note);
  const hasAttachments = !locked && note.content.includes("noma-attachment://");
  const noteTags = note.tagIds.filter((id) => tagNameMap.has(id)).slice(0, 3);
  // Cheap, deterministic fingerprint (tiny string hash); the memoised component
  // only recomputes it when its props change, so long lists stay fast.
  const accentClass = noteAccentClass(noteAccentBucket(note));

  // --- Swipe gestures (native-feel #3) ----------------------------------
  // Every decision lives in the pure machine in @/lib/noma/swipe; this
  // block only translates pointer events into machine inputs and machine
  // outcomes into transforms + the same NoteActions the overflow menu
  // uses. Only the inner card transforms — VirtualList measures the
  // outer wrapper, and a translateX never changes a row's height.
  const swipeMap = swipeActionsFor(viewKind, note);
  const [dragX, setDragX] = useState(0);
  const [swipeAnimating, setSwipeAnimating] = useState(false);
  const [rowWidth, setRowWidth] = useState(0);
  const gestureRef = useRef<SwipeGesture>(idleSwipeGesture);
  const rowWidthRef = useRef(0);
  const suppressClickRef = useRef(false);
  const capturedPointerRef = useRef<number | null>(null);
  // A committed removal (trash/restore) dispatches after the slide-off
  // animation; the closure is stored so an unmount mid-animation flushes
  // it instead of losing the user's action.
  const pendingDispatchRef = useRef<(() => void) | null>(null);
  const exitTimerRef = useRef<number | null>(null);

  const dispatchSwipeAction = (action: SwipeActionKind) => {
    switch (action) {
      case "trash":
        actions.trash(note);
        break;
      case "pin":
        actions.togglePin(note);
        break;
      case "restore":
        actions.restore(note);
        break;
      case "deleteForever":
        actions.deleteForever(note);
        break;
    }
  };

  // Recycled-row safety: VirtualList keys rows by note id, so a mounted
  // row never actually receives a different note — but if one ever did,
  // it must not arrive wearing the previous note's half-finished swipe.
  useEffect(() => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    const pending = pendingDispatchRef.current;
    pendingDispatchRef.current = null;
    pending?.();
    suppressClickRef.current = false;
    gestureRef.current = idleSwipeGesture;
    capturedPointerRef.current = null;
    setSwipeAnimating(false);
    setDragX(0);
    return () => {
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
      const run = pendingDispatchRef.current;
      pendingDispatchRef.current = null;
      run?.();
    };
  }, [note.id]);

  const onSwipePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // A new touch sequence supersedes any unconsumed click suppression
    // (a drag released off-element may never produce its trailing click).
    suppressClickRef.current = false;
    // The overflow menu is its own interaction; a swipe never starts there.
    if ((e.target as HTMLElement).closest("[data-row-menu]")) return;
    const next = swipePointerDown(gestureRef.current, {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      t: e.timeStamp,
      pointerType: e.pointerType,
    });
    if (next === gestureRef.current) return;
    gestureRef.current = next;
    rowWidthRef.current = e.currentTarget.clientWidth;
    setRowWidth(e.currentTarget.clientWidth);
    setSwipeAnimating(false);
  };

  const onSwipePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (g.phase !== "pending" && g.phase !== "dragging") return;
    if (e.pointerId !== g.pointerId) return;
    const next = swipePointerMove(
      g,
      { pointerId: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp },
      swipeMap,
      rowWidthRef.current,
    );
    gestureRef.current = next;
    if (next.phase === "dragging") {
      if (capturedPointerRef.current === null) {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
          capturedPointerRef.current = e.pointerId;
        } catch {
          // Older WebViews may refuse capture; the gesture still tracks
          // while the finger stays over the row.
        }
      }
      setDragX(next.dx);
    }
  };

  const releaseSwipeCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    if (capturedPointerRef.current === null) return;
    try {
      e.currentTarget.releasePointerCapture(capturedPointerRef.current);
    } catch {
      // Capture already gone (e.g. pointercancelled) — nothing to release.
    }
    capturedPointerRef.current = null;
  };

  const onSwipePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId || g.phase === "idle" || g.phase === "committed") return;
    releaseSwipeCapture(e);
    const { gesture, release } = swipePointerUp(g, swipeMap, rowWidthRef.current);
    gestureRef.current = gesture;
    if (release.type === "tap") return;
    // Whatever happens next, the click trailing this drag is not an "open".
    suppressClickRef.current = true;
    if (release.type === "commit" && (release.action === "trash" || release.action === "restore")) {
      // The note leaves this view: slide the card the rest of the way
      // out, then fire. The machine's committed state plus the stored
      // dispatch make the action run exactly once.
      const action = release.action;
      pendingDispatchRef.current = () => dispatchSwipeAction(action);
      setSwipeAnimating(true);
      setDragX(
        release.direction === "left" ? -(rowWidthRef.current + 64) : rowWidthRef.current + 64,
      );
      exitTimerRef.current = window.setTimeout(() => {
        exitTimerRef.current = null;
        const run = pendingDispatchRef.current;
        pendingDispatchRef.current = null;
        run?.();
      }, 180);
      return;
    }
    if (release.type === "commit") {
      // Pin toggles in place; delete-forever only opens the confirmation
      // dialog. Fire now and spring back.
      dispatchSwipeAction(release.action);
      gestureRef.current = idleSwipeGesture;
    }
    setSwipeAnimating(true);
    setDragX(0);
  };

  const onSwipePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current;
    if (g.pointerId !== e.pointerId) return;
    gestureRef.current = swipePointerCancel(g);
    capturedPointerRef.current = null;
    if (g.phase === "dragging") {
      // The browser took the gesture for scrolling; the trailing click of
      // a claimed drag must still not open the note.
      suppressClickRef.current = true;
      setSwipeAnimating(true);
      setDragX(0);
    }
  };

  const onSwipeClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onSwipeTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.propertyName === "transform") setSwipeAnimating(false);
  };

  const revealedKind = dragX > 0 ? swipeMap.right : dragX < 0 ? swipeMap.left : null;
  const revealedPanel = revealedKind ? swipePanelFor(revealedKind, note.pinned) : null;
  const swipeArmed = swipeWouldCommit(gestureRef.current, swipeMap, rowWidth);

  return (
    <div className="relative overflow-hidden rounded-xl">
      {revealedKind && revealedPanel && (
        <div
          aria-hidden="true"
          className={cn(
            "absolute inset-0 flex items-center",
            dragX > 0 ? "justify-start pl-5" : "justify-end pr-5",
            revealedPanel.className,
          )}
        >
          <span
            className={cn(
              "flex items-center gap-2 text-sm font-medium transition-transform duration-150",
              swipeArmed && "scale-110",
            )}
          >
            <revealedPanel.Icon className="size-5" />
            {revealedPanel.label}
          </span>
        </div>
      )}
      <div
        className={cn(
          "group relative rounded-xl border border-border/60 bg-card shadow-xs transition-[border-color,box-shadow,background-color] duration-150 touch-pan-y",
          "hover:border-border hover:shadow-sm hover:bg-accent/20",
          isActive && "border-primary/40 bg-accent/30 shadow-sm",
          dragX !== 0 && "will-change-transform",
          accentClass,
        )}
        style={{
          transform: dragX !== 0 ? `translateX(${dragX}px)` : undefined,
          transition: swipeAnimating
            ? "transform 200ms cubic-bezier(0.2, 0.8, 0.3, 1)"
            : dragX !== 0
              ? "none"
              : undefined,
        }}
        onPointerDown={onSwipePointerDown}
        onPointerMove={onSwipePointerMove}
        onPointerUp={onSwipePointerUp}
        onPointerCancel={onSwipePointerCancel}
        onClickCapture={onSwipeClickCapture}
        onTransitionEnd={onSwipeTransitionEnd}
      >
        <span aria-hidden="true" className="note-accent-rail" />
        <button
          type="button"
          onClick={() => actions.open(note)}
          aria-label={`Open ${title}`}
          className="block w-full min-w-0 rounded-xl p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:p-5"
        >
          <div className="flex items-center gap-2 pr-9">
            {locked && (
              <Lock className="size-3.5 shrink-0 text-primary" aria-label="Locked note" />
            )}
            {note.pinned && (
              <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pinned" />
            )}
            {note.favorite && (
              <Star
                className="size-3.5 shrink-0 fill-current text-muted-foreground"
                aria-label="Favorite"
              />
            )}
            {note.reminderAt &&
              (isPhoneAlarm ? (
                <AlarmClock
                  className="size-3.5 shrink-0 text-primary"
                  aria-label="Has phone alarm"
                />
              ) : (
                <Bell className="size-3.5 shrink-0 text-primary" aria-label="Has reminder" />
              ))}
            {hasAttachments && (
              <ImageIcon
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-label="Has attachments"
              />
            )}
            <h3 className="truncate font-serif text-[17px] font-medium tracking-tight">{title}</h3>
          </div>
          {locked ? (
            <p className="mt-1.5 flex items-center gap-1.5 pr-9 text-sm text-muted-foreground">
              <Lock className="size-3.5 shrink-0" aria-hidden="true" />
              Locked note — unlock to read
            </p>
          ) : (
            <p className="mt-1.5 line-clamp-2 pr-9 text-sm leading-relaxed text-muted-foreground">
              {preview || "Empty note"}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {formatDistanceToNowStrict(note.updatedAt, { addSuffix: true })}
            </span>
            {note.reminderAt && (
              <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                {isPhoneAlarm ? (
                  <AlarmClock className="size-3" aria-hidden="true" />
                ) : (
                  <Bell className="size-3" aria-hidden="true" />
                )}
                {format(note.reminderAt, "MMM d, p")}
              </span>
            )}
            {note.folderId && folderNameMap.has(note.folderId) && (
              <span className="inline-flex max-w-32 items-center gap-1 truncate">
                {folderNameMap.get(note.folderId)}
              </span>
            )}
            {noteTags.map((id) => (
              <span key={id} className="rounded-full bg-secondary px-2 py-0.5 text-[11px]">
                #{tagNameMap.get(id)}
              </span>
            ))}
          </div>
        </button>

        <div className="absolute top-2.5 right-2.5" data-row-menu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
                aria-label={`Actions for ${title}`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {note.deleted ? (
                <>
                  <DropdownMenuItem onClick={() => actions.restore(note)}>
                    <RotateCcw className="size-4" /> Restore
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => actions.deleteForever(note)}
                  >
                    <Trash2 className="size-4" /> Delete permanently
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  <DropdownMenuItem onClick={() => actions.togglePin(note)}>
                    <Pin className="size-4" /> {note.pinned ? "Unpin" : "Pin"}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => actions.toggleFavorite(note)}>
                    <Star className="size-4" /> {note.favorite ? "Remove favorite" : "Favorite"}
                  </DropdownMenuItem>
                  {actions.setReminder && (
                    <DropdownMenuItem onClick={() => actions.setReminder?.(note)}>
                      <Bell className="size-4 text-primary" />{" "}
                      {note.reminderAt ? "Edit Reminder" : "Set Reminder"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => actions.duplicate(note)}>
                    <Copy className="size-4" /> Duplicate
                  </DropdownMenuItem>
                  {!locked && actions.viewHistory && (
                    <DropdownMenuItem onClick={() => actions.viewHistory?.(note)}>
                      <History className="size-4" /> Version history
                    </DropdownMenuItem>
                  )}
                  {note.isTemplate ? (
                    <>
                      {actions.useTemplate && (
                        <DropdownMenuItem onClick={() => actions.useTemplate?.(note)}>
                          <NotebookPen className="size-4" /> Use template
                        </DropdownMenuItem>
                      )}
                      {actions.toggleDailyDefault && (
                        <DropdownMenuItem onClick={() => actions.toggleDailyDefault?.(note)}>
                          <CalendarCheck className="size-4" /> Use as daily template
                          {note.dailyDefault && <Check className="ml-auto size-4" />}
                        </DropdownMenuItem>
                      )}
                    </>
                  ) : (
                    !locked &&
                    actions.saveAsTemplate && (
                      <DropdownMenuItem onClick={() => actions.saveAsTemplate?.(note)}>
                        <LayoutTemplate className="size-4" /> Save as template
                      </DropdownMenuItem>
                    )
                  )}
                  {!note.isTemplate &&
                    (locked ? (
                      <DropdownMenuItem onClick={() => actions.open(note)}>
                        <LockOpen className="size-4" /> Unlock note
                      </DropdownMenuItem>
                    ) : (
                      actions.lockNote && (
                        <DropdownMenuItem onClick={() => actions.lockNote?.(note)}>
                          <Lock className="size-4" /> Lock note
                        </DropdownMenuItem>
                      )
                    ))}
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <FolderInput className="size-4" /> Move to
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => actions.move(note, null)}>
                        No folder
                      </DropdownMenuItem>
                      {folders.map((folder) => (
                        <DropdownMenuItem
                          key={folder.id}
                          onClick={() => actions.move(note, folder.id)}
                        >
                          {folder.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuItem onClick={() => actions.setArchived(note, !note.archived)}>
                    {note.archived ? (
                      <ArchiveRestore className="size-4" />
                    ) : (
                      <Archive className="size-4" />
                    )}
                    {note.archived ? "Unarchive" : "Archive"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => actions.trash(note)}
                  >
                    <Trash2 className="size-4" /> Move to Trash
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
});

export { NoteItem };

export function NoteList({
  notes,
  folders,
  tags,
  view,
  activeNoteId,
  actions,
  phoneAlarmNoteIds,
}: NoteListProps) {
  const tagNameMap = useMemo(() => new Map(tags.map((tag) => [tag.id, tag.name])), [tags]);
  const folderNameMap = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders],
  );

  // The scroll element and list handle come from the notes-list surface
  // context, so NoteList's public props are unchanged. (Hook is above the
  // empty-state early return: hooks must run unconditionally.)
  const surface = useContext(NotesListSurfaceContext);

  if (notes.length === 0) {
    const copy = EMPTY_COPY[view.kind] ?? EMPTY_COPY["default"]!;
    return (
      <div className="px-6 py-20 text-center animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-full border border-border bg-card">
          <NotebookPen className="size-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="font-serif text-lg">{copy.title}</p>
        <p className="mx-auto mt-1.5 max-w-xs text-sm text-muted-foreground">{copy.body}</p>
      </div>
    );
  }

  // Virtualized window: only visible + overscan rows are mounted, in normal
  // document flow. Row heights are measured per note id; unmeasured rows use
  // the estimate until rendered.
  return (
    <VirtualList
      items={notes}
      getKey={getNoteKey}
      scrollElement={surface?.scrollElement ?? null}
      listRef={surface?.listHandleRef}
      className="mx-auto w-full max-w-3xl px-4 sm:px-6"
      renderItem={(note) => (
        <NoteItem
          note={note}
          folders={folders}
          tagNameMap={tagNameMap}
          folderNameMap={folderNameMap}
          isActive={activeNoteId === note.id}
          actions={actions}
          isPhoneAlarm={phoneAlarmNoteIds?.has(note.id) ?? false}
          viewKind={view.kind}
        />
      )}
    />
  );
}

/**
 * The app-shell Android system-back coordinator.
 *
 * One `backButton` listener for the whole app (installed by
 * SystemBackMount in the root route, beside ShortcutListener) replaces
 * the listener the workspace used to own for itself. That older setup
 * left every other route — Settings above all — to Capacitor/WebView
 * defaults, left the lock screen to chance, and could not see overlays
 * that live outside workspace state at all.
 *
 * A press resolves through a fixed priority, first match consumes:
 *
 * 1. A Radix overlay is open (dialog, menu, popover, select, sheet) —
 *    dismiss the topmost through its own close path (see
 *    overlay-registry.ts) and consume. Overlays rendered above the
 *    lock screen and on other routes are covered by the same layer.
 * 2. The App Lock screen is showing — minimize. Back at the lock
 *    screen must never become a path that reveals content, and never
 *    a dead button.
 * 3. The sign-in route — minimize (there is nowhere in-app to go back
 *    to, and leaving must not drop the user into the workspace).
 * 4. The Settings route with a sub-screen open (settings restructure)
 *    — close the sub-screen, back to the Settings root list. Dialogs
 *    opened from a sub-screen are overlays, so layer 1 has already
 *    claimed those presses and revealed the sub-screen underneath.
 * 5. A workspace route (`/` or `/app`) — the chain the workspace
 *    registered (dialogs, search, editor, note). If the chain does
 *    not consume, fall through to minimize.
 * 6. Any other route (`/settings`, `/account`, `/share-target`, …) —
 *    navigate to the workspace route through the router (never
 *    WebView history, which could land on a stale page).
 *
 * The root fallthrough is minimize, not exit: that is Noma's
 * established behaviour for back at the notes list.
 *
 * On web (non-native) nothing here installs — the browser's own back
 * keeps working through the router exactly as before.
 */

/* ---------------- Route classification ---------------- */

const WORKSPACE_ROUTES = new Set(["/", "/app"]);

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

/** Routes that render the workspace (the chain's home). */
export function isWorkspaceRoute(pathname: string): boolean {
  return WORKSPACE_ROUTES.has(normalizePathname(pathname));
}

/* ---------------- Priority resolver ---------------- */

export interface SystemBackEnvironment {
  /** Any Radix overlay currently registered as open. */
  overlayOpen: boolean;
  /** App Lock is engaged (or still resolving — the boot/lock surface). */
  locked: boolean;
  /** Current route pathname from the router. */
  pathname: string;
  /**
   * The Settings route has a sub-screen open (settings restructure).
   * Only meaningful on `/settings`; read live from the registration
   * slot below by the mount, like the overlay state.
   */
  settingsSubScreenOpen?: boolean;
}

export type SystemBackAction =
  "dismiss-overlay" | "minimize" | "navigate-workspace" | "workspace-chain" | "settings-sub-screen";

/**
 * Pure priority resolution for one back press. Side effects live in
 * `handleSystemBackPress`; this function only decides.
 *
 * When an overlay is open the press always belongs to it — the
 * overlay's own close path decides whether it can actually close (a
 * controlled dialog without an `onOpenChange`, like the guest
 * migration prompt, simply stays open, which is the correct modal
 * behaviour for a choice the user must make).
 */
export function resolveSystemBackAction(env: SystemBackEnvironment): SystemBackAction {
  if (env.overlayOpen) return "dismiss-overlay";
  if (env.locked) return "minimize";
  const pathname = normalizePathname(env.pathname);
  if (pathname === "/signin") return "minimize";
  if (pathname === "/settings" && env.settingsSubScreenOpen) return "settings-sub-screen";
  if (WORKSPACE_ROUTES.has(pathname)) return "workspace-chain";
  return "navigate-workspace";
}

/* ---------------- Workspace chain registration ---------------- */

/**
 * The workspace registers its back chain here while mounted; the
 * coordinator consults it on workspace routes only. Exactly one
 * workspace is mounted at a time (the `/` and `/app` routes never
 * coexist), so a single slot is enough; unregistering clears only the
 * caller's own handler.
 */
export type WorkspaceBackHandler = () => boolean;

let workspaceBackHandler: WorkspaceBackHandler | null = null;

export function registerWorkspaceBackHandler(handler: WorkspaceBackHandler): () => void {
  workspaceBackHandler = handler;
  return () => {
    if (workspaceBackHandler === handler) workspaceBackHandler = null;
  };
}

/** The currently registered workspace chain, if any (tests/diagnostics). */
export function getWorkspaceBackHandler(): WorkspaceBackHandler | null {
  return workspaceBackHandler;
}

/* ---------------- Settings sub-screen registration ---------------- */

/**
 * The Settings page registers a handler while one of its sub-screens
 * is open (settings restructure); the handler closes the sub-screen
 * and returns true. Same single-slot discipline as the workspace
 * chain: exactly one Settings page is mounted at a time, and
 * unregistering clears only the caller's own handler.
 */
export type SettingsBackHandler = () => boolean;

let settingsBackHandler: SettingsBackHandler | null = null;

export function registerSettingsBackHandler(handler: SettingsBackHandler): () => void {
  settingsBackHandler = handler;
  return () => {
    if (settingsBackHandler === handler) settingsBackHandler = null;
  };
}

/** The currently registered Settings sub-screen handler, if any (tests/diagnostics). */
export function getSettingsBackHandler(): SettingsBackHandler | null {
  return settingsBackHandler;
}

/** Whether a Settings sub-screen is currently open (the mount's live read). */
export function hasSettingsSubScreen(): boolean {
  return settingsBackHandler !== null;
}

/* ---------------- Press execution ---------------- */

export interface SystemBackEffects {
  dismissOverlay: () => void;
  minimizeApp: () => void;
  navigateToWorkspace: () => void;
}

/**
 * Executes one back press against the current environment. Every
 * press is consumed from the native side (the plugin's dispatcher
 * delegates entirely to JS once a listener exists), so each branch
 * must end in a deliberate outcome — dismiss, navigate, the workspace
 * chain, or minimize.
 */
export function handleSystemBackPress(
  env: SystemBackEnvironment,
  effects: SystemBackEffects,
): SystemBackAction {
  const action = resolveSystemBackAction(env);
  switch (action) {
    case "dismiss-overlay":
      effects.dismissOverlay();
      break;
    case "minimize":
      effects.minimizeApp();
      break;
    case "navigate-workspace":
      effects.navigateToWorkspace();
      break;
    case "workspace-chain": {
      const consumed = workspaceBackHandler?.() ?? false;
      if (!consumed) effects.minimizeApp();
      break;
    }
    case "settings-sub-screen": {
      const consumed = settingsBackHandler?.() ?? false;
      if (!consumed) effects.navigateToWorkspace();
      break;
    }
  }
  return action;
}

/* ---------------- Workspace chain steps ---------------- */

/**
 * The workspace's own unwind order, as data. `resolveWorkspaceBackStep`
 * picks the single layer a back press should close; the workspace maps
 * the step to its setters. Dialog layers the original chain missed —
 * the note-lock dialog and the AI dialog — now lead the order (they
 * render above everything else in the workspace); the pre-existing
 * order below them is preserved exactly.
 *
 * (The backup-unlock dialog is not a step here: it only ever opens on
 * the Settings route, where the coordinator's overlay layer closes it
 * before the route layer can navigate away.)
 */
export interface WorkspaceBackState {
  lockDialogOpen: boolean;
  aiDialogOpen: boolean;
  versionHistoryOpen: boolean;
  reminderOpen: boolean;
  confirmationOpen: boolean;
  promptOpen: boolean;
  searchOpen: boolean;
  activeNoteId: string | null;
  noteMode: "read" | "edit";
}

export type WorkspaceBackStep =
  | "lock-dialog"
  | "ai-dialog"
  | "version-history"
  | "reminder"
  | "confirmation"
  | "prompt"
  | "search"
  | "editor"
  | "note";

export function resolveWorkspaceBackStep(state: WorkspaceBackState): WorkspaceBackStep | null {
  if (state.lockDialogOpen) return "lock-dialog";
  if (state.aiDialogOpen) return "ai-dialog";
  if (state.versionHistoryOpen) return "version-history";
  if (state.reminderOpen) return "reminder";
  if (state.confirmationOpen) return "confirmation";
  if (state.promptOpen) return "prompt";
  if (state.searchOpen) return "search";
  if (state.activeNoteId && state.noteMode === "edit") return "editor";
  if (state.activeNoteId) return "note";
  return null;
}

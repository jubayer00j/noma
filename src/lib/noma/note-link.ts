import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp, type URLOpenListenerEvent } from "@capacitor/app";
import { requestNoteOpen } from "./notification-open";

/**
 * The note door (native-feel #10): `app.noma.notes://note/<id>`, the deep
 * link the home-screen widget's note rows tap through.
 *
 * It follows shortcut.ts's posture exactly — one door, one strict check:
 * the scheme must be `app.noma.notes:`, the host exactly `note`, the
 * path exactly `/<uuid>` with a real UUID shape (note ids are minted by
 * crypto.randomUUID), and no query or hash. Anything else is rejected
 * outright; there is no open-ended URL routing.
 *
 * Accepted ids feed the SAME pending-open slot reminder taps use
 * (notification-open.ts, PR #78) — never the shortcut slot — so a widget
 * tap inherits every rule already built there: the workspace consumes it
 * only when the DB is ready and the App Lock is unlocked, a per-note
 * locked note lands on its unlock gate, and a trashed or deleted note
 * resolves to a plain app open, silently.
 */

const NOTE_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The note id a note-door URL points at, or null when it isn't one. */
export function parseNoteLinkId(urlString: string): string | null {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== "app.noma.notes:") return null;
    if (parsed.host !== "note") return null;
    if (parsed.search !== "" || parsed.hash !== "") return null;
    const match = /^\/([^/]+)$/.exec(parsed.pathname);
    if (!match) return null;
    const id = match[1];
    if (!id) return null;
    return NOTE_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Turns a delivered URL into a pending-open request, when it's a note door. */
export function processNoteLinkUrl(url: string | undefined): void {
  if (!url) return;
  const noteId = parseNoteLinkId(url);
  if (noteId) requestNoteOpen(noteId);
}

let isInitialized = false;

/**
 * Registers this door on the same delivery path the launcher shortcuts
 * use (getLaunchUrl for cold starts, appUrlOpen for warm ones — widget
 * intents are VIEW intents to MainActivity, the path widget v1 already
 * proves). Both listeners coexist: each door's validator rejects the
 * other's URLs. Called once from the app shell (AppGate); later calls
 * are no-ops.
 */
export function initNoteLinkListener(): void {
  if (isInitialized || !Capacitor.isNativePlatform()) return;
  isInitialized = true;

  void CapacitorApp.getLaunchUrl().then((launchUrl) => {
    if (launchUrl?.url) {
      processNoteLinkUrl(launchUrl.url);
    }
  });

  void CapacitorApp.addListener("appUrlOpen", (event: URLOpenListenerEvent) => {
    processNoteLinkUrl(event.url);
  });
}

/** Test seam: clears the registration flag. */
export function resetNoteLinkStateForTests(): void {
  isInitialized = false;
}

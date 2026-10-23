import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";
import type { SwipeActionKind } from "./swipe";

/**
 * Haptic feedback bridge (native-feel #4).
 *
 * Noma's haptic vocabulary is deliberately tiny — feedback exists only
 * where a finger commits something or a gate answers:
 *
 *   - a swipe drag crossing the commit threshold .... one faint tick
 *   - swipe commit: Pin / Restore .................... Light impact
 *   - swipe commit: Move to Trash .................... Medium impact
 *   - App Lock / per-note unlock success ............. Success notification
 *   - App Lock / per-note unlock wrong credential .... Warning notification
 *
 * Everything else (taps, menu actions, typing, autosave, backups) is
 * silent by design. Callers use the semantic functions below and never
 * touch the plugin directly.
 *
 * Why the armed tick is an impact, not the selection generator
 * (verified against the installed @capacitor/haptics 7.0.5 Android
 * source): selectionChanged() is a no-op unless selectionStart() ran
 * first — a stateful three-call sequence with a stuck-state failure
 * mode — and its Android waveform (100ms at amplitude 100) is actually
 * *longer* than Light impact's (50ms at amplitude 110). Light impact is
 * a single stateless call and the lightest pulse the plugin offers.
 *
 * Like system-bars.ts (#71) this bridge is native-only (the plugin's
 * web fallback is inconsistent across browsers) and fire-and-forget:
 * every call is unawaited and failure-proof, so a haptics problem can
 * never break, delay, or throw into the action it decorates.
 */

let hapticsEnabled = true;

/**
 * Mirrors the stored `hapticsEnabled` setting into the module. AppGate
 * calls this whenever the setting loads or changes (same pattern as the
 * theme → system-bars sync), so the Settings toggle takes effect
 * immediately. Until the first call, feedback defaults to ON.
 */
export function setHapticsEnabled(enabled: boolean): void {
  hapticsEnabled = enabled;
}

function feedbackActive(): boolean {
  return hapticsEnabled && Capacitor.isNativePlatform();
}

function impact(style: ImpactStyle): void {
  if (!feedbackActive()) return;
  try {
    void Haptics.impact({ style }).catch(() => {
      /* Feedback is decoration; never let it surface as an app error. */
    });
  } catch {
    /* Plugin unavailable — stay silent. */
  }
}

function notification(type: NotificationType): void {
  if (!feedbackActive()) return;
  try {
    void Haptics.notification({ type }).catch(() => {
      /* Feedback is decoration; never let it surface as an app error. */
    });
  } catch {
    /* Plugin unavailable — stay silent. */
  }
}

/** A swipe drag crossed the commit threshold: the faintest tick. */
export function hapticSwipeArmed(): void {
  impact(ImpactStyle.Light);
}

/** A swipe release committed its action. Fired at release, not after any slide-off animation. */
export function hapticSwipeCommit(kind: SwipeActionKind): void {
  switch (kind) {
    case "trash":
      impact(ImpactStyle.Medium);
      break;
    case "pin":
    case "restore":
      impact(ImpactStyle.Light);
      break;
    case "deleteForever":
      // Silent: the swipe only opens the delete confirmation dialog —
      // nothing has been deleted, and delete-forever is outside the map.
      break;
  }
}

/** The App Lock or a locked note accepted the credential. */
export function hapticUnlockSuccess(): void {
  notification(NotificationType.Success);
}

/** The App Lock or a locked note rejected the credential. */
export function hapticUnlockFailure(): void {
  notification(NotificationType.Warning);
}

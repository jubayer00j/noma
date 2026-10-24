# Changelog

All notable changes to Noma. Dates are merge dates on `main`.

## 2026-10-24

### Caret in the installed app: the native IME seam — PR #83
- Correction to the entry below, stated plainly: PR #82 fixed the caret-under-keyboard bug on the web, but not in the installed Android app — the user confirmed web is fine and the app still hides the caret. The native seam was the cause: with edge-to-edge (`decorFitsSystemWindows(false)` from PR #71), `adjustResize` does not shrink the window — the window stays full-height behind the keyboard and the app is expected to consume IME insets itself. Nothing did, so the WebView never shrank, the visualViewport signal PR #82 depends on never yielded a usable keyboard height, and a scroll delta alone hard-clamped at the content's bottom.
- MainActivity now reads the real IME inset (`WindowInsetsCompat.Type.ime()`) and forwards it to the web layer in CSS px as a `noma:ime-height` window event (plus a synchronous `window.NomaIme` getter for the mount-with-keyboard-open case). The listener only observes — it returns the insets unchanged, so the splash bar sequence, system-bar appearance and edge-to-edge CSS safe-areas are untouched, and no view's layout is changed. The web layer feeds that height into the existing caret machinery (the visualViewport path stays as the web fallback) and, while the keyboard is open, also gives the scroll content real bottom room equal to the keyboard height — so maximum scroll can genuinely lift the document's last line above the keyboard instead of clamping behind it. Manual scrolling is still never fought.
- Device-only proof: in the installed Android app (not the web build), long note → tap at the very end → keyboard opens → type several lines → the current line never disappears; manual scroll can also reach the last line; dialogs and edge-to-edge visuals unchanged.

### Caret stays above the keyboard — PR #82
- Typing in a long note could slide the current line underneath the on-screen keyboard, leaving you typing blind. Nothing in the app watched the visual viewport, and ProseMirror's built-in caret scrolling measures against the layout viewport, which doesn't shrink the way the visual viewport does when the keyboard opens — so by its math the caret was "visible" while it sat behind the keyboard (the one case PR #76 left as verify-on-device).
- The editor now listens to the visual viewport while a note is open in edit mode: it reserves the keyboard height on the note surface and, on every selection change and viewport change, scrolls the surface by exactly the overlap when the caret sits below the visible bottom — never otherwise, so manual scrolling is never fought. The read view, dialogs, and workspace scroll preservation are untouched.
- Device-only proof: long note → tap at the very end → keyboard opens → type several lines → the current line never disappears under the keyboard; same for a mid-document caret, and the formatting toolbar stays reachable throughout.

### AI errors now say what actually failed

- Every AI call (Test connection, Summarize, Suggest tags) used to collapse any unmapped failure into one generic line — "Gemini sent back something Noma couldn't read" — even though Google's error body always names the real cause. A fresh free key failing identically on all three calls was therefore undiagnosable from the message alone.
- The client now reads Google's error envelope on failed calls: a 404 names the configured model (`model-unavailable`, so a retired model id is diagnosable instead of generic), 500/502/503 report Gemini as busy (`transient`), and any other failure surfaces Google's own message (`api-error`, capped, and never surfacing a message that echoes the key). The existing mappings are untouched: bad key, rate limit, offline, and empty replies keep their exact messages, and a 200 with the wrong shape stays the generic line — that genuinely is unreadable.
- User-visible next step: retest Test connection and report the exact message if it still fails — that message now identifies the cause (a model-not-found answer would be the evidence for switching the model id, which this PR deliberately does not do on speculation).

### Settings restructure — PR #81
- Settings is no longer one long scroll. It opens on a list of eight categories — **Sync & backup, Security, Appearance, Writing, AI features, Data, Account, About** — and every row shows its current state as a summary ("Connected · Scheduled · Daily", "App lock on · Encryption off", your theme's name, "17px · 1.7"), so most visits end at a glance. Tapping a row opens its sub-screen; the header and the Android back button walk you back to the list first (a new step in the system-back priority: dialogs → sub-screen → leave Settings).
- Everything is the same blocks, rehomed — nothing about how any setting behaves has changed. Backup encryption moved out of the Drive card into **Security**, next to App Lock where it belongs; enabling it there still seals the current Drive backup immediately, via the same window-event idiom the cards already used to talk to each other. Restore and the importers live under **Data**; the writing sliders got their own **Writing** screen, out of Appearance.
- Two long-standing nits fixed on the way through: the backup description no longer claims backups contain Markdown (they're JSON and attachments — Markdown is an import format), and settings.tsx got the full formatting pass its diffs had been politely avoiding.
- Device-only proof: open Settings and check every row's summary against the real state (flip backup mode, theme, App Lock and watch them follow); hardware back walks sub-screen → list → Notes; export, restore, an import, Drive connect, enabling encryption (Drive archive seals right away), saving the AI key, and signing out all work from their new homes.

## 2026-10-23 — the 8-feature roadmap

One sprint, eight features, each spec-first, PR-reviewed and production-verified. Noma went from a local notes app to a synced, encrypted, importing, AI-capable one — still ~$0 to run.

### Multi-device sync (Drive) — PR #62
- Syncs devices through your existing Drive backup: a pull-merge-push cycle over the canonical `Noma Backup.zip`.
- Three-way merge per note via content hashes; a conflict never loses text — the loser is kept as a "(conflict copy)" note.
- Hard deletes propagate via tombstones (90-day retention) from day one.
- Rides the backup mode you already chose; nothing new to configure, settings never sync.

### Quick capture — PR #63
- **Share target:** send text or images from any app (Android `ACTION_SEND` + PWA `share_target`) — they become a real note, opened in the editor.
- **Home-screen widget** that opens a capture instantly (a launcher, by design — widgets can't read the app's data).
- **Quick Settings tile** — the honest lock-screen-accessible path, since Android bars apps from lock-screen shortcuts.
- Shares arriving faster than the app can drain them queue up (FIFO, cap 25) — none are silently dropped.

### Daily notes + templates — PR #64
- One daily note per **local** date (never UTC — Dhaka days don't roll at 06:00); tapping Today reopens today's note, never duplicates.
- Templates live as a note type: three built-ins seeded with sync-safe ids (Meeting, Morning pages, Checklist), or roll your own. `{{date}}` is the only placeholder.
- Locked notes can neither become nor be made from templates.

### Backlinks — PR #65
- Type `[[` in the editor to link another note; links are id-based chips, so renames never break them.
- A backlinks panel in each note shows everything that links to it, derived live at read time.
- Locked notes contribute nothing (ciphertext in, ciphertext out) but can still be linked to; trashed notes and templates are excluded as sources.

### Per-note version history — PR #66
- Snapshots track editing sessions (replaced state ≥ 60s old), so autosave bursts don't spam history; capped at 50 per note.
- Restoring force-snapshots the current state first, so every restore is undoable.
- Local-only by design — not in backups, not synced. Locked notes have no history at all (no snapshots while locked; locking purges existing history, disclosed in the dialog).

### Encrypted Drive backups — PR #67
- Whole-archive AES-256-GCM envelope (`NOMAENC1`) around the unchanged ZIP; the Drive filename stays the same.
- Passphrase → PBKDF2-SHA256 (600k) → wraps a random master key (which never changes when you change the passphrase).
- Legacy plaintext backups always remain restorable. Encryption state is per-device only — never synced, never backed up, wiped on Drive disconnect.
- A second device joins by entering the passphrase once (sync reports a calm `locked` outcome until it does). **No recovery by design** — lose the passphrase, lose the archive.

### Importers — PR #68
- **Google Keep (Takeout ZIP):** checklists become real checklists, labels become tags, pinned/archived/trashed states and original timestamps preserved; images come through, non-images are skipped and counted.
- **Markdown / text:** files, a folder, or a ZIP. Hand-rolled converter, no new dependency; YAML front matter honoured, parent folder becomes a Noma folder, relative images become attachments.
- **Apple Notes:** Apple offers no export file, so there's no fake parser — Apple notes come in through the Markdown route, and the UI says so.
- Importing is additive only, never replaces anything; re-importing the same export is a no-op (dedupe on title + created time), and every run ends with an honest report.

### Opt-in AI — PR #69
- Off by default. Save your own free Gemini API key (no card) and get **Summarize** and **Suggest tags** on any open note. Summaries render as plain text, never raw HTML; tag suggestions arrive as chips you accept or ignore.
- Your key lives only on your device — never synced, never in backups (a release-gate test builds a real backup and asserts the key appears nowhere in it), wiped on sign-out.
- Nothing is ever sent automatically: one tap, one note, one call. Locked, template and trashed notes are excluded before any text is read.
- Noma has no server and sees nothing: your notes go only to the provider you chose, only when you tap. Cost to Noma: $0, at any number of users.
- *Semantic search is the named follow-up (#8.5), reusing this plumbing.*

### Device-only proofs (still yours, whenever)
CI can't prove these — your phone can:
- **Sync (#62):** two devices editing the same note; conflict copies appear, tombstones propagate.
- **Quick capture (#63):** share-sheet flow, widget tap, QS tile tap (PWA reinstall for the manifest).
- **Daily notes (#64):** Today tap, template seeding/use, two-device built-in dedupe.
- **Backlinks (#65):** picker feel in the WebView, chip tap-through, rename/trash/restore target states.
- **Version history (#66):** edit → wait → edit → restore; the live v3→v4 Dexie upgrade on a real library.
- **Encrypted backups (#67):** sealed file isn't a readable ZIP; second-device passphrase join; passphrase-change propagation; Android closed-app sealed upload.
- **Importers (#68):** a real Keep Takeout or Obsidian-style vault, if one ever shows up.
- **Opt-in AI (#69):** paste an AI Studio key, **Test connection**, summarize a real note.
- **Silent backup (#59):** Scheduled mode with a short custom interval, edit a note, close the app — the `Noma Backup.zip` timestamp in Drive should move on its own.

## 2026-10-23 — the native-feel series

Ten items to make the Android app feel native, worked in order. (The roadmap above is the feature story; this is the feel story.)

### System back, completed — PR #70
- One app-wide back coordinator with a strict priority: an open dialog or menu closes first, the lock screen minimizes, Settings (and account/share-target) returns to the workspace, and inside a note the press unwinds dialogs → search → editor → list → minimize.
- Dialogs and menus register themselves in an overlay registry, so hardware back can see them — they previously only answered to Escape. Non-cancelable dialogs (like the guest-migration prompt) consume the press without closing.
- Predictive back opted in (`enableOnBackInvokedCallback`) for the Android 13+ gesture and its back-to-home preview at the root.

### Edge-to-edge — PR #71
- The window stays edge-to-edge after the splash: content draws behind transparent status and navigation bars instead of dropping back into a letterboxed layout (Android 15+ forced this anyway — now it's deliberate on every version).
- Every shell respects the safe-area insets — workspace, sidebar, Settings, the lock screen, sheets and drawers — so nothing hides under the bars or the gesture pill. Verified in the built CSS cascade, not just written.
- Bar icon contrast follows the in-app theme (light/nature → dark icons, dark/AMOLED → light icons, "system" flips live with the OS), driven through the official StatusBar plugin — pinned to transparent with no overlay in config, so its load-time defaults can't fight the design.

### Swipe actions + undo — PR #73
- Note rows answer the two native gestures: swipe **left** to Move to Trash (the existing Undo toast comes with it, free), swipe **right** to Pin or Unpin — a visible toggle, so deliberately no toast. In Trash, right restores, and left only *opens* the delete-permanently confirmation — a gesture can never fire the one irreversible action directly. Templates keep only the trash swipe; pinning a template means nothing.
- Touch pointers only (a mouse drag can never fling a note), vertical scrolling is never hijacked, and only the card moves — the row's measured height never shifts, so the virtualized list stays calm. Every swipe calls the same action the ⋮ menu does; no new write paths.
- Fallout fix from #71: the bottom-centre toast (Undo included) now also clears the gesture-bar inset on edge-to-edge devices — sonner's offsets had no safe-area awareness, so the toast could sit under the gesture pill.

### Haptics — PR #74
- A small, deliberate haptic vocabulary — and nothing more. A swipe that crosses the commit threshold ticks faintly under the finger; releasing to Pin or Restore answers with a light tap, Trash with a firmer one. The App Lock and locked notes buzz the success pattern when the gate opens and the warning pattern on a wrong credential.
- Everything else stays silent by design — taps, menu actions, typing, autosave, backups. Haptics are punctuation, not narration. One toggle (Settings → Appearance → Haptic feedback, on by default), native-only — the web app never vibrates — behind a fire-and-forget bridge (official `@capacitor/haptics`), so a haptics failure can never break the action it decorates.

### Splash handoff — PR #75
- The native splash overlay used to dismiss on a fixed one-second guess: dead time on fast devices (app painted, waiting behind the artwork) and a blank-WebView flash risk on slow ones. It now dismisses when the web layer signals its first painted frame — AppGate's first mount, one tiny bridge call — with two guardrails: never before 500ms (a shorter artwork flash reads as a glitch) and never after 3 seconds (if the web layer never signals, the fallback fires anyway — the splash can never trap you).
- The artwork also fades in gently over the system splash's blank dark field instead of popping, and BootScreen is untouched — it stays theme-aware, exactly as designed; the dark native stages remain a brief brand moment before it.

### Keyboard / IME manners — PR #76
- The window never declared how it should treat the keyboard — `MainActivity` had no `windowSoftInputMode` at all, so Android guessed, and for a WebView the guess is usually *panning* the whole window. It now declares `adjustResize`: when the keyboard opens, the window (and every `dvh` measurement in the app) shrinks to fit and restores when it closes. The viewport meta gained the matching `interactive-widget=resizes-content` hint, so Chromium/WebView resizes the layout viewport in step instead of the two mechanisms ignoring each other. The Capacitor keyboard plugin was considered and rejected on evidence: its extras are keyboard events and iOS accessory-bar control, and there is no iOS build.
- Dialogs stop being keyboard traps: the shared dialog and alert-dialog primitives now cap their height at the visible area and scroll internally, as defaults — a taller dialog (reminder editor, backup unlock) keeps every field and button reachable with the keyboard up. Consumers that set their own heights still win; the chart and reminder dialogs keep theirs untouched.
- Small input manners: the keyboard's Enter key finally says what it does — "Search" in the search dialog, "Next" on a note's title (Enter already moved you into the body; now the key admits it), "Done" in prompt dialogs, the backup-unlock passphrase, and the AI key field.

### Material You dynamic colour — PR #77
- An opt-in Appearance toggle — **Wallpaper colours (Material You)**, shown only in the Android 12+ app — retints just the accent family (primary, focus ring, accent surfaces) from the wallpaper-derived system palette. Backgrounds, surfaces and text keep the chosen theme exactly as tuned: Nature stays warm, AMOLED stays pure black, only the accent follows your wallpaper. On web and older Android the row simply doesn't exist — no dead toggles.
- The palette comes from the framework's own dynamic-colour resources through a tiny synchronous bridge in MainActivity (the splash bridge's pattern) — no Material library, no new dependency. Foreground text on the retinted colours is picked by contrast, not hard-coded per mode.
- No cold-start flash: the last pulled palette is cached, and the render-blocking bootstrap paints it before the first frame — the same flash-free standard as the splash handoff. Turning the toggle off clears everything and Noma's own palette returns.

### Reminder notification polish — PR #78
- A reminder finally says what it's for. The notification carries the note's title and the reminder time on a dedicated **Note reminders** channel (importance high — a reminder that whispers is a reminder missed; Android locks that after creation, so it was chosen deliberately, and system settings can still turn it down). Tapping it opens that exact note — the schedule call has carried the note id all along; the tap listener is what was missing. Cold-start taps are retained by the bridge and replayed to the app-shell listener, and a tap that arrives while the App Lock is on waits in the same kind of pending slot as quick capture and lands on the note right after unlock. A reminder scheduled before this update picks all of it up on the next launch — the rehydrate pass re-posts it with the new text on the new channel, nothing to redo.
- The privacy line is held exactly where it was drawn: note *content* never appears in a notification, and a per-note-locked note's reminder stays fully generic ("Reminder from Noma") — its title never reaches the phone's lock screen. What changed is only that an unlocked note's title, metadata the app itself shows in lists, may head the notification.
- Deliberately not here: Snooze / Done buttons on the notification. That's a semantics decision of its own, not a polish detail.

### Launcher shortcuts — PR #79
- Long-pressing the launcher icon now offers two doors instead of one: **New note** (the quick-capture door that was already there, finally labelled as what it is — its strings used to read "Note"/"Note") and **Today**, which opens today's daily note straight in the editor, creating or restoring it if needed. The Today shortcut calls the very same handler as the sidebar's Today button — one behaviour, two entrances — and both shortcuts wait behind the App Lock exactly like quick capture: a tap while locked lands after unlock, never before.
- The deep-link routing stays as strict as it was, just wider: the validator grew from one hard-coded URL to a two-host allowlist (`new-note`, `today`) with the same rejection posture — exact scheme, exact host, no path, no query, no hash, anything else refused. No open-ended URL routing was introduced to save a few lines.
- The installed PWA reaches parity: its manifest gains the same Today entry. The older "New note" entry keeps its `?capture=new-note` route into the capture queue; Today is navigation, not captured content, so it rides a sibling `?shortcut=today` param with its own strict parse into the same pending-shortcut slot the native links feed — one gate, one consumption path, on every platform.
- Deliberately not here: dynamic (usage-ranked) shortcuts and a third entry — a native bridge and a lifecycle for zero benefit over two fixed actions.

### Widget v2 — PR #80
- The home-screen widget stops being a single branded button — at a large size it becomes a window into the library: a header (tap → new note), a **Today** row carrying the daily note's title (tap → straight into today's note, the shortcut's door from #79), and up to three note rows, pinned first then most recent, each opening its own note. Small placements keep the familiar v1 look, and resizing between sizes re-renders in place.
- Widgets can't read the WebView's IndexedDB, so v2 borrows the staged discipline from background backups (#60): the web layer builds a tiny JSON snapshot — titles only, never content — and stages it into app-private storage through a small `NomaWidget` plugin (temp file + rename, then a refresh); the provider renders from that file with no WebView alive. Freshness comes from those pushes (still `updatePeriodMillis="0"` — no polling, no battery), restaged only when the snapshot actually changes, and flushed when the app hides so the last edit is in. Note rows tap through a new note door, `app.noma.notes://note/<id>`, with the strictest validator yet (exact scheme, exact host, a real UUID shape, nothing else) — and it lands in the reminder tap's pending-open slot (#78), so every rule already built applies: App Lock first, a locked note's unlock gate, a trashed note resolving to a plain open.
- The privacy rules are the strictest in the series, because a widget is the most exposed surface Noma has — it sits on the home screen all day. Per-note-locked notes contribute nothing, not even a placeholder, and a locked daily note empties the Today row instead of leaking its title. And if **App Lock is enabled, the staged snapshot is generic** — zero note data, the v1 branded look — because App Lock's promise is that content waits behind the gate. Sign-out clears the snapshot in the same pass that clears the Drive and AI records, and an account switch clears before the new account stages its own, so one account's titles never outlive it on someone else's home screen.

### Device-only proofs
- Back from Settings returns to the workspace every time; back with a menu or dialog open closes it first; back at the lock screen minimizes and reveals nothing; predictive-back preview on Android 13+.
- **Edge-to-edge (#71):** bars stay transparent in every theme; headers clear the status bar; sheets and drawers clear the gesture area; cutout insets in landscape.
- **Swipe actions (#73):** swipe feel in the Android WebView; vertical scroll never hijacked; tap still opens; half-swiped rows reset on scroll; Undo toast reachable and tappable above the gesture bar; trash-view left swipe opens the confirm dialog; locked-note swipe round-trip.
- **Haptics (#74):** slow swipe ticks the moment the underlay arms (and re-ticks after dropping back below the threshold); trash commit feels firmer than pin; wrong PIN warns and the right PIN confirms at both the App Lock and a locked note; the Settings toggle silences everything immediately; behaviour with system touch-feedback disabled noted.
- **Splash handoff (#75):** cold start, fast path — artwork shows briefly (never a strobe), the app arrives with no dead pause and no white flash; cold start under load or freshly cleared storage — the artwork stays until the app paints, never fading onto a blank WebView; light and dark theme starts both feel continuous, bars appear once and stay edge-to-edge; share-sheet / QS-tile / widget cold starts land in their flows as before; with App Lock on, overlay → BootScreen → lock screen with no frame of note content in between.
- **Keyboard / IME (#76):** long note, tap at the very end — the layout shrinks, the caret line sits above the keyboard, typing at the document end never hides the current line, the formatting toolbar stays reachable; reminder dialog with the keyboard up scrolls internally with its buttons reachable; workspace search resizes smoothly with the header in place and no pan/jump; prompt dialog Enter reads "Done", search Enter reads "Search", title Enter reads "Next" and moves into the body; rotate with the keyboard open — no stuck half-panned window; the `[[` link picker near the bottom of the visible area stays on screen.
- **Material You (#77):** toggle on → buttons, links and the focus ring take the wallpaper palette in light and in dark; change the wallpaper, background and resume Noma → the accent follows without a restart; toggle off → Noma's own palette returns instantly; cold start with the toggle on → no default-blue flash before the wallpaper colour; Nature and AMOLED keep their surfaces with only the accent retinted.
- **Notification polish (#78):** a reminder on a normal note fires showing the note's title and the reminder time; a reminder on a locked note fires with the generic text; tapping a reminder opens that exact note — warm start and cold start; tapping while App Lock is on lands on the note after unlock; system settings show the "Note reminders" channel and its controls work; a reminder scheduled before the update reappears with title + channel after the first launch.
- **Launcher shortcuts (#79):** long-press the launcher icon → both "New note" and "Today" appear; Today on a cold start with the app unlocked lands in today's note in edit mode, and a repeat tap later opens the same note (no duplicate); Today with App Lock on does nothing until unlock, then lands; Today when today's note was trashed restores it; New note still works warm and cold; the installed PWA's long-press/right-click menu shows both entries and Today lands the same way.
- **Widget v2 (#80):** place the widget large → Today + up to 3 note titles appear; tap a note row → that note opens (cold and warm); tap with App Lock on → lands after unlock; lock a shown note → its row vanishes on next app visit; enable App Lock → widget goes generic-branded; delete a shown note → row gone after opening the app; resize down to 2×1 → the familiar v1 look; switch account → only the new account's notes ever appear.

## 2026-10-22

- **Per-note lock (PR #56):** notes lockable by pattern/PIN/password with real AES-256-GCM encryption of body + attachments; no recovery by design.
- **TanStack CVE bump (PR #57):** unblocked Vercel deployments (`BLOCKED_PACKAGE` on the old `@tanstack/react-start`).
- **Startup polish (PR #58):** branded boot screen + structural workspace skeleton replace the bare "Opening Noma…" states.
- **Hybrid backup rebuild (PR #59):** backup engine moved into the app shell (sync-after-edit + scheduled presets) instead of living in the Settings screen; Android gets a real silent uploader via WorkManager (PR #60), with a javac fix in PR #61.

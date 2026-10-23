# Changelog

All notable changes to Noma. Dates are merge dates on `main`.

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

### Device-only proofs
- Back from Settings returns to the workspace every time; back with a menu or dialog open closes it first; back at the lock screen minimizes and reveals nothing; predictive-back preview on Android 13+.

## 2026-10-22

- **Per-note lock (PR #56):** notes lockable by pattern/PIN/password with real AES-256-GCM encryption of body + attachments; no recovery by design.
- **TanStack CVE bump (PR #57):** unblocked Vercel deployments (`BLOCKED_PACKAGE` on the old `@tanstack/react-start`).
- **Startup polish (PR #58):** branded boot screen + structural workspace skeleton replace the bare "Opening Noma…" states.
- **Hybrid backup rebuild (PR #59):** backup engine moved into the app shell (sync-after-edit + scheduled presets) instead of living in the Settings screen; Android gets a real silent uploader via WorkManager (PR #60), with a javac fix in PR #61.

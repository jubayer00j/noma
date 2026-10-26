# Changelog

All notable changes to Noma. Dates are merge dates on `main`.

## 2026-10-26

### Search snippets keep list markers — PR #TBD

- Consistency follow-up to PR #94: the All Notes cards learned to show a list's ordering, but search results still built their snippets with the flat plain-text extractor, so the same note found through search snippeted as the unordered run "Hlw 1 2 3 …".
- Snippets are now cut from the same structure-aware preview text the cards use: list items keep their computed markers (numbers honouring start and type, bullets, checkboxes), and the match window is located in that structured text, falling back to the head of the note when a flat-text match can't be located there. Presentation only — scoring still runs on the flat extractor exactly as before, locked notes stay title-only with no snippet, and the structured text is built only for notes that actually match, never for the whole library.
- Proof: four new search tests — the reported Testing-note shape snippetting with its markers, a deep body match windowed in the structured text, a title-only match taking the structured head snippet, and locked-note snippet behaviour unchanged. Full suite green.

## v1.2.0 — 2026-10-25

The second feature release, distilled from the 2026-10-25 programme (PRs #90–#96, detailed in the dated entries below).

**New**

- **Share / Export any note:** every note can leave Noma on its own — as self-contained HTML, Markdown, or plain text, via the share sheet or as a saved file. Locked notes export only through the unlock gate (PR #92).
- **Semantic search:** search now finds notes by meaning, not just words. Build the index once in Settings → AI features and conceptually related notes surface even with no shared words, across languages. Vectors are stored only on this device — never backed up or synced — and locked notes are never indexed (PR #95).
- **Settings redesign:** the eight categories now sit in four grouped cards with icon tiles, and every sub-screen header carries its category's tile. Presentation only — every setting behaves exactly as before (PR #96).

**Fixed**

- Typed numbered lists no longer lose their numbers at save time, and list words count and preview properly (PR #90).
- The app header no longer slides under the Android status bar (PR #91).
- Markdown imports round-trip faithfully: re-importing a Noma Markdown export keeps list starts and lettered/roman lists instead of renumbering and flattening them (PR #93).
- All Notes previews keep their list markers — numbers, bullets, and checkboxes — instead of a flat run of words (PR #94).

## 2026-10-25

### App header no longer slides under the status bar — PR #91

- Bug fix, found on device: Noma's top bar — title, search, the new-note button — slid underneath the Android status bar, overlapping the clock and status icons. Native apps like Facebook are also edge-to-edge yet start their content cleanly below the bar.
- Root cause: edge-to-edge (PR #71) pads the shells with CSS `env(safe-area-inset-top)`, but inside the Android WebView that value reports only the display-cutout inset, not the status-bar height — on this device it resolved to 0, so the padding vanished. Native apps never see the problem because Android hands them the real `WindowInsets`.
- `MainActivity`'s insets listener — the one that already forwards the IME height (PR #83) — now also forwards the real system-bar insets in CSS px as a `noma:system-insets` window event (deduped on change), with a `window.NomaSystemInsets` getter covering values dispatched before the web layer boots. The listener still only observes and returns the insets unchanged, and the splash sequence is untouched. The web layer keeps the values as `--noma-inset-top` / `--noma-inset-bottom` on `<html>`, and `pt-safe` / `pb-safe` now pad by the larger of the env() inset and the native value — on web and PWA the vars are never set, so rendering there is exactly as before.
- Device-only proof: in the installed app, the All Notes and note headers sit fully below the status bar with no overlap, in light and dark themes; rotating the phone and opening the keyboard keep them clear; the web build is unchanged.

### Typed numbered lists keep their numbers after save — PR #90

- Bug fix, found on device: building a numbered sequence by typing "1. ", "2. ", "3. " showed the right numbers in the editor, but after saving every line restarted at 1 — in the read view, and back in the editor too, so the numbers were lost at save time, not merely drawn wrong. The same content also read as one glued word in previews ("Hlw123Hi123Hey123") and counted a whole list as "1 words".
- Root cause was the content sanitiser: each typed line becomes its own one-item ordered list whose number lives in the list's `start` attribute, and the sanitiser's allowlist had no `OL` entry at all, so `start` — and the marker-style `type` — was stripped on every save and again at read-view render. A single list built with the toolbar button never carries `start`, which is why that flow looked fine.
- The sanitiser now keeps a validated `start` on ordered lists (a positive integer, 1–9999; anything else drops the attribute) and a validated `type` (only 1/a/A/i/I). Plain-text extraction now treats block boundaries as word separators, so word counts, previews, search snippets and AI prompts see the words the note actually has. One honest limit: notes already saved with their starts stripped cannot get them back — the numbers were deleted at save time; editing such a list re-derives them and they stick from then on.
- Proof: new sanitiser regression tests — a typed "3. " list round-trips with its start intact and stays stable across re-saves, a lettered type is kept and an invented one dropped, invalid starts (0, negative, non-numeric) are dropped, and list items count as separate words. Full suite green.

### Share or export any note as a file — PR #92

- New feature: every note gains a "Share / Export" action — in the note list's ⋮ menu and in the Read View / editor overflow menu. It opens one dialog: pick a format (HTML, Markdown, or plain text), then Share… via the platform share sheet or Save file. Until now the only way to get a note out of Noma was the whole-library backup ZIP.
- The HTML export is a single self-contained file — inline styles in the spirit of the app's reading view, images embedded as data URLs — so the person receiving it just opens it in any browser, no app and no account needed. Markdown is for other notes apps and round-trips: Noma's own importer reads it back in. Plain text is the universal fallback. A hand-rolled converter (no new parsing dependency) covers headings, emphasis, links, code, quotes, tables (GitHub-flavoured pipe tables), task lists, note-link chips (exported as their label text) and charts (a labelled "[Bar chart]" placeholder — charts don't travel as markup). File names come from the note title with path-hostile characters stripped; Bengali titles survive intact.
- Numbered lists export with their real numbers: the converter honours the ordered list's `start` attribute and computes lettered/roman markers for `type` a/A/i/I, in Markdown and in plain text alike — the companion piece to PR #90's save-time fix.
- Locked notes are never exported from ciphertext: choosing Share / Export on a locked note routes through the unlock gate first (the same rule duplicate follows), and the dialog only ever opens on the unlocked session's decrypted content and attachments.
- Delivery: on Android the file is staged in the app cache and handed to the native share sheet (@capacitor/share + @capacitor/filesystem, new in this PR, both lockfiles regenerated); "Save file" reuses the backup export's SAF plumbing. On web, Save is a Blob download and Share appears only when the browser can share files (Web Share API with a real File — no text-only fallback).
- Proof: 26 new converter tests (typed-list numbers in both text formats, letter/roman markers, task checkboxes, tables, image embedding and degradation, chart placeholders, chip labels, filename sanitising incl. Bengali and the 80-char cap). Full suite green.

### Markdown imports keep ordered-list numbers and lettered lists — PR #93

- Follow-up to PR #92, from its Codex review: the exporter writes a note's ordered lists faithfully — `3.` starts, `a.`/`i.` markers — but the Markdown importer only recognised digit markers and always rebuilt a list as a bare `<ol>`, so an export re-imported into Noma renumbered a shifted list back to 1 and flattened lettered and roman lists into plain paragraphs.
- Numeric runs now keep their start: the converter reads the run's first marker value and emits `<ol start="N">` (omitted when 1, and outside the sanitiser's 1–9999 bound) — the attribute PR #90 taught the sanitiser to preserve. Lettered (a/A) and roman (i/I) markers are recognised too, but only as sequence-confirmed runs: a candidate line becomes a list item only when the next candidate line at the same indent continues the sequence (+1, same system and case; roman is read before alpha, so "i. ii. iii." is roman while "c. d." is alpha), runs split when the marker system changes, and a marker that breaks an established sequence ends the run. A lone lettered line is never a list, by design — prose like "a. Some sentence." or "i. e. …" keeps its paragraphs. Multi-letter markers past z (aa, ab, …) are parsed in the same spreadsheet style the exporter writes, so lettered lists longer than 26 items round-trip whole instead of dropping to prose at item 27.
- Proof: nine new importer tests — numeric starts with both delimiters plus the sanitiser round-trip, lettered types and starts including a nested lettered list, roman-over-alpha interpretation and roman starts, prose safety for unconfirmed candidates, sequence breaks, numeric-to-lettered run splitting, and multi-letter markers past z (a generated 28-item list, starts at z/aa, unconfirmed aa lines staying prose). Full suite green.

### Note previews keep their list markers — PR #94

- Bug fix, found on device: the All Notes card preview was built with the flat plain-text extractor, which knows words, not lists — every list marker was stripped, so a note structured as "1. Hlw" with bullet sub-lists under each item previewed as the unordered run "Hlw 1 2 3 Hi 1 2 3 Hey 1 2 3". The read view (real HTML) showed the ordering fine; only the card lost it.
- The preview now comes from a structure-aware builder in note-export.ts that reuses the plain-text export walker: ordered items keep their computed markers (the list's `start` and `type` are honoured — numeric, lettered including "aa" past z, and roman), bullets get "•", task items show "• [ ]" / "• [x]", and nested items keep their own markers. The note title (the card shows it separately) and link URLs stay out, and the text is flattened to the same space-separated flow — and the same length truncation — as before.
- Deliberately preview-only: word counts, search snippets and AI prompts keep the flat extractor unchanged, so markers never count as words and never become searchable text.
- Proof: new tests pin the exact preview string for the reported note shape, start/type honours, task checkboxes, nested markers, unchanged plain-paragraph previews, and word-count isolation. Full suite green.

### Semantic search — PR #95

- New feature (#8.5, the named follow-up to opt-in AI): search is no longer keyword-only. With an AI provider configured, Settings → AI features gains a Semantic search subsection — tap "Build search index" once and each note is embedded by the active provider into a vector stored on this device; from then on, a search also surfaces notes that are *about* the query even when they share no words with it, including across languages (an English query can find a Bengali note — the embedding model is multilingual). Meaning-based scores blend into the existing keyword score; keyword behaviour is untouched whenever semantic is off, unbuilt, invalid or failing — search can only get better, never worse.
- Providers: Gemini embeds natively with gemini-embedding-001 (768 dimensions, batch endpoint); OpenAI and OpenRouter use the standard /embeddings shape with verified default models. Groq and DeepSeek expose no embeddings service and say so honestly in Settings; Together, Mistral and custom endpoints take a user-typed embedding model, unverified, like chat via Custom. The embedding model is a per-provider slot setting, saved with the key through the same save flow — keys and models stay in the on-device record, never in backups or sync.
- The no-ambient rule holds: nothing embeds before the explicit Build tap. After that opt-in, saving a note refreshes its vector, Update index reconciles everything (new/changed embedded, deleted/locked/trashed/template vectors removed), and Remove index wipes it. Locked, template and trashed notes are never embedded and never surface semantically — the same eligibility predicate as the note AI actions.
- Vectors are derived data, treated like version history: a local-only Dexie v5 table that never enters a backup ZIP and is never copied between databases; each device rebuilds its own. Switching provider or embedding model invalidates the index in the open — Settings demands a rebuild and search stays keyword-only meanwhile; vectors from two models are never mixed.
- Proof: 35 new tests (619 total) — slot round-trip incl. pre-#8.5 records, both transports' request shapes against mocked fetch, malformed-vector rejection, build/status/reconcile lifecycle, provider-change invalidation, save-time maintenance, blending (semantic-only surfacing, below-threshold exclusion, keyword ordering byte-identical without an index, stale vectors unable to surface ineligible notes), backup exclusion, Dexie v5 schema, and copyDatabase exclusion.
- Post-review fixes (Codex review of this PR): the index identity now includes the provider endpoint — repointing a Custom endpoint at another server invalidates the index and prompts a rebuild instead of silently comparing new-endpoint queries against old-endpoint vectors (the key format is now slot|endpoint|model|dims; no shipped index ever used the earlier format). And vectors are now maintained on the write paths that bypass the editor's save hook: locking a note deletes its vector in the same moment the body is sealed, version restores refresh the vector to the restored content, permanent deletes (including sync tombstones) take the row with them, and backup restores, sync merges and imports drop any vector whose stored hash no longer matches the note — all locally, with no extra provider calls.

### Settings redesign — PR #96

- Presentation-only redesign of Settings, from Jubayer's mock: the root category list is no longer one flat list — the eight categories now sit in four grouped cards ([Sync & backup, Security], [Appearance, Writing], [AI features, Data], [Account, About]), each a rounded card surface with hairline dividers inset between its rows.
- Every row gains an icon tile — a rounded square in the primary tint carrying the category's line icon (cloud-upload, shield-check, palette, type, sparkles, database, user, info) — beside the same live state summaries as before, with roomier rows and larger titles. All colours come from the theme tokens, never hardcoded, so the design follows the light, custom and Material You themes; the default dark theme renders the mock's lavender-on-navy from its own palette.
- Sub-screen headers gain the same icon tile beside each category title, aligned with the root header. Two existing card blocks inside sub-screen bodies (Account's not-configured panel, the Data import summary) had their corner radius aligned to the new cards — a pure class swap; nothing else inside the sub-screens moved.
- Nothing behavioural changed: summaries, handlers, the all-mounted sub-screen mechanics and the hardware-back flow are exactly as before. Proof: the existing settings suite passes untouched, plus a new assertion pinning the four-card grouping, pair order and per-row icons, and a header-tile assertion on sub-screen navigation (633 tests).

## v1.1.0 — 2026-10-24

The first feature release since 1.0.1, distilled from the 2026-10-22 → 2026-10-24 programme (PRs #56–#88, detailed in the dated entries below) — and the first release to pass the full device-acceptance checklist (95 rows, all positive) before shipping.

- **Multi-device sync** over the Drive backup archive: pull-merge-push, per-note conflict copies, tombstoned deletes (PR #62).
- **Encrypted Drive backups**: whole-archive AES-256-GCM with a passphrase-derived key; no recovery by design (PR #67).
- **Per-note lock**: pattern/PIN/password with real AES-256-GCM on body + attachments — distinct from the App Lock barrier, which stays a UI gate (PR #56).
- **Quick capture everywhere**: Android share target, home-screen widget, Quick Settings tile, and launcher shortcuts for New note and Today (PRs #63, #79, #80).
- **Daily notes + templates**, **[[backlinks]]**, and **per-note version history** (local-only, undoable restores) (PRs #64–#66).
- **Importers** for Google Keep Takeout and Markdown/text — additive only, deduped, honestly reported (PR #68).
- **Opt-in AI**: Summarize + Suggest tags with your own key — Gemini plus six OpenAI-compatible presets and custom endpoints, each provider keeping its own key on-device (PRs #69, #84–#87).
- **Native-feel Android**: system back, edge-to-edge, swipe actions, haptics, splash handoff, Material You dynamic colour, privacy-redacted reminder notifications, widget v2 (PRs #70–#80) — plus the Settings restructure into eight categories (PR #81), the keyboard/caret fixes (PRs #82–#83), and the cold-start share-duplicate fix (PR #88).

## 2026-10-24

### Cold-start shares no longer create the note twice — PR #88

- Bug fix, found on device during acceptance testing (checklist B3): sharing a photo into Noma while the app was closed or sitting behind the App Lock created the same note twice, every time. Sharing into an already-running Noma was fine.
- Root cause was a double delivery on the cold-start path: Capacitor's `BridgeActivity` re-dispatches the launch intent through `onNewIntent` during `super.onCreate`, and `MainActivity.onCreate` then forwarded `getIntent()` to the share plugin a second time by hand — so one share sat in the native queue twice. Each copy drained with a fresh capture id, so the web layer's consume-once guard couldn't recognise them as the same share.
- `MainActivity` no longer forwards the launch intent explicitly (it still arrives via `onNewIntent`), and the share plugin now ignores a re-delivery of the exact same Intent object as a belt-and-braces guard. Two genuine shares in a row are always distinct Intent objects, so back-to-back shares still both land.
- Device-only proof (checklist B3/B4): share a photo while Noma is closed/App-Locked → unlock → exactly one note; share two items back-to-back → two notes.

### Per-provider AI keys — PR #87

- Bug fix, found live on device within the hour of #86 shipping: switching providers sent the PREVIOUS provider's key to the new one. The AI record held a single key for every provider, and the saved-key UI had no key-entry field — so a user with a saved Gemini key who switched to OpenRouter watched Test connection fail with "that key didn't work" (OpenRouter was quite rightly rejecting the Gemini key), and the only place a new key could go was the Model field. Switching back could never restore the original key either.
- Each provider preset now keeps its OWN slot — key + model, plus the endpoint for Custom — inside the same per-account on-device record. Selecting a provider loads its slot: its masked saved key if it has one, an empty key field if it doesn't (never another provider's key or mask). Keys can be replaced or removed per provider without touching the others, and a provider only ever receives its own key.
- Existing records migrate themselves on read, losslessly: a single-key record's key and model land in the slot for its provider (an unmatched endpoint becomes the Custom slot, URL kept), and that slot becomes the active one. No re-entry, no setup step. Note actions keep consuming the active provider's projected settings, unchanged.
- Keys still live only in that record — never in AppSettings, backups, or sync — and the release-gate backup test now proves it with three providers' keys stored at once: none of them appears anywhere in a built backup.
- Device-only proof (checklist U2/U3): save a Gemini key, switch to OpenRouter, save a different key there, Summarize works; switch back to Gemini — the original key is intact, no re-entry.

### Multi-provider AI — PR #86

- AI is no longer Gemini-only. Settings → AI features now offers a provider picker: Gemini (unchanged default — existing keys keep working with zero action) plus OpenAI-compatible presets for OpenAI, OpenRouter, Groq, Together, DeepSeek and Mistral, and a Custom endpoint field for any other OpenAI-compatible API. The model is free text per provider, so new models work without an app update; switching presets fills the field with that preset's default, which you can overwrite.
- Under the hood it is two API shapes, not a provider zoo: Gemini's native API as before, and one chat-completions client (Bearer key, `{model, messages}` in, `choices[0].message.content` out) shared by every preset. Test connection, Summarize and Suggest tags all route through one dispatch on the provider; prompts never change, and the #84 error mapping carries over with provider-neutral messages (bad key, quota, busy, model-unavailable naming the model). OpenRouter gets the identification headers its docs ask for; custom endpoints must be https.
- Keys still live only in the per-account on-device record — never in AppSettings, never in backups or sync (the release-gate test now covers OpenAI-compatible records too). The honest privacy line, stated in Settings: your note text goes to whichever provider you pick; Noma itself still sees nothing.
- Deliberately not here: a native Anthropic client (phase 2 — Anthropic is reachable meanwhile through OpenRouter), model-list fetching, and streaming.
- Review fix (Codex P2): with a key already saved, provider/model edits had no way to persist — Test ran against the unsaved draft while note actions kept using the old record. The saved-key UI now shows a "Save provider settings" button exactly when the drafts differ from the saved record, and a passing test while drafts are unsaved says so instead of claiming the provider is ready.
- Device-only proof: pick a second provider (e.g. OpenRouter with any model), save its key, Test connection succeeds, Summarize + Suggest tags work on a real note; switching back to Gemini keeps working with the original key.

### Default AI model moves to Gemini 3.5 Flash-Lite — PR #85
- The old default, `gemini-2.5-flash`, answers new API keys with a 404: since September 18, Google limits the 2.5 family to users who actively used those models before, and a brand-new free key is a "new user". The user proved it live — PR #84's error surfacing named the model instead of hiding behind the generic line.
- The default is now `gemini-3.5-flash-lite`: one of Google's two named directions for new projects, the free-tier-friendly lite model with the highest availability, and more than enough for a summary and five tags. Deliberately not the moving `gemini-flash-latest` alias (the model behind it can change without notice) and not `gemini-3.8-flash` (reported as frequently overloaded on the free tier). Nothing else changes — same prompts, same key handling, same error mapping, and a per-record model override still wins when set.
- Device-only proof: retest Test connection with the same key, then Summarize on a real note — both should now succeed.

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


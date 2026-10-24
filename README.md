# Noma

[![Live Demo](https://img.shields.io/badge/Web_App-mynoma.vercel.app-blue?style=flat-square&logo=vercel)](https://mynoma.vercel.app)
[![Platform](https://img.shields.io/badge/Platform-Web%20%7C%20PWA%20%7C%20Android-brightgreen?style=flat-square)](#technology-stack)
[![Offline First](https://img.shields.io/badge/Offline--First-IndexedDB%20%2B%20Serwist-orange?style=flat-square)](#privacy--security)

> **Calm, offline-first note-taking for Web, PWA, and Android.**

Noma is a minimalist note-taking application designed to provide a calm, distraction-free environment for your thoughts, ideas, and data. Built with a local-first orientation, Noma allows your notes, attachments, and reminders to be stored directly on your device (via IndexedDB)—whether you are working in a web browser, installed as a Progressive Web App (PWA), or running natively on Android.

---

## Table of Contents

- [Overview](#noma-overview)
- [Features](#current-features)
  - [Rich Text & Editor](#notes--editor)
  - [Organization](#organization)
  - [Reminders & Notifications](#reminders)
  - [Advanced Charts & Graphs](#advanced-charts--graphs)
  - [Images & Attachments](#images--attachments)
  - [Security & App Lock](#security)
  - [Backup & Restore](#backup--restore)
  - [Import](#import)
  - [Authentication & Cloud Backups](#authentication--cloud-backups)
  - [AI (Opt-in)](#ai-opt-in)
  - [Android Application](#android)
  - [Web & PWA](#webpwa)
  - [Settings](#settings)
  - [Developer Contact](#contact--feedback)
- [Privacy & Security](#privacy--security)
- [Technology Stack](#technology-stack)
- [Quick Start](#quick-start)
- [Android Development](#android-development)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [Project Status](#project-status)
- [License](#license)

---

## Noma Overview

Noma is built around a local-first architecture where device storage (IndexedDB via Dexie.js) acts as the primary data store. Unlike cloud-centric note applications that depend on active network connectivity for core operations, Noma is designed to function offline.

### Core Design Principles

- **Local Device Storage:** Notes, attachments, reminders, and settings are saved locally to IndexedDB.
- **Calm Interface:** Clean design powered by Tiptap and Tailwind CSS, focusing on productivity without clutter.
- **Cross-Platform Availability:** Run Noma in a web browser, install it as a desktop/mobile PWA, or run the native Android build.
- **User-Driven Cloud Backups & Sync:** Optionally sign in and back up to Google Drive (manually, on a schedule, or automatically after edits) or to local `.zip` files. The same Drive archive carries multi-device sync, and the whole archive can be encrypted with a passphrase only you know.

---

## Current Features

### Notes & Editor

- **Tiptap Rich Text Editor:** Powered by a modern block editor supporting clean typography and markdown-like formatting shortcuts.
- **Formatting Controls:** Bold, italic, underline, strike-through, inline code, text colors, and highlights.
- **Headings:** Structured heading levels (H1, H2, H3).
- **Lists & Checklists:** Bulleted lists, numbered lists, and interactive task checklists.
- **Links & Quotes:** URL hyperlinking, blockquotes, and styled code blocks.
- **Dividers & Tables:** Horizontal rule dividers and rich-text tables with customizable rows, columns, and headers.
- **Image Embedding:** Local photo uploads with client-side canvas compression and inline web image URLs.

### Organization

- **Folders & Tags:** Group notes inside folders or tag them for flexible categorization.
- **Favorites & Pinned Notes:** Pin important notes to the top of your workspace or mark favorites for quick access.
- **Instant Search & Filtering:** Full-text search across titles and content, alongside tag and folder filtering.
- **Archive & Trash:** Archive inactive notes or move notes to trash before permanent deletion.
- **Daily Notes & Templates:** One daily note per local date — the Today door reopens it instead of duplicating. Notes can be saved as templates (three built-ins included), with `{{date}}` as the only placeholder.
- **Backlinks:** Type `[[` in the editor to link another note; links are id-based, so renames never break them, and each note shows what links to it.
- **Version History:** Per-note snapshots of settled edits (kept on this device only), with undoable restore.

### Reminders

- **Note Reminders:** Attach scheduled reminders directly to individual notes using a date and time picker.
- **Dedicated Reminders View:** Centrally view all upcoming, due, and completed note reminders.
- **Local Notifications:** Trigger native system notifications on Android (via `@capacitor/local-notifications`) and Web Notifications on PWA/Desktop.
- **Status Lifecycle:** Complete, dismiss, or reschedule reminders for a future date/time.
- **Private Notifications (Android):** Reminder notifications show the note's title and time — but a per-note-locked note's reminder stays fully generic, so nothing private reaches the lock screen.

### Advanced Charts & Graphs

- **Structured Editable Charts:** Interactive offline chart blocks powered by Recharts (Schema v2).
- **Multi-Series Data Matrix:** Spreadsheet-style table editor within note dialogs, supporting TSV clipboard pasting.
- **7 Chart Types:** Bar, Line, Area, Pie, Donut, Radar, and Composed charts (with per-series type configuration where supported).
- **Customization Options:** Custom titles, subtitles, legend position, gridlines, stacked bar mode, custom color swatches, and axis labeling.
- **Live Preview:** Real-time chart rendering while editing data matrix or options.
- **Persistence:** Preserved across note saves, rehydration, and ZIP backup exports/imports.

### Images & Attachments

- **Local Attachment Storage:** Device photos stored in Dexie `db.attachments` using custom `noma-attachment://` URI references.
- **Canvas Compression & Resizing:** Client-side photo resizing and quality compression prior to storage.
- **Attachment Reconciliation:** Automated background cleanup of unreferenced attachments to manage local storage usage.
- **Backup & Restore:** Binary image attachments are bundled within local ZIP backup archives and Google Drive backups.

### Security

- **App Lock System:** Guard application entry with local credential verification (PBKDF2-HMAC-SHA256).
- **Unlock Options:** Unlock via Noma Pattern, Noma Password, or native Android Biometrics (`androidx.biometric`).
- **Per-Note Lock:** Individual notes can be locked with a pattern, PIN, or password. Unlike App Lock (an access barrier), per-note lock is real encryption: the note body and its attachments are sealed with AES-256-GCM, and only the title stays visible in lists. Fingerprint unlock is an on-device convenience copy of the key — there is **no recovery** if you forget the credential.
- **Rate Limiting & Lockout:** Protection against repeated failed unlock attempts with exponential lockout delays up to 30 minutes.
- **Configurable Lock Timeout:** Set automatic re-locking timers (immediate, 1 min, 5 mins, 15 mins, etc.).
- **Launcher Shortcut Protection:** Launcher shortcuts check active App Lock authentication before presenting note creation views.
- **Security Credential Handling:** Security credential hashes and salts are omitted from backup export payloads.

### Backup & Restore

- **Local ZIP Backups:** Export database backups (notes, attachments, reminders, tables, charts) into compressed `.zip` files.
- **Android SAF Integration:** Storage Access Framework tree picker support on Android 10+ for native file destination selection.
- **Google Drive Cloud Backups:** Back up and restore archives to/from your own Google Drive (via OAuth 2.0 GIS on Web, native authorization client on Android), with `drive.file` scope — Noma only ever sees its own backup folder. Backups can run manually, on a schedule, or automatically after edits (including a silent background upload on Android).
- **Multi-Device Sync:** Sync rides the same canonical Drive archive — a pull-merge-push cycle whenever backups run (not real-time sync). Merges are per note by content hash; a conflict never loses text (the older version is kept as a "(conflict copy)"), and deletions propagate via tombstones. Settings never sync.
- **Encrypted Backups:** The whole Drive archive can be sealed in an AES-256-GCM envelope derived from your passphrase. There is no recovery: lose the passphrase, lose the archive. Older plaintext backups always remain restorable.
- **Security Exclusions:** Password and pattern credential hashes are explicitly excluded from backup payloads.

### Import

- **Google Keep (Takeout ZIP):** Checklists become real checklists, labels become tags, pinned/archived/trashed states and original timestamps are preserved, and images come through as attachments.
- **Markdown & Text:** Import individual files, a folder, or a ZIP — front matter is honoured and the parent folder becomes a Noma folder. (Apple Notes has no export file, so Apple notes arrive through this route.)
- **Additive Only:** Importing never replaces anything, and re-importing the same export is a no-op (dedupe on title + created time). Every run ends with an honest report.

### Authentication & Cloud Backups

- **Firebase Authentication:** Optional user account sign-in supporting Email/Password (with verification flow) and Google Sign-In.
- **Native Android Auth:** Uses `@shardev/capacitor-google-auth` for native Google Sign-In on Android.
- **Account Isolation:** Database separation (`noma_guest` vs `noma_<uid>`) isolating data between signed-in accounts and guest mode.
- **Guest Data Migration:** Transfer guest notes into a newly authenticated user database upon sign-in.
- _Note:_ Firebase is used strictly for authentication and account management. Your notes live on your devices and in your own Google Drive backup archive; sync merges through that archive when backups run — it is not a real-time cloud database, and Noma has no server that sees your notes.

### AI (Opt-in)

- **Bring Your Own Key:** AI is off by default and entirely optional. Add your own API key to enable **Summarize** and **Suggest tags** on a note — one tap, one note, one call; nothing is ever sent automatically.
- **Providers:** Gemini, plus OpenAI-compatible providers — OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, or a custom endpoint. Each provider keeps its own key and model, stored only in a per-account on-device record — keys never appear in backups or sync. Locked, template, and trashed notes are excluded.

### Android

- **Native Mobile Integration:** Built with Capacitor 7 for native Android components and lifecycle handling.
- **Biometric Lock:** Hardware biometric authentication support (`BIOMETRIC_STRONG`).
- **Launcher Shortcuts:** Two static shortcuts — **New note** (`app.noma.notes://new-note`) and **Today** (`app.noma.notes://today`, opens today's daily note). Both wait behind App Lock like everything else.
- **Quick Capture Doors:** Android share target (text and images from any app), the home-screen widget (v2 shows Today plus recent note titles, privacy-gated), and a Quick Settings tile for capture from the QS panel.
- **Native Feel:** The system back button unwinds the app properly, note rows have swipe actions with undo, a small deliberate haptics vocabulary, a splash that hands off when the first frame paints, optional Material You dynamic colour (Android 12+), and edge-to-edge layout throughout.
- **SAF File Streaming:** Native Base64 chunked file streaming for Android Storage Access Framework exports.

### Web/PWA

- **Progressive Web App:** Offline accessibility powered by a Serwist service worker.
- **IndexedDB Persistence:** Local storage via Dexie.js.
- **Production Deployment:** Live web application deployed at [https://mynoma.vercel.app](https://mynoma.vercel.app).

### Settings

- **Eight Categories:** Settings opens on a list — Sync & backup, Security, Appearance, Writing, AI features, Data, Account, About — and every row shows its current state at a glance ("Connected · Scheduled · Daily", your theme's name, "App lock on · Encryption off").

### Contact & Feedback

Feedback, bug reports, and feature suggestions are welcome:

- **In-App Contact:** Access the Contact & Feedback view directly within Noma's settings menu to send feedback, report bugs, or request features.

---

## Privacy & Security

Noma prioritizes data privacy:

- **Local Data Primary Store:** Notes and attachments reside in your device's IndexedDB storage. Data leaves the device only where you point it: to your own Google Drive when backups/sync are on, and — only if you enable AI with your own key — the note text of the one note you tap, to the provider you chose.
- **App Lock vs Encryption:** App Lock acts as a local UI access control barrier (verifying password/pattern hashes locally and triggering biometric prompts). _App Lock does not provide encryption-at-rest._ Per-Note Lock does: a locked note's body and attachments are AES-256-GCM encrypted, with no recovery by design. Drive backups can likewise be sealed whole-archive with your passphrase.
- **Backup Security:** App Lock credential hashes are excluded from backup exports to ensure exported files do not contain authentication hashes.

---

## Technology Stack

| Category                   | Technology                                                                                                                |
| :------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| **Framework & UI**         | React 19, TypeScript, TanStack Start, TanStack Router                                                                     |
| **Styling**                | Tailwind CSS v4, Radix UI Primitives, Lucide Icons                                                                        |
| **Rich Text Editor**       | Tiptap Editor (`@tiptap/react`, StarterKit, Tables, Tasks, Highlights)                                                    |
| **Data & Charts**          | Recharts, Dexie.js (IndexedDB wrapper)                                                                                    |
| **PWA & Offline**          | Serwist (`@serwist/vite`, `@serwist/build`), Vite                                                                         |
| **Authentication & Cloud** | Firebase Auth, Google Identity Services, Google Drive API                                                                 |
| **Mobile Integration**     | Capacitor 7 (`@capacitor/core`, `@capacitor/android`), `@shardev/capacitor-google-auth`, `@capacitor/local-notifications` |

---

## Quick Start

### Prerequisites

- **Node.js:** Current LTS version recommended
- **npm** or **bun**

### Development Commands

1. **Clone the repository:**

   ```bash
   git clone https://github.com/jubayer00j/noma.git
   cd noma
   ```

2. **Install dependencies:**

   ```bash
   npm install
   ```

3. **Start local development server:**

   ```bash
   npm run dev
   ```

   _Access the application at `http://localhost:5173`._

4. **Production PWA Build:**

   ```bash
   npm run build
   ```

   _Executes `scripts/build-pwa.mjs` to generate the Vite client bundle and Serwist service worker._

5. **Vite Production Build:**

   ```bash
   npm run build:vite
   ```

6. **Lint Codebase:**

   ```bash
   npm run lint
   ```

7. **Format Codebase:**
   ```bash
   npm run format
   ```

---

## Android Development

The native Android project is managed using Capacitor 7 and located in the `android/` directory.

### Build Steps

1. **Sync Capacitor Web Assets:**

   ```bash
   npm run build
   npx cap sync android
   ```

2. **Compile Android Debug APK:**

   ```bash
   cd android
   ./gradlew assembleDebug
   ```

   _Output APK location: `android/app/build/outputs/apk/debug/app-debug.apk`._

3. **GitHub Actions CI:**
   Automated debug APK workflow is configured in `.github/workflows/android.yml`.

---

## Project Structure

```
noma/
├── android/                   # Capacitor 7 Android native project
│   ├── app/src/main/          # Java plugins, biometric auth, manifest, shortcuts
│   └── gradlew                # Gradle build script
├── public/                    # Static assets, icons, manifest
├── scripts/                   # Build scripts (e.g., build-pwa.mjs)
├── src/
│   ├── components/            # React UI components
│   │   ├── noma/              # Noma features (editor, charts, lock, reminders, drive)
│   │   └── ui/                # Radix UI primitives & components
│   ├── lib/
│   │   └── noma/              # Core logic (Dexie DB, App Lock, Auth, Drive, Backup, Shortcuts)
│   ├── routes/                # TanStack Router file-based routes
│   └── sw.ts                  # Serwist PWA service worker entrypoint
├── capacitor.config.ts        # Capacitor configuration
├── package.json               # Dependencies and scripts
├── vite.config.ts             # Vite configuration
└── README.md                  # Application documentation
```

---

## Contributing

Contributions are welcome! If you encounter an issue or wish to propose an enhancement:

1. Fork the repository (`https://github.com/jubayer00j/noma`).
2. Create a feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes (`git commit -m 'feat: add amazing feature'`).
4. Push to the branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request.

---

## Project Status

- **Web Application:** Production PWA live at [https://mynoma.vercel.app](https://mynoma.vercel.app).
- **Offline Storage:** Operating via IndexedDB storage and Serwist service worker caching.
- **Android Application:** Integrated native Android build using Capacitor 7 featuring local notifications, biometric App Lock, Storage Access Framework backups, and launcher shortcuts.

---

## License

Noma is released under the [MIT License](LICENSE).

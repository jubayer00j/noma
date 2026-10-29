import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  ChevronRight,
  CloudUpload,
  Database,
  Download,
  Info,
  Loader2,
  LogOut,
  Palette,
  ShieldCheck,
  Sparkles,
  Type,
  Upload,
  User,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AppGate } from "@/components/noma/app-gate";
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
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useSettings } from "@/hooks/use-noma";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { useAuth, friendlyAuthError } from "@/lib/noma/auth";
import { exportBackupAndroid } from "@/lib/noma/android-backup";
import {
  applyBackup,
  backupFileName,
  buildBackupZip,
  downloadBlob,
  readBackupZip,
  recordBackup,
  type BackupPayload,
} from "@/lib/noma/backup";
import { useDatabase } from "@/lib/noma/DatabaseContext";
import { BackupUnlockDialog } from "@/components/noma/backup-unlock-dialog";
import {
  BackupKeyNeededError,
  getBackupDeviceKey,
  getBackupEncryptionRecord,
} from "@/lib/noma/backup-crypto";
import { DriveCard } from "@/components/noma/drive-card";
import { ImportSection } from "@/components/noma/import-section";
import { AiSection } from "@/components/noma/ai-section";
import { AppLockSection } from "@/components/noma/app-lock-section";
import { BackupEncryptionSection } from "@/components/noma/backup-encryption-section";
import { ThemePicker, THEME_OPTIONS } from "@/components/noma/theme-picker";
import { isDynamicColorAvailable } from "@/lib/noma/dynamic-color";
import { getConnection } from "@/lib/noma/drive";
import { getAiSettings } from "@/lib/noma/ai";
import { registerSettingsBackHandler } from "@/lib/noma/system-back";
import {
  aboutSummary,
  accountSummary,
  aiSummary,
  appearanceSummary,
  dataSummary,
  securitySummary,
  syncSummary,
  writingSummary,
} from "@/lib/noma/settings-summary";
import { version as packageVersion } from "../../package.json";

export const Route = createFileRoute("/settings")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { screen?: SettingsScreen } => {
    const raw = search["screen"];
    return typeof raw === "string" &&
      ["sync", "security", "appearance", "writing", "ai", "data", "account", "about"].includes(raw)
      ? { screen: raw as SettingsScreen }
      : {};
  },
  head: () => ({
    links: [{ rel: "canonical", href: "https://mynoma.vercel.app/settings" }],
    meta: [
      { name: "robots", content: "noindex, nofollow" },
      { title: "Settings — Noma" },
      {
        name: "description",
        content: "Tune Noma's reading comfort, manage backups, and connect Google Drive.",
      },
    ],
  }),
  component: SettingsRoute,
});

function SettingsRoute() {
  const { screen } = Route.useSearch();
  return (
    <AppGate>
      <SettingsPage initialScreen={screen} />
    </AppGate>
  );
}

/**
 * Settings IA (restructure): a root list of categories — each row
 * showing its current state as a summary — over one sub-screen per
 * category, held as state in this route (no child routes: every
 * handler and the root dialogs already live here).
 *
 * All eight sub-screens stay MOUNTED, inactive ones hidden — exactly
 * the mount behaviour the old single-scroll page had. That matters:
 * DriveCard's mount-time wiring (including the "noma:encryption-
 * enabled" seal listener, see below) and every block's internal state
 * survive navigation untouched.
 */
export type SettingsScreen =
  "sync" | "security" | "appearance" | "writing" | "ai" | "data" | "account" | "about";

const SCREEN_TITLES: Record<SettingsScreen, string> = {
  sync: "Sync & backup",
  security: "Security",
  appearance: "Appearance",
  writing: "Writing",
  ai: "AI features",
  data: "Data",
  account: "Account",
  about: "About",
};

/** One icon per category, shown in the root rows and sub-screen headers. */
const SCREEN_ICONS: Record<SettingsScreen, LucideIcon> = {
  sync: CloudUpload,
  security: ShieldCheck,
  appearance: Palette,
  writing: Type,
  ai: Sparkles,
  data: Database,
  account: User,
  about: Info,
};

/** The root list's card grouping (redesign): category pairs, in order. */
const ROW_GROUPS: ReadonlyArray<ReadonlyArray<SettingsScreen>> = [
  ["sync", "security"],
  ["appearance", "writing"],
  ["ai", "data"],
  ["account", "about"],
];

export function SettingsPage({
  initialScreen,
}: { initialScreen?: SettingsScreen | undefined } = {}) {
  const { settings, update } = useSettings();
  const auth = useAuth();
  const { db } = useDatabase();
  const fileInput = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [screen, setScreen] = useState<SettingsScreen | null>(initialScreen ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<BackupPayload | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const unlockRetryRef = useRef<(() => void) | null>(null);
  const openUnlock = (retry: () => void) => {
    unlockRetryRef.current = retry;
    setUnlockOpen(true);
  };
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // Material You (native-feel #7): the wallpaper-colours row exists only
  // where the palette bridge reports available (Android 12+ app) — no
  // dead toggle on web or older Android.
  const dynamicColorAvailable = isDynamicColorAvailable();

  const backups = useLiveQuery(
    () => (db ? db.backups.orderBy("createdAt").reverse().limit(5).toArray() : []),
    [db],
    [],
  );
  const noteCount = useLiveQuery(
    () => (db ? db.notes.filter((n) => !n.deleted).count() : 0),
    [db],
    0,
  );

  // About: the native wrapper reports its own version on Android;
  // package.json is the web source of truth and the fallback.
  const [appVersion, setAppVersion] = useState(packageVersion);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    void CapacitorApp.getInfo()
      .then((info) => {
        if (!cancelled && info.version) setAppVersion(info.version);
      })
      .catch(() => {
        /* keep the package.json version */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hardware back: while a sub-screen is open, the system-back
  // coordinator's Settings step closes it back to the root list
  // (dialogs keep their higher overlay priority). See system-back.ts.
  useEffect(() => {
    if (screen === null) return;
    return registerSettingsBackHandler(() => {
      setScreen(null);
      return true;
    });
  }, [screen]);

  // Each screen opens at the top of the scroll container.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [screen]);

  const ownerId = auth.user?.uid ?? null;

  const rows: Array<{ id: SettingsScreen; title: string; summary: string; icon: LucideIcon }> = [
    {
      id: "sync",
      title: SCREEN_TITLES.sync,
      icon: SCREEN_ICONS.sync,
      summary: syncSummary({
        connected: getConnection(ownerId) !== null,
        backupMode: settings.backupMode,
        backupIntervalMinutes: settings.backupIntervalMinutes,
      }),
    },
    {
      id: "security",
      title: SCREEN_TITLES.security,
      icon: SCREEN_ICONS.security,
      summary: securitySummary({
        appLockEnabled: settings.appLockEnabled,
        encryptionEnabled: getBackupEncryptionRecord(ownerId) !== null,
      }),
    },
    {
      id: "appearance",
      title: SCREEN_TITLES.appearance,
      icon: SCREEN_ICONS.appearance,
      summary: appearanceSummary(settings.theme, THEME_OPTIONS),
    },
    {
      id: "writing",
      title: SCREEN_TITLES.writing,
      icon: SCREEN_ICONS.writing,
      summary: writingSummary({ fontSize: settings.fontSize, lineHeight: settings.lineHeight }),
    },
    {
      id: "ai",
      title: SCREEN_TITLES.ai,
      icon: SCREEN_ICONS.ai,
      summary: aiSummary({ hasKey: (getAiSettings(ownerId)?.apiKey.trim() ?? "") !== "" }),
    },
    {
      id: "data",
      title: SCREEN_TITLES.data,
      icon: SCREEN_ICONS.data,
      summary: dataSummary(noteCount),
    },
    {
      id: "account",
      title: SCREEN_TITLES.account,
      icon: SCREEN_ICONS.account,
      summary: accountSummary({ email: auth.email, signedIn: auth.user !== null }),
    },
    {
      id: "about",
      title: SCREEN_TITLES.about,
      icon: SCREEN_ICONS.about,
      summary: aboutSummary(appVersion),
    },
  ];

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const ScreenIcon = screen ? SCREEN_ICONS[screen] : null;

  async function handleExport() {
    setBusy("export");
    try {
      const { blob, payload } = await buildBackupZip(db!, auth.user?.uid ?? null);
      const filename = backupFileName();

      if (Capacitor.isNativePlatform()) {
        const result = await exportBackupAndroid(blob, filename);
        if (result.saved) {
          await recordBackup(db!, "local", "success", payload.notes.length);
          toast.success(`Backup saved to ${result.fullDisplayPath}`);
        } else {
          toast.error("Failed to save backup");
        }
      } else {
        downloadBlob(blob, filename);
        await recordBackup(db!, "local", "success", payload.notes.length);
        toast.success("Backup downloaded");
      }
    } catch (error) {
      if (error instanceof BackupKeyNeededError) {
        // Encryption is on but this device holds no key: unlock, then
        // retry the export (which seals the archive).
        openUnlock(() => void handleExport());
        return;
      }
      toast.error(error instanceof Error ? error.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleFile(file: File) {
    setBusy("import");
    try {
      setPendingImport(
        await readBackupZip(
          file,
          auth.user?.uid ?? null,
          getBackupDeviceKey(auth.user?.uid ?? null),
        ),
      );
    } catch (error) {
      if (error instanceof BackupKeyNeededError) {
        // Encrypted backup file, no key on this device: unlock, then
        // retry reading the same file.
        openUnlock(() => void handleFile(file));
        return;
      }
      toast.error(error instanceof Error ? error.message : "That file isn't a Noma backup.");
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function runImport(mode: "merge" | "replace") {
    if (!pendingImport) return;
    setBusy("import");
    try {
      await applyBackup(db!, pendingImport, mode);
      toast.success(
        mode === "merge" ? "Backup merged into your library" : "Library replaced from backup",
      );
      setPendingImport(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Restore failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={scrollRef} className="noma-scroll min-h-dvh overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 flex min-h-14 items-center gap-2 border-b border-border bg-background/90 px-4 pt-safe backdrop-blur sm:px-6">
        {screen === null ? (
          <>
            <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
              <Link to="/">
                <ArrowLeft className="size-4" /> Notes
              </Link>
            </Button>
            <h1 className="font-serif text-lg font-medium">Settings</h1>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              onClick={() => setScreen(null)}
            >
              <ArrowLeft className="size-4" /> Settings
            </Button>
            {ScreenIcon && (
              <span className="ml-1 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <ScreenIcon className="size-[18px]" aria-hidden="true" />
              </span>
            )}
            <h1 className="font-serif text-lg font-medium">{SCREEN_TITLES[screen]}</h1>
          </>
        )}
      </header>

      <div className="mx-auto max-w-2xl px-5 pb-20 sm:px-6">
        {/* Root: the category list, grouped into cards (redesign).
            Rows show current state as a summary beside the category's
            icon tile; the whole row is the tap target. */}
        <div data-screen="root" hidden={screen !== null} aria-hidden={screen !== null}>
          <div className="space-y-4 pt-6">
            {ROW_GROUPS.map((group) => (
              <section
                key={group.join("-")}
                className="overflow-hidden rounded-2xl border border-border bg-card"
              >
                <ul className="divide-y divide-border px-5">
                  {group.map((id) => {
                    const row = rowsById.get(id);
                    if (!row) return null;
                    const RowIcon = row.icon;
                    return (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => setScreen(row.id)}
                          className="-mx-5 flex w-[calc(100%+2.5rem)] items-center gap-4 px-5 py-[18px] text-left transition-colors hover:bg-accent/40 active:bg-accent/60"
                        >
                          <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            <RowIcon className="size-6" aria-hidden="true" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-[17px] font-semibold">{row.title}</span>
                            <span className="block truncate text-sm text-muted-foreground">
                              {row.summary}
                            </span>
                          </span>
                          <ChevronRight
                            className="size-5 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </div>

        {/* Sync & backup: Drive connection + mode (DriveCard), manual
            export, and the recent-backup history. Backup encryption
            moved to Security; its seal-on-enable still runs inside
            DriveCard via the "noma:encryption-enabled" event. */}
        <div data-screen="sync" hidden={screen !== "sync"} aria-hidden={screen !== "sync"}>
          <div className="space-y-5 py-8">
            <p className="text-sm text-muted-foreground">
              Optional, and independent from how you sign in to Noma. Connect Drive to keep your
              notes in sync across devices and backed up.
            </p>

            <DriveCard
              backupMode={settings.backupMode}
              backupIntervalMinutes={settings.backupIntervalMinutes}
              onBackupModeChange={(backupMode) =>
                void update({ backupMode, autoBackup: backupMode !== "off" })
              }
              onBackupIntervalChange={(backupIntervalMinutes) =>
                void update({ backupIntervalMinutes })
              }
            />

            <div className="space-y-3 border-t border-border pt-5">
              <p className="text-sm text-muted-foreground">
                Backups are ZIP files containing your notes (JSON) and attachments.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="gap-2"
                  disabled={busy === "export"}
                  onClick={handleExport}
                >
                  <Download className="size-4" />{" "}
                  {busy === "export" ? "Preparing…" : "Export backup"}
                </Button>
              </div>

              {backups.length > 0 && (
                <ul className="space-y-1.5 text-sm text-muted-foreground">
                  {backups.map((backup) => (
                    <li key={backup.id} className="flex justify-between gap-3">
                      <span>
                        {backup.source === "google-drive" ? "Google Drive" : "Local file"} ·{" "}
                        {backup.noteCount} note(s)
                        {backup.status === "failed" && " · failed"}
                      </span>
                      <span className="tabular-nums">
                        {new Date(backup.createdAt).toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>

        {/* Security: App Lock (the section keeps its own internal
            heading — it reads as a sub-heading here) and backup
            encryption, moved out of the Drive card. Enabling
            encryption announces itself so the Drive card can seal the
            current Drive backup immediately, as it did when the section
            was rendered inside it. */}
        <div
          data-screen="security"
          hidden={screen !== "security"}
          aria-hidden={screen !== "security"}
        >
          <AppLockSection />
          <BackupEncryptionSection
            ownerId={ownerId}
            onEncryptionEnabled={() => {
              window.dispatchEvent(new Event("noma:encryption-enabled"));
            }}
          />
        </div>

        {/* Appearance: theme, wallpaper colours, haptics. */}
        <div
          data-screen="appearance"
          hidden={screen !== "appearance"}
          aria-hidden={screen !== "appearance"}
        >
          <div className="space-y-5 py-8">
            <p className="text-sm text-muted-foreground">
              Noma remembers these on this device. Choose the atmosphere of Noma.
            </p>

            <div className="space-y-2.5">
              <Label className="text-sm font-medium">Theme</Label>
              <ThemePicker value={settings.theme} onChange={(theme) => void update({ theme })} />
            </div>

            {dynamicColorAvailable && (
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label className="text-base font-medium">Wallpaper colours (Material You)</Label>
                  <p className="text-xs text-muted-foreground">
                    Accent colours drawn from your wallpaper, in the Android app
                  </p>
                </div>
                <Switch
                  checked={settings.dynamicColorEnabled}
                  onCheckedChange={(checked) => void update({ dynamicColorEnabled: checked })}
                />
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label className="text-base font-medium">Haptic feedback</Label>
                <p className="text-xs text-muted-foreground">
                  Subtle vibration for swipes and unlock, in the Android app
                </p>
              </div>
              <Switch
                checked={settings.hapticsEnabled}
                onCheckedChange={(checked) => void update({ hapticsEnabled: checked })}
              />
            </div>
          </div>
        </div>

        {/* Writing: the reading/editor comfort sliders. */}
        <div data-screen="writing" hidden={screen !== "writing"} aria-hidden={screen !== "writing"}>
          <div className="space-y-5 py-8">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <Label>Font size</Label>
                <span className="text-muted-foreground tabular-nums">{settings.fontSize}px</span>
              </div>
              <Slider
                min={14}
                max={22}
                step={1}
                value={[settings.fontSize]}
                onValueChange={(value) => void update({ fontSize: value[0] ?? settings.fontSize })}
              />
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <Label>Line height</Label>
                <span className="text-muted-foreground tabular-nums">
                  {settings.lineHeight.toFixed(1)}
                </span>
              </div>
              <Slider
                min={1.4}
                max={2.2}
                step={0.1}
                value={[settings.lineHeight]}
                onValueChange={(value) =>
                  void update({ lineHeight: value[0] ?? settings.lineHeight })
                }
              />
            </div>

            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <Label>Editor width</Label>
                <span className="text-muted-foreground tabular-nums">{settings.editorWidth}px</span>
              </div>
              <Slider
                min={560}
                max={960}
                step={20}
                value={[settings.editorWidth]}
                onValueChange={(value) =>
                  void update({ editorWidth: value[0] ?? settings.editorWidth })
                }
              />
            </div>
          </div>
        </div>

        {/* AI features. */}
        <div data-screen="ai" hidden={screen !== "ai"} aria-hidden={screen !== "ai"}>
          <div className="space-y-5 py-8">
            <p className="text-sm text-muted-foreground">
              Optional. Bring your own key for note summaries, tag suggestions, semantic search and
              Ask Noma — only ever when you tap.
            </p>
            <AiSection ownerId={ownerId} db={db} />
          </div>
        </div>

        {/* Data: restore from a backup file, and the importers. */}
        <div data-screen="data" hidden={screen !== "data"} aria-hidden={screen !== "data"}>
          <div className="space-y-5 py-8">
            <p className="text-sm text-muted-foreground">
              {noteCount} note(s) stored on this device.
            </p>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="gap-2"
                disabled={busy === "import"}
                onClick={() => fileInput.current?.click()}
              >
                <Upload className="size-4" /> Restore from file
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
            </div>

            {db && <ImportSection db={db} ownerId={ownerId} />}
          </div>
        </div>

        {/* Account. */}
        <div data-screen="account" hidden={screen !== "account"} aria-hidden={screen !== "account"}>
          <div className="space-y-5 py-8">
            <p className="text-sm text-muted-foreground">
              Your Noma identity is separate from this device's notes and from Google Drive backup.
            </p>

            {!auth.configured ? (
              <div className="rounded-2xl border border-border bg-card p-4 text-sm">
                <p className="font-medium">Authentication isn't configured</p>
                <p className="mt-1 text-muted-foreground">
                  Paste your six Firebase Web App values into{" "}
                  <code className="font-mono text-xs">src/config/firebaseConfig.ts</code> to enable
                  Noma accounts. Your notes keep working on this device in the meantime.
                </p>
              </div>
            ) : auth.user ? (
              <div className="space-y-4">
                <div className="space-y-1 text-sm">
                  <p className="font-medium">{auth.email ?? "Signed in"}</p>
                  <p className="text-muted-foreground">
                    Sign-in methods:{" "}
                    {auth.providers
                      .map((id) =>
                        id === "google.com"
                          ? "Google"
                          : id === "password"
                            ? "Email & password"
                            : id,
                      )
                      .join(", ") || "—"}
                  </p>
                  <p className="text-muted-foreground">
                    {auth.googleLinked ? "Google account connected ✓" : "Google account not linked"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={busy === "link"}
                    onClick={async () => {
                      setBusy("link");
                      try {
                        if (auth.googleLinked) {
                          await auth.unlinkGoogle();
                          toast.success("Google account unlinked.");
                        } else {
                          await auth.linkGoogle();
                          toast.success("Google account connected.");
                        }
                      } catch (error) {
                        toast.error(friendlyAuthError(error));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === "link" && (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    )}
                    {busy === "link"
                      ? auth.googleLinked
                        ? "Unlinking…"
                        : "Connecting…"
                      : auth.googleLinked
                        ? "Unlink Google"
                        : "Connect Google Account"}
                  </Button>
                  <Button
                    variant="ghost"
                    className="gap-2 transition-transform active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100"
                    disabled={busy === "signout"}
                    onClick={() => setConfirmSignOut(true)}
                  >
                    {busy === "signout" ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <LogOut className="size-4" aria-hidden="true" />
                    )}
                    {busy === "signout" ? "Signing out…" : "Sign out"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Linking adds a second way into this same Noma account — it never creates a new
                  one. Google Drive backup is authorized separately under Sync &amp; backup.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  You're in Local Mode — notes, folders, tags and settings live in this browser
                  only. An account is optional; signing in never deletes or overwrites what's
                  already here.
                </p>
                <Button asChild variant="outline" className="gap-2">
                  <Link to="/signin">Sign in or create an account</Link>
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* About. */}
        <div data-screen="about" hidden={screen !== "about"} aria-hidden={screen !== "about"}>
          <div className="space-y-3 py-8 text-sm">
            <p className="font-medium">Noma {aboutSummary(appVersion)}</p>
            <p className="text-muted-foreground">{dataSummary(noteCount)}</p>
            <p className="text-muted-foreground">
              Noma is local-first — your notes live on this device, and they only leave it when you
              back them up or sync them yourself.
            </p>
          </div>
        </div>
      </div>

      <BackupUnlockDialog
        open={unlockOpen}
        onOpenChange={setUnlockOpen}
        ownerId={auth.user?.uid ?? null}
        onUnlocked={() => {
          const retry = unlockRetryRef.current;
          unlockRetryRef.current = null;
          retry?.();
        }}
      />

      <AlertDialog open={confirmSignOut} onOpenChange={setConfirmSignOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif">Sign out of Noma?</AlertDialogTitle>
            <AlertDialogDescription>
              Your notes will remain safely stored on this device, but they will be hidden until you
              sign back in. Noma will switch to Local Mode.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay signed in</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "signout"}
              onClick={async () => {
                setBusy("signout");
                setConfirmSignOut(false);
                try {
                  // Brief, intentional beat before the screen crossfades back to auth.
                  await new Promise((resolve) => setTimeout(resolve, 220));
                  await auth.signOut();
                  toast.success("Signed out — Noma is in Local Mode.");
                  setBusy(null);
                } catch (error) {
                  toast.error(friendlyAuthError(error));
                  setBusy(null);
                }
              }}
            >
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(pendingImport)}
        onOpenChange={(open) => !open && setPendingImport(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="font-serif">Restore this backup?</AlertDialogTitle>
            <AlertDialogDescription>
              The backup holds {pendingImport?.notes.length ?? 0} note(s). Merge keeps your current
              notes and adds anything newer. Replace deletes everything on this device first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              disabled={busy === "import"}
              onClick={() => void runImport("merge")}
            >
              Merge
            </Button>
            <AlertDialogAction
              disabled={busy === "import"}
              onClick={() => void runImport("replace")}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

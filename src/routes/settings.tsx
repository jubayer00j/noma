import { createFileRoute, Link } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowLeft, Download, Loader2, LogOut, Upload } from "lucide-react";
import { useRef, useState } from "react";
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
import { BackupKeyNeededError, getBackupDeviceKey } from "@/lib/noma/backup-crypto";
import { DriveCard } from "@/components/noma/drive-card";
import { AppLockSection } from "@/components/noma/app-lock-section";
import { ThemePicker } from "@/components/noma/theme-picker";

export const Route = createFileRoute("/settings")({
  ssr: false,
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
  component: () => (
    <AppGate>
      <SettingsPage />
    </AppGate>
  ),
});

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="noma-leaf-divider border-b border-border py-8 last:border-0">
      <h2 className="font-serif text-xl font-medium">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

function SettingsPage() {
  const { settings, update } = useSettings();
  const auth = useAuth();
  const { db } = useDatabase();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<BackupPayload | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const unlockRetryRef = useRef<(() => void) | null>(null);
  const openUnlock = (retry: () => void) => {
    unlockRetryRef.current = retry;
    setUnlockOpen(true);
  };
  const [confirmSignOut, setConfirmSignOut] = useState(false);

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
        await readBackupZip(file, auth.user?.uid ?? null, getBackupDeviceKey(auth.user?.uid ?? null)),
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
    <div className="noma-scroll min-h-dvh overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur sm:px-6">
        <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
          <Link to="/">
            <ArrowLeft className="size-4" /> Notes
          </Link>
        </Button>
        <h1 className="font-serif text-lg font-medium">Settings</h1>
      </header>

      <div className="mx-auto max-w-2xl px-5 pb-20 sm:px-6">
        <AppLockSection />

        <Section
          title="Appearance"
          description="Noma remembers these on this device. Choose the atmosphere of Noma."
        >
          <div className="space-y-2.5">
            <Label className="text-sm font-medium">Theme</Label>
            <ThemePicker value={settings.theme} onChange={(theme) => void update({ theme })} />
          </div>

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
        </Section>

        <Section
          title="Backup & restore"
          description={`${noteCount} note(s) stored on this device. Backups are ZIP files containing JSON, Markdown and attachments.`}
        >
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="gap-2"
              disabled={busy === "export"}
              onClick={handleExport}
            >
              <Download className="size-4" /> {busy === "export" ? "Preparing…" : "Export backup"}
            </Button>
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
        </Section>

        <Section
          title="Google Drive"
          description="Optional, and independent from how you sign in to Noma. Connect Drive to keep your notes in sync across devices and backed up."
        >
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
        </Section>

        <Section
          title="Account"
          description="Your Noma identity is separate from this device's notes and from Google Drive backup."
        >
          {!auth.configured ? (
            <div className="rounded-lg border border-border bg-card p-4 text-sm">
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
                      id === "google.com" ? "Google" : id === "password" ? "Email & password" : id,
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
                Linking adds a second way into this same Noma account — it never creates a new one.
                Google Drive backup is authorized separately above.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                You're in Local Mode — notes, folders, tags and settings live in this browser only.
                An account is optional; signing in never deletes or overwrites what's already here.
              </p>
              <Button asChild variant="outline" className="gap-2">
                <Link to="/signin">Sign in or create an account</Link>
              </Button>
            </div>
          )}
        </Section>
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

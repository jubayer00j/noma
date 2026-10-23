import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  HardDrive,
  Loader2,
  LogOut,
  Mail,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AppGate } from "@/components/noma/app-gate";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSettings } from "@/hooks/use-noma";
import { friendlyAuthError, useAuth } from "@/lib/noma/auth";

export const Route = createFileRoute("/account")({
  ssr: false,
  head: () => ({
    links: [{ rel: "canonical", href: "https://mynoma.vercel.app/account" }],
    meta: [
      { name: "robots", content: "noindex, nofollow" },
      { title: "Account — Noma" },
      {
        name: "description",
        content: "Manage your local Noma profile and view account details.",
      },
    ],
  }),
  component: () => (
    <AppGate>
      <AccountPage />
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
    <section className="border-b border-border py-8 last:border-0">
      <h2 className="font-serif text-xl font-medium">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-5 space-y-5">{children}</div>
    </section>
  );
}

function getInitials(name: string, email?: string | null): string {
  const trimmed = name.trim();
  if (trimmed) {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const first = parts[0];
    const last = parts[parts.length - 1];
    if (parts.length >= 2 && first && last && first[0] && last[0]) {
      return (first[0] + last[0]).toUpperCase();
    }
    if (first) {
      return first.slice(0, 2).toUpperCase();
    }
  }
  if (email) {
    const localPart = email.split("@")[0] ?? "";
    const clean = localPart.replace(/[^a-zA-Z0-9]/g, "");
    if (clean.length >= 2) return clean.slice(0, 2).toUpperCase();
    if (clean.length === 1) return clean.toUpperCase();
  }
  return "N";
}

function formatCreationTime(creationTime?: string): string {
  if (!creationTime) return "—";
  try {
    const date = new Date(creationTime);
    if (isNaN(date.getTime())) return "—";
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function AccountPage() {
  const auth = useAuth();
  const { settings, update } = useSettings();
  const navigate = useNavigate();

  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Sync state for name input to avoid resetting caret while typing
  const [nameInput, setNameInput] = useState(settings.displayName ?? "");

  useEffect(() => {
    setNameInput(settings.displayName ?? "");
  }, [settings.displayName]);

  // Protect route for signed-in users only
  useEffect(() => {
    if (!auth.loading && !auth.user) {
      void navigate({ to: "/signin", replace: true });
    }
  }, [auth.loading, auth.user, navigate]);

  if (auth.loading || !auth.user) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground animate-pulse motion-reduce:animate-none">
          Loading account…
        </p>
      </div>
    );
  }

  const initials = getInitials(settings.displayName, auth.email);

  const providerSummary = auth.providers.length
    ? auth.providers
        .map((p) => (p === "google.com" ? "Google" : p === "password" ? "Email & password" : p))
        .join(", ")
    : "—";

  return (
    <div className="noma-scroll min-h-dvh overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 flex min-h-14 items-center gap-2 border-b border-border bg-background/90 px-4 pt-safe backdrop-blur sm:px-6">
        <Button asChild variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
          <Link to="/">
            <ArrowLeft className="size-4" /> Notes
          </Link>
        </Button>
        <h1 className="font-serif text-lg font-medium">Account</h1>
      </header>

      <div className="mx-auto max-w-2xl px-5 pb-20 sm:px-6">
        <div className="flex items-center gap-4 border-b border-border py-8">
          <Avatar className="size-16 shrink-0 border border-border">
            <AvatarFallback className="bg-primary/10 font-serif text-xl font-semibold text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-serif text-2xl font-semibold tracking-tight">
              {settings.displayName.trim() || auth.email || "Noma User"}
            </h2>
            <p className="truncate text-sm text-muted-foreground">{auth.email ?? "Signed in"}</p>
          </div>
        </div>

        <Section title="Personal information" description="Your local profile information.">
          <div className="space-y-2">
            <Label htmlFor="display-name">Name</Label>
            <Input
              id="display-name"
              type="text"
              placeholder="Enter your name"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={() => void update({ displayName: nameInput })}
              className="max-w-md"
            />
            <p className="text-xs text-muted-foreground">
              Your name is stored only on this device.
            </p>
          </div>
        </Section>

        <Section title="Account" description="Read-only details from your authentication account.">
          <div className="space-y-4 text-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 sm:gap-4 rounded-lg border border-border bg-card p-3.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <Mail className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium truncate">{auth.email ?? "No email address"}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {auth.user.emailVerified ? (
                  <Badge
                    variant="outline"
                    className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 gap-1.5"
                  >
                    <CheckCircle2 className="size-3.5" /> Verified
                  </Badge>
                ) : (
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 gap-1.5"
                    >
                      <AlertCircle className="size-3.5" /> Email not verified
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs gap-1 px-2"
                      disabled={busy === "verify"}
                      onClick={async () => {
                        setBusy("verify");
                        try {
                          const isVerified = await auth.refreshUser();
                          if (isVerified) {
                            toast.success("Email verified ✓");
                          } else {
                            await auth.sendVerification();
                            toast.success("Verification link sent to your email.");
                          }
                        } catch (err) {
                          toast.error(friendlyAuthError(err));
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      {busy === "verify" ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3" />
                      )}
                      Resend
                    </Button>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-3.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">Sign-in method</span>
              </div>
              <span className="font-medium text-foreground truncate">{providerSummary}</span>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-3.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <Calendar className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">Member since</span>
              </div>
              <span className="font-medium text-foreground tabular-nums">
                {formatCreationTime(auth.user.metadata.creationTime)}
              </span>
            </div>
          </div>
        </Section>

        <Section title="Your data" description="Local-first storage architecture.">
          <div className="rounded-lg border border-border bg-card p-4 space-y-2">
            <div className="flex items-center gap-2.5 text-sm font-medium">
              <HardDrive className="size-4 text-muted-foreground shrink-0" />
              <span>Local Storage</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Your notes and preferences are stored locally on this device. Optional Google Drive
              backups are separate.
            </p>
          </div>
        </Section>

        <Section title="Sign out">
          <Button
            variant="outline"
            className="gap-2 text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
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
        </Section>
      </div>

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
                  await new Promise((resolve) => setTimeout(resolve, 220));
                  await auth.signOut();
                  toast.success("Signed out — Noma is in Local Mode.");
                  setBusy(null);
                  void navigate({ to: "/signin", replace: true });
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
    </div>
  );
}

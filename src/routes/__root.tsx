import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider } from "@/lib/noma/auth";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/noma/theme";
import { PWAReloadPrompt } from "@/components/noma/pwa-reload-prompt";

import { DatabaseProvider, useDatabase } from "@/lib/noma/DatabaseContext";
import { AppLockProvider, useAppLock } from "@/lib/noma/AppLockContext";
import { ShortcutListener } from "@/lib/noma/shortcut";
import { SystemBackMount } from "@/components/noma/system-back-mount";
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

function GuestMigrationDialog() {
  const { guestMigrationPending, migrateGuestData, skipGuestData } = useDatabase();
  const { isLocked, isLockStateResolving } = useAppLock();

  if (isLockStateResolving || isLocked) {
    return null;
  }

  return (
    <AlertDialog open={guestMigrationPending}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-serif">Migrate local notes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have notes created in Local Mode. Would you like to move them into this account, or
            start fresh? Starting fresh will hide the local notes until you sign out again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => void skipGuestData()}>Start fresh</AlertDialogCancel>
          <AlertDialogAction onClick={() => void migrateGuestData()}>Move notes</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <meta name="robots" content="noindex, nofollow" />
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content:
          "width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
      },
      { title: "Noma — Calm, offline-first notes" },
      {
        name: "description",
        content:
          "A minimalist note-taking app that works offline and keeps your notes on your device.",
      },
      { property: "og:site_name", content: "Noma" },
      { property: "og:title", content: "Noma — Calm, offline-first notes" },
      {
        property: "og:description",
        content:
          "A minimalist note-taking app that works offline and keeps your notes on your device.",
      },
      { property: "og:type", content: "website" },
      { property: "og:image", content: "https://mynoma.vercel.app/noma-icon-512.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Noma — Calm, offline-first notes" },
      {
        name: "twitter:description",
        content:
          "A minimalist note-taking app that works offline and keeps your notes on your device.",
      },
      { name: "twitter:image", content: "https://mynoma.vercel.app/noma-icon-512.png" },
      { name: "theme-color", content: "#0B0F1A" },
    ],
    links: [
      { rel: "manifest", href: "/manifest.json" },
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&display=swap",
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
      { rel: "icon", href: "/noma-icon-32.png", type: "image/png", sizes: "32x32" },
      { rel: "icon", href: "/noma-icon-192.png", type: "image/png", sizes: "192x192" },
      { rel: "icon", href: "/noma-icon-512.png", type: "image/png", sizes: "512x512" },
      { rel: "apple-touch-icon", href: "/noma-icon-180.png", sizes: "180x180" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* Applies the saved Light/Dark/System choice before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <DatabaseProvider>
          <AppLockProvider>
            <ShortcutListener>
              <SystemBackMount />
              {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
              <Outlet />
              <GuestMigrationDialog />
              <Toaster position="bottom-center" />
              <PWAReloadPrompt />
            </ShortcutListener>
          </AppLockProvider>
        </DatabaseProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

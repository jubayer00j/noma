import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { AppGate } from "@/components/noma/app-gate";
import { Workspace } from "@/components/noma/workspace";

const webAppSchema = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Noma",
  url: "https://mynoma.vercel.app/",
  applicationCategory: "ProductivityApplication",
  operatingSystem: "All",
  description:
    "Minimalist, calm, offline-first note-taking application that stores notes locally on your device with optional Google Drive backup.",
  browserRequirements: "Requires JavaScript. Requires HTML5 IndexedDB storage support.",
};

export const Route = createFileRoute("/")({
  head: () => ({
    links: [{ rel: "canonical", href: "https://mynoma.vercel.app/" }],
    meta: [
      { title: "Noma — Calm, offline-first notes" },
      {
        name: "google-site-verification",
        content: "U660QQLDolSQycHbWAB6kFS3YhlWHOocQhJMvWyE2w0",
      },
      {
        name: "description",
        content:
          "Noma is a minimalist note-taking app that works fully offline, stores notes on your device, and backs up to Google Drive.",
      },
      { property: "og:site_name", content: "Noma" },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://mynoma.vercel.app/" },
      { property: "og:title", content: "Noma — Calm, offline-first notes" },
      {
        property: "og:description",
        content:
          "Write without distraction. Notes live on your device and sync to backups when you choose.",
      },
      { property: "og:image", content: "https://mynoma.vercel.app/noma-icon-512.png" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Noma — Calm, offline-first notes" },
      {
        name: "twitter:description",
        content:
          "Write without distraction. Notes live on your device and sync to backups when you choose.",
      },
      { name: "twitter:image", content: "https://mynoma.vercel.app/noma-icon-512.png" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(webAppSchema),
      },
    ],
  }),
  component: Index,
});

function Index() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // On Native Capacitor (Android), directly bypass the marketing page to AppGate/Workspace.
  // On public Web, SSR initially renders the marketing/SEO page before React hydration.
  if (!mounted && !Capacitor.isNativePlatform()) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-4xl flex-col px-6 py-12 bg-background text-foreground">
        <header className="border-b border-border pb-6">
          <h1 className="font-serif text-3xl font-bold tracking-tight sm:text-4xl">
            Noma — Calm, offline-first notes
          </h1>
          <p className="mt-3 text-base text-muted-foreground leading-relaxed sm:text-lg">
            Write without distraction. Noma is a minimalist note-taking application that keeps your
            notes stored securely on your device with optional Google Drive backup.
          </p>
        </header>

        <section className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div className="rounded-lg border border-border p-5">
            <h2 className="font-serif text-lg font-semibold">Local-First Storage</h2>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
              Your notes are stored directly in your browser using IndexedDB. No server tracking, no
              cloud dependency required.
            </p>
          </div>

          <div className="rounded-lg border border-border p-5">
            <h2 className="font-serif text-lg font-semibold">Full Offline Access</h2>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
              Noma works seamlessly offline as a Progressive Web App (PWA) and native Android
              application.
            </p>
          </div>

          <div className="rounded-lg border border-border p-5">
            <h2 className="font-serif text-lg font-semibold">Rich Formatting & Charts</h2>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
              Organize notes with folders, tags, rich text, tables, checklists, local reminders, and
              interactive offline chart blocks.
            </p>
          </div>

          <div className="rounded-lg border border-border p-5">
            <h2 className="font-serif text-lg font-semibold">Google Drive & ZIP Backups</h2>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
              Safely export portable ZIP backups or sync encrypted backups directly to your Google
              Drive account when you choose.
            </p>
          </div>
        </section>

        <footer className="mt-12 flex items-center justify-between border-t border-border/60 pt-6 text-xs text-muted-foreground">
          <span>Noma v1.2.0 • Calm, offline-first notes</span>
          <a href="/contact" className="hover:text-foreground underline">
            Contact & Feedback
          </a>
        </footer>
      </main>
    );
  }

  return (
    <AppGate>
      <Workspace />
    </AppGate>
  );
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { storePendingWebShare } from "@/lib/noma/share-target";

/**
 * Landing route for the Web Share Target (manifest.json `share_target`).
 * The browser delivers shared title/text/url here as GET params; the
 * payload is parked in sessionStorage and the user is sent straight to
 * the workspace, whose capture queue turns it into a note once the
 * database and App Lock gate allow. This page itself renders nothing.
 */
export const Route = createFileRoute("/share-target")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>) => ({
    title: typeof search["title"] === "string" ? search["title"] : undefined,
    text: typeof search["text"] === "string" ? search["text"] : undefined,
    url: typeof search["url"] === "string" ? search["url"] : undefined,
  }),
  head: () => ({
    meta: [
      { name: "robots", content: "noindex, nofollow" },
      { title: "Sharing to Noma" },
    ],
  }),
  component: ShareTargetPage,
});

function ShareTargetPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();

  useEffect(() => {
    storePendingWebShare({
      title: search.title ?? null,
      text: search.text ?? null,
      url: search.url ?? null,
    });
    void navigate({ to: "/", replace: true });
  }, [search, navigate]);

  return null;
}

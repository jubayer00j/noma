import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppGate } from "@/components/noma/app-gate";
import { AuthScreen } from "@/components/noma/auth-screen";
import { BootScreen } from "@/components/noma/boot-screen";
import { useAuth } from "@/lib/noma/auth";

export const Route = createFileRoute("/signin")({
  ssr: false,
  head: () => ({
    links: [{ rel: "canonical", href: "https://mynoma.vercel.app/signin" }],
    meta: [
      { name: "robots", content: "noindex, nofollow" },
      { title: "Sign in — Noma" },
      {
        name: "description",
        content:
          "Sign in to your Noma account with Google or email, or keep writing without an account in Local Mode.",
      },
    ],
  }),
  component: SignInPage,
});

function SignInPage() {
  const auth = useAuth();
  const navigate = useNavigate();

  // Signing in (or linking) drops you straight back into your notes.
  useEffect(() => {
    if (auth.user && !auth.needsEmailVerification) void navigate({ to: "/", replace: true });
  }, [auth.user, auth.needsEmailVerification, navigate]);

  if (auth.user) {
    return (
      <AppGate>
        <BootScreen />
      </AppGate>
    );
  }

  return <AuthScreen onContinueWithoutAccount={() => void navigate({ to: "/", replace: true })} />;
}

import { Capacitor } from "@capacitor/core";
import { GoogleAuth } from "@shardev/capacitor-google-auth";

import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut as fbSignOut,
  sendPasswordResetEmail,
  sendEmailVerification,
  onAuthStateChanged,
  linkWithPopup,
  linkWithRedirect,
  linkWithCredential,
  unlink,
  reload,
  GoogleAuthProvider,
  signInWithCredential,
  type User,
} from "firebase/auth";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getFirebaseAuth, isFirebaseConfigured } from "../firebase";

export interface NomaAuth {
  mode: "firebase" | "local";
  configured: boolean;
  loading: boolean;
  user: User | null;
  email: string | null;
  providers: string[];
  googleLinked: boolean;
  /** True when the account signs in with a password and the email is still unverified. */
  needsEmailVerification: boolean;
  signUp: (email: string, password: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  sendVerification: () => Promise<void>;
  refreshUser: () => Promise<boolean>;
  signOut: () => Promise<void>;
  linkGoogle: () => Promise<void>;
  unlinkGoogle: () => Promise<void>;
}

const AuthContext = createContext<NomaAuth | null>(null);

export function friendlyAuthError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code ?? "";
  // Keep full diagnostics in the console — never swallow the original error.
  if (error) console.error("[noma-auth]", code || "no-code", error);
  switch (code) {
    case "auth/invalid-email":
      return "That email address doesn't look right.";
    case "auth/missing-password":
      return "Please enter your password.";
    case "auth/weak-password":
      return "Choose a password with at least 6 characters.";
    case "auth/email-already-in-use":
      return "An account already exists with this email. Try signing in instead.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Email or password is incorrect.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "The Google window was closed before finishing.";
    case "auth/unauthorized-domain":
      return `This site's domain (${typeof window === "undefined" ? "unknown" : window.location.hostname}) isn't authorized in Firebase Authentication. Add this exact hostname under Firebase console → Authentication → Settings → Authorized domains.`;
    case "auth/operation-not-allowed":
      return "Google sign-in is disabled for this Firebase project. Enable the Google provider under Firebase console → Authentication → Sign-in method.";
    case "auth/missing-initial-state":
      return "Your browser blocked the sign-in state from returning to Noma. Try Continue with Google again — it will now open a window instead of redirecting.";
    case "auth/popup-blocked":
      return "Your browser blocked the Google sign-in window. Allow popups for this site, then try again.";
    case "auth/operation-not-supported-in-this-environment":
      return "This browser blocked the Google sign-in window. Retrying with a full-page redirect…";
    case "auth/credential-already-in-use":
    case "auth/account-exists-with-different-credential":
      return "This Google account is already connected to a different Noma account. Sign in to that account, or unlink Google there first — Noma will not merge two accounts automatically.";
    case "auth/requires-recent-login":
      return "For security, please sign in again before changing linked accounts.";
    case "auth/network-request-failed":
      return "You appear to be offline. Your notes still work — try again when you're connected.";
    default:
      return (
        (error as Error)?.message?.replace(/^Firebase:\s*/, "") ||
        "Something went wrong. Please try again."
      );
  }
}

const REDIRECT_FALLBACK_CODES = new Set([
  "auth/popup-blocked",
  "auth/popup-closed-by-user",
  "auth/cancelled-popup-request",
  "auth/operation-not-supported-in-this-environment",
  "auth/web-storage-unsupported",
  "auth/internal-error",
]);

function googleProvider() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  return provider;
}

/**
 * Popup-first everywhere.
 *
 * On a custom production domain (e.g. mynoma.vercel.app) the Firebase
 * `authDomain` (*.firebaseapp.com) is a THIRD-PARTY origin, so browser storage
 * partitioning (Safari ITP, Chrome third-party cookie phase-out) breaks
 * `signInWithRedirect` — it returns to the app with
 * `auth/missing-initial-state` or with no user at all, which is exactly the
 * "email works, Google doesn't, only in production" symptom. Popups keep the
 * sign-in state in the opener, so they survive partitioning; redirect stays as
 * a fallback for browsers that block popups outright, and inside embedded
 * frames a redirect would navigate the host page, so popup is mandatory there.
 */
function canRedirect(): boolean {
  if (typeof window === "undefined") return false;
  return window.top === window.self;
}

let _googleAuthInitialized = false;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(isFirebaseConfigured);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const auth = getFirebaseAuth();
    if (!auth) {
      setLoading(false);
      return;
    }
    // Completes a redirect-based Google sign-in (mobile-friendly path).
    void getRedirectResult(auth).catch((error) => {
      console.error("[noma-auth] google redirect result failed", error);
    });
    return onAuthStateChanged(auth, (next) => {
      setUser(next);
      setLoading(false);
    });
  }, []);

  const value = useMemo<NomaAuth>(() => {
    const requireAuth = () => {
      const auth = getFirebaseAuth();
      if (!auth) throw new Error("Noma authentication isn't configured yet.");
      return auth;
    };
    const providers = user?.providerData.map((p) => p.providerId) ?? [];
    const passwordOnly = providers.includes("password") && !providers.includes("google.com");

    return {
      mode: isFirebaseConfigured ? "firebase" : "local",
      configured: isFirebaseConfigured,
      loading,
      user,
      email: user?.email ?? null,
      providers,
      googleLinked: providers.includes("google.com"),
      needsEmailVerification: Boolean(user) && passwordOnly && !user?.emailVerified,
      signUp: async (email, password) => {
        const credential = await createUserWithEmailAndPassword(
          requireAuth(),
          email.trim(),
          password,
        );
        await sendEmailVerification(credential.user, { url: window.location.origin });
      },
      signIn: async (email, password) => {
        await signInWithEmailAndPassword(requireAuth(), email.trim(), password);
      },
      signInWithGoogle: async () => {
        const auth = requireAuth();
        if (Capacitor.isNativePlatform()) {
          // A native Android Google sign-in flow that obtains a Google credential and signs
          // into the existing Firebase Auth instance using that credential.
          // This avoids the WebView/browser boundary entirely, ensuring robust session state.
          try {
            const { firebaseWebClientId } = await import("@/config/firebaseConfig");
            if (!firebaseWebClientId) {
              throw new Error(
                "Missing Firebase Web Client ID. Please configure it in src/config/firebaseConfig.ts",
              );
            }

            if (!_googleAuthInitialized) {
              await GoogleAuth.initialize({
                clientId: firebaseWebClientId,
                serverClientId: firebaseWebClientId,
                scopes: ["profile", "email"],
              });
              _googleAuthInitialized = true;
            }
            const result = await GoogleAuth.login();
            const idToken = result.idToken;
            if (!idToken) throw new Error("No ID token returned from Google Sign-In");
            const credential = GoogleAuthProvider.credential(idToken);
            await signInWithCredential(auth, credential);
          } catch (e) {
            console.error("Native Google Sign In Error:", e);
            throw e;
          }
          return;
        }

        try {
          await signInWithPopup(auth, googleProvider());
        } catch (error) {
          const code = (error as { code?: string }).code ?? "";
          console.error(
            "[noma-auth] google popup failed",
            code,
            "host:",
            window.location.hostname,
            error,
          );
          if (!REDIRECT_FALLBACK_CODES.has(code) || !canRedirect()) throw error;
          await signInWithRedirect(auth, googleProvider());
        }
      },

      resetPassword: async (email) => {
        await sendPasswordResetEmail(requireAuth(), email.trim());
      },
      sendVerification: async () => {
        const current = requireAuth().currentUser;
        if (!current) throw new Error("You need to be signed in to resend verification.");
        await sendEmailVerification(current, { url: window.location.origin });
      },
      refreshUser: async () => {
        const current = requireAuth().currentUser;
        if (!current) return false;
        await reload(current);
        const reloaded = requireAuth().currentUser;
        if (reloaded) {
          setUser({ ...reloaded } as User);
        } else {
          setUser(null);
        }
        return Boolean(reloaded?.emailVerified);
      },
      signOut: async () => {
        const current = requireAuth().currentUser;
        if (current) {
          const { disconnectDrive } = await import("./drive");
          await disconnectDrive(current.uid);
          // The widget's staged snapshot belongs to this account: clear
          // it on sign-out (native-feel #10), in the same pass that
          // clears the Drive/AI device records — a different account
          // signing in later never inherits these titles on the home
          // screen. Fire-and-forget and failure-proof inside the module.
          const { clearWidgetSnapshot } = await import("./widget-snapshot");
          clearWidgetSnapshot();
        }
        await fbSignOut(requireAuth());
      },
      linkGoogle: async () => {
        const auth = requireAuth();
        const current = auth.currentUser;
        if (!current) throw new Error("You need to be signed in to link Google.");
        // Provider linking keeps ONE Noma account with two sign-in methods.
        if (Capacitor.isNativePlatform()) {
          try {
            const { firebaseWebClientId } = await import("@/config/firebaseConfig");
            if (!firebaseWebClientId) {
              throw new Error(
                "Missing Firebase Web Client ID. Please configure it in src/config/firebaseConfig.ts",
              );
            }

            if (!_googleAuthInitialized) {
              await GoogleAuth.initialize({
                clientId: firebaseWebClientId,
                serverClientId: firebaseWebClientId,
                scopes: ["profile", "email"],
              });
              _googleAuthInitialized = true;
            }
            const result = await GoogleAuth.login();
            const idToken = result.idToken;
            if (!idToken) throw new Error("No ID token returned from Google Sign-In");
            const credential = GoogleAuthProvider.credential(idToken);
            await linkWithCredential(current, credential);
            setUser({ ...requireAuth().currentUser } as User);
          } catch (e) {
            console.error("Native Google Link Error:", e);
            throw e;
          }
          return;
        }

        try {
          await linkWithPopup(current, googleProvider());
        } catch (error) {
          const code = (error as { code?: string }).code ?? "";
          console.error(
            "[noma-auth] google link popup failed",
            code,
            "host:",
            window.location.hostname,
            error,
          );
          if (!REDIRECT_FALLBACK_CODES.has(code) || !canRedirect()) throw error;
          await linkWithRedirect(current, googleProvider());
          return;
        }
        setUser({ ...current } as User);
      },
      unlinkGoogle: async () => {
        const current = requireAuth().currentUser;
        if (!current) throw new Error("You need to be signed in to unlink Google.");
        if (current.providerData.length < 2) {
          throw new Error(
            "Google is your only sign-in method — add a password before unlinking it.",
          );
        }
        await unlink(current, "google.com");
        setUser({ ...current } as User);
      },
    };
  }, [user, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): NomaAuth {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside <AuthProvider>.");
  return context;
}

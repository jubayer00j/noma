import { useEffect, useRef, useState, type ReactNode } from "react";
import { Fingerprint, Grid, Hash, KeyRound, Loader2, Lock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PasswordInput } from "@/components/noma/password-input";
import { PatternLock } from "@/components/noma/pattern-lock";
import { PinPad } from "@/components/noma/pin-pad";
import type { NoteLockMethod } from "@/lib/noma/types";
import { cn } from "@/lib/utils";

export interface CredentialPromptMethods {
  biometric: boolean;
  pattern: boolean;
  pin: boolean;
  password: boolean;
}

export interface CredentialPromptProps {
  heading: string;
  subheading?: string;
  methods: CredentialPromptMethods;
  /** Native biometric sensor present and usable on this device. */
  biometricAvailable?: boolean;
  lockoutSeconds: number;
  /** Runs the native biometric prompt; resolve true on success. */
  onBiometric: () => Promise<boolean>;
  /** Verifies a typed credential; the error (if any) is shown inline. */
  onVerify: (
    method: NoteLockMethod,
    secret: string | number[],
  ) => Promise<{ success: boolean; error?: string }>;
  /** Fire the biometric prompt once when the prompt first appears. */
  autoBiometric?: boolean;
  footer?: ReactNode;
}

type TabId = "biometric" | NoteLockMethod;

/**
 * The one credential prompt for Noma — shared by the app lock screen and
 * the per-note lock gate so both feel identical: method tabs, inline error
 * feedback with a shake, a lockout countdown banner, and an optional
 * auto-fired fingerprint prompt.
 */
export function CredentialPrompt({
  heading,
  subheading,
  methods,
  biometricAvailable = false,
  lockoutSeconds,
  onBiometric,
  onVerify,
  autoBiometric = false,
  footer,
}: CredentialPromptProps) {
  const tabs: TabId[] = [
    ...(methods.biometric ? (["biometric"] as TabId[]) : []),
    ...(methods.pattern ? (["pattern"] as TabId[]) : []),
    ...(methods.pin ? (["pin"] as TabId[]) : []),
    ...(methods.password ? (["password"] as TabId[]) : []),
  ];
  const defaultTab: TabId =
    methods.biometric && biometricAvailable ? "biometric" : (tabs.find((t) => t !== "biometric") ?? tabs[0] ?? "password");
  const [selectedTab, setSelectedTab] = useState<TabId>(defaultTab);
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shakeKey, setShakeKey] = useState(0);
  const autoFiredRef = useRef(false);

  const lockedOut = lockoutSeconds > 0;

  useEffect(() => {
    if (!autoBiometric || autoFiredRef.current) return;
    if (!methods.biometric || !biometricAvailable || lockedOut) return;
    autoFiredRef.current = true;
    void onBiometric();
  }, [autoBiometric, methods.biometric, biometricAvailable, lockedOut, onBiometric]);

  const fail = (message: string) => {
    setError(message);
    setShakeKey((k) => k + 1);
    setPassword("");
    setPin("");
  };

  const verify = async (method: NoteLockMethod, secret: string | number[]) => {
    if (busy || lockedOut) return;
    setBusy(true);
    setError(null);
    try {
      const res = await onVerify(method, secret);
      if (!res.success) fail(res.error ?? "Incorrect credential.");
    } finally {
      setBusy(false);
    }
  };

  const handlePatternComplete = (points: number[]) => {
    if (points.length === 0) return;
    if (points.length < 4) {
      fail("Pattern must connect at least 4 dots.");
      return;
    }
    void verify("pattern", points);
  };

  const gridColsClass =
    tabs.length <= 1 ? "grid-cols-1" : tabs.length === 2 ? "grid-cols-2" : tabs.length === 3 ? "grid-cols-3" : "grid-cols-4";

  return (
    <div className="flex w-full max-w-sm flex-col items-center text-center select-none">
      <div className="flex flex-col items-center space-y-3">
        <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15">
          <Lock className="size-7" />
        </div>
        <div className="space-y-1">
          <h2 className="font-serif text-2xl font-semibold tracking-tight">{heading}</h2>
          {subheading && <p className="text-sm text-muted-foreground">{subheading}</p>}
        </div>
      </div>

      {lockedOut && (
        <div className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <ShieldAlert className="size-4 shrink-0" />
          <span>
            Too many attempts. Try again in <span className="font-semibold tabular-nums">{lockoutSeconds}s</span>.
          </span>
        </div>
      )}

      <div key={shakeKey} className={cn("mt-6 w-full", shakeKey > 0 && "animate-noma-shake")}>
        <Tabs
          value={selectedTab}
          onValueChange={(value) => {
            setSelectedTab(value as TabId);
            setError(null);
            setPin("");
            setPassword("");
          }}
          className="w-full"
        >
          {tabs.length > 1 && (
            <TabsList className={`grid w-full ${gridColsClass}`}>
              {methods.biometric && (
                <TabsTrigger value="biometric" disabled={!biometricAvailable}>
                  <Fingerprint className="mr-1.5 size-4" /> Fingerprint
                </TabsTrigger>
              )}
              {methods.pattern && (
                <TabsTrigger value="pattern">
                  <Grid className="mr-1.5 size-4" /> Pattern
                </TabsTrigger>
              )}
              {methods.pin && (
                <TabsTrigger value="pin">
                  <Hash className="mr-1.5 size-4" /> PIN
                </TabsTrigger>
              )}
              {methods.password && (
                <TabsTrigger value="password">
                  <KeyRound className="mr-1.5 size-4" /> Password
                </TabsTrigger>
              )}
            </TabsList>
          )}

          {methods.biometric && (
            <TabsContent value="biometric" className="mt-6 space-y-4">
              <button
                type="button"
                disabled={!biometricAvailable || lockedOut || busy}
                onClick={() => void onBiometric()}
                aria-label="Unlock with fingerprint"
                className="mx-auto flex size-20 items-center justify-center rounded-full border border-primary/25 bg-primary/5 text-primary transition-all hover:bg-primary/10 active:scale-95 disabled:opacity-40 motion-reduce:transition-none"
              >
                <Fingerprint className="size-10" />
              </button>
              <p className="text-sm text-muted-foreground">
                {biometricAvailable
                  ? "Tap to authenticate with your fingerprint"
                  : "Fingerprint isn't available on this device"}
              </p>
            </TabsContent>
          )}

          {methods.pattern && (
            <TabsContent value="pattern" className="mt-6 space-y-3">
              <p className="text-sm text-muted-foreground">Draw your pattern</p>
              <div className="mx-auto flex justify-center">
                <PatternLock
                  size={260}
                  disabled={lockedOut || busy}
                  error={Boolean(error)}
                  onComplete={handlePatternComplete}
                  onChange={() => setError(null)}
                />
              </div>
            </TabsContent>
          )}

          {methods.pin && (
            <TabsContent value="pin" className="mt-6 space-y-3">
              <p className="text-sm text-muted-foreground">Enter your PIN</p>
              <PinPad
                value={pin}
                onChange={(next) => {
                  setPin(next);
                  setError(null);
                }}
                onSubmit={() => void verify("pin", pin)}
                disabled={lockedOut || busy}
                error={Boolean(error)}
              />
            </TabsContent>
          )}

          {methods.password && (
            <TabsContent value="password" className="mt-6 space-y-3">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (password) void verify("password", password);
                }}
                className="space-y-3"
              >
                <PasswordInput
                  placeholder="Enter password"
                  value={password}
                  disabled={lockedOut || busy}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  autoComplete="off"
                />
                <Button type="submit" className="w-full" disabled={!password || lockedOut || busy}>
                  {busy && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Unlock
                </Button>
              </form>
            </TabsContent>
          )}
        </Tabs>

        {error && !lockedOut && (
          <p className="mt-4 text-sm font-medium text-destructive" role="alert">
            {error}
          </p>
        )}
        {busy && (
          <p className="mt-4 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Verifying…
          </p>
        )}
      </div>

      {footer}
    </div>
  );
}

import { ExternalLink, KeyRound, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/noma/password-input";
import {
  AiError,
  GEMINI_MODEL_LABEL,
  clearAiSettings,
  getAiSettings,
  saveAiSettings,
  testAiConnection,
  type AiSettings,
} from "@/lib/noma/ai";

const tap =
  "transition-transform active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100";

export const AI_SETTINGS_CHANGED_EVENT = "noma:ai-changed";

/** Announce a record change so other surfaces (the note menu) can refresh. */
function emitAiChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AI_SETTINGS_CHANGED_EVENT));
  }
}

function maskKey(apiKey: string): string {
  const tail = apiKey.trim().slice(-4);
  return tail ? `••••••••${tail}` : "••••••••";
}

/**
 * AI features controls (Settings). Off by default and gated on the
 * user's own Gemini key: enabling stores { enabled, apiKey } in the
 * per-account localStorage record (see ai.ts) — never in AppSettings,
 * so the key can't ride into a backup or a sync payload.
 */
export function AiSection({ ownerId }: { ownerId: string | null }) {
  const [record, setRecord] = useState<AiSettings | null>(() => getAiSettings(ownerId));
  const refresh = useCallback(() => {
    setRecord(getAiSettings(ownerId));
  }, [ownerId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    window.addEventListener(AI_SETTINGS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(AI_SETTINGS_CHANGED_EVENT, refresh);
  }, [refresh]);

  const [keyDraft, setKeyDraft] = useState("");
  const [testState, setTestState] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "ok" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const enabled = record?.enabled === true;
  const savedKey = record?.apiKey ?? "";

  function persist(next: AiSettings | null) {
    if (next) saveAiSettings(ownerId, next);
    else clearAiSettings(ownerId);
    emitAiChanged();
    refresh();
  }

  function toggleEnabled(checked: boolean) {
    setTestState({ kind: "idle" });
    persist({ enabled: checked, apiKey: savedKey, ...(record?.model ? { model: record.model } : {}) });
  }

  function saveKey() {
    const key = keyDraft.trim();
    if (!key) return;
    persist({ enabled: true, apiKey: key, ...(record?.model ? { model: record.model } : {}) });
    setKeyDraft("");
    setTestState({ kind: "idle" });
    toast.success("Gemini key saved on this device");
  }

  function removeKey() {
    persist(null);
    setKeyDraft("");
    setTestState({ kind: "idle" });
    toast.success("Gemini key removed from this device");
  }

  async function runTest(keyToTest: string) {
    if (!keyToTest.trim() || testState.kind === "busy") return;
    setTestState({ kind: "busy" });
    try {
      await testAiConnection(keyToTest, record);
      setTestState({ kind: "ok" });
    } catch (error) {
      setTestState({
        kind: "error",
        message:
          error instanceof AiError ? error.message : "Something went wrong. Try again.",
      });
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden="true" />
          <Label htmlFor="noma-ai-enabled">Enable AI features</Label>
        </div>
        <Switch id="noma-ai-enabled" checked={enabled} onCheckedChange={toggleEnabled} />
      </div>

      <p className="text-sm text-muted-foreground">
        AI is off until you add your own key. When you tap an AI action, that note's text is sent
        to Google Gemini under your key. Noma has no server and sees nothing. Locked notes are
        never sent.
      </p>
      <p className="text-xs text-muted-foreground">
        Your key stays on this device — it is never backed up or synced.
      </p>

      {enabled && (
        <>
          {savedKey ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                <span>
                  Key saved · <span className="font-mono text-xs">{maskKey(savedKey)}</span>
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className={`h-11 ${tap}`}
                  disabled={testState.kind === "busy"}
                  onClick={() => void runTest(savedKey)}
                >
                  {testState.kind === "busy" && (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  )}{" "}
                  Test connection
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 text-destructive hover:text-destructive"
                  onClick={removeKey}
                >
                  Remove key
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <Label htmlFor="noma-ai-key">Gemini API key</Label>
                <PasswordInput
                  id="noma-ai-key"
                  enterKeyHint="done"
                  className="mt-1.5"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  placeholder="Paste your Gemini API key"
                  autoComplete="off"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Free from Google AI Studio — no card needed.{" "}
                  <a
                    className="inline-flex items-center gap-1 underline underline-offset-2"
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Get a free key <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  className={`h-11 ${tap}`}
                  disabled={!keyDraft.trim()}
                  onClick={saveKey}
                >
                  Save key
                </Button>
                <Button
                  variant="outline"
                  className={`h-11 ${tap}`}
                  disabled={!keyDraft.trim() || testState.kind === "busy"}
                  onClick={() => void runTest(keyDraft)}
                >
                  {testState.kind === "busy" && (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  )}{" "}
                  Test connection
                </Button>
              </div>
            </div>
          )}

          {testState.kind === "ok" && (
            <p className="text-sm text-primary" role="status">
              Connected — Gemini is ready.
            </p>
          )}
          {testState.kind === "error" && (
            <p className="text-sm text-destructive" role="alert">
              {testState.message}
            </p>
          )}

          <p className="text-xs text-muted-foreground">Model: {GEMINI_MODEL_LABEL}</p>
        </>
      )}
    </div>
  );
}

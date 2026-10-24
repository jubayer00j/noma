import { ExternalLink, KeyRound, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/noma/password-input";
import {
  AiError,
  GEMINI_MODEL_LABEL,
  OPENAI_PRESETS,
  clearAiSettings,
  getAiSettings,
  normalizeBaseUrl,
  resolveAiPreset,
  saveAiSettings,
  testAiConnection,
  type AiProvider,
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
 * user's own key: enabling stores { enabled, apiKey, provider,
 * baseUrl, model } in the per-account localStorage record (see ai.ts)
 * — never in AppSettings, so the key can't ride into a backup or a
 * sync payload. Gemini is the default provider; the OpenAI-compatible
 * presets (plus Custom endpoint) let any provider's key in, with the
 * model as free text — never a hardcoded model list.
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
  const [providerDraft, setProviderDraft] = useState<AiProvider>("gemini");
  const [presetDraft, setPresetDraft] = useState("gemini");
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [testState, setTestState] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "ok" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Drafts follow the saved record (account switch, external clear,
  // or a just-persisted save); edits in between are the user's until
  // the next record change.
  useEffect(() => {
    const provider = record?.provider ?? "gemini";
    setProviderDraft(provider);
    setPresetDraft(resolveAiPreset(provider, record?.baseUrl));
    setBaseUrlDraft(record?.baseUrl ?? "");
    setModelDraft(record?.model ?? "");
  }, [record]);

  const enabled = record?.enabled === true;
  const savedKey = record?.apiKey ?? "";
  const openAi = providerDraft === "openai-compatible";
  const preset = OPENAI_PRESETS.find((item) => item.id === presetDraft);
  const providerName = !openAi
    ? "Google Gemini"
    : presetDraft === "custom"
      ? "your custom endpoint"
      : (preset?.label ?? "this provider");
  const presetKeyUrl = !openAi
    ? "https://aistudio.google.com/app/apikey"
    : (preset?.keyUrl ?? null);

  function persist(next: AiSettings | null) {
    if (next) saveAiSettings(ownerId, next);
    else clearAiSettings(ownerId);
    emitAiChanged();
    refresh();
  }

  function toggleEnabled(checked: boolean) {
    setTestState({ kind: "idle" });
    persist(record ? { ...record, enabled: checked } : { enabled: checked, apiKey: "" });
  }

  function selectPreset(id: string) {
    setTestState({ kind: "idle" });
    if (id === "gemini") {
      setProviderDraft("gemini");
      setPresetDraft("gemini");
      return;
    }
    const next = OPENAI_PRESETS.find((item) => item.id === id);
    if (!next) return;
    setProviderDraft("openai-compatible");
    setPresetDraft(next.id);
    if (next.id !== "custom") {
      setBaseUrlDraft(next.baseUrl);
      setModelDraft(next.defaultModel);
    }
  }

  /** Draft problems that must stop a save or a test, in calm words. */
  function draftError(): string | null {
    if (!openAi) return null;
    if (!/^https:\/\//.test(normalizeBaseUrl(baseUrlDraft))) {
      return "Provider URL must start with https://.";
    }
    if (!modelDraft.trim()) return "Enter a model id for this provider.";
    return null;
  }

  /** The record a save or a test runs against (drafts, not last save). */
  function buildCandidate(key: string): AiSettings {
    if (!openAi) {
      // A stored model override only survives when it belongs to
      // Gemini — an OpenAI model id must never leak into a Gemini call.
      const geminiModel =
        record?.provider === "gemini" || !record?.provider ? record?.model : undefined;
      return {
        enabled: true,
        apiKey: key,
        provider: "gemini",
        ...(geminiModel ? { model: geminiModel } : {}),
      };
    }
    return {
      enabled: true,
      apiKey: key,
      provider: "openai-compatible",
      baseUrl: normalizeBaseUrl(baseUrlDraft),
      model: modelDraft.trim(),
    };
  }

  function saveKey() {
    const key = keyDraft.trim();
    if (!key) return;
    const error = draftError();
    if (error) {
      toast.error(error);
      return;
    }
    persist(buildCandidate(key));
    setKeyDraft("");
    setTestState({ kind: "idle" });
    toast.success("AI key saved on this device");
  }

  function removeKey() {
    persist(null);
    setKeyDraft("");
    setTestState({ kind: "idle" });
    toast.success("AI key removed from this device");
  }

  async function runTest(keyToTest: string) {
    if (!keyToTest.trim() || testState.kind === "busy") return;
    const error = draftError();
    if (error) {
      setTestState({ kind: "error", message: error });
      return;
    }
    setTestState({ kind: "busy" });
    try {
      await testAiConnection(keyToTest, buildCandidate(keyToTest));
      setTestState({ kind: "ok" });
    } catch (err) {
      setTestState({
        kind: "error",
        message: err instanceof AiError ? err.message : "Something went wrong. Try again.",
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
        AI is off until you add your own key. When you tap an AI action, that note's text is sent to{" "}
        {providerName} under your key. Noma has no server and sees nothing. Locked notes are never
        sent.
      </p>
      <p className="text-xs text-muted-foreground">
        Your key stays on this device — it is never backed up or synced.
      </p>

      {enabled && (
        <>
          <div className="space-y-2">
            <Label htmlFor="noma-ai-provider">Provider</Label>
            <Select value={presetDraft} onValueChange={selectPreset}>
              <SelectTrigger id="noma-ai-provider" className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gemini">Gemini</SelectItem>
                {OPENAI_PRESETS.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {openAi && (
            <>
              {presetDraft === "custom" ? (
                <div className="space-y-2">
                  <Label htmlFor="noma-ai-base-url">Endpoint URL</Label>
                  <Input
                    id="noma-ai-base-url"
                    className="h-11 font-mono text-xs"
                    value={baseUrlDraft}
                    onChange={(event) => setBaseUrlDraft(event.target.value)}
                    placeholder="https://api.example.com/v1"
                    autoComplete="off"
                    inputMode="url"
                  />
                  <p className="text-xs text-muted-foreground">
                    Any OpenAI-compatible endpoint. Must start with https://.
                  </p>
                </div>
              ) : (
                <p className="font-mono text-xs text-muted-foreground">
                  Endpoint: {baseUrlDraft || preset?.baseUrl}
                </p>
              )}
              <div className="space-y-2">
                <Label htmlFor="noma-ai-model">Model</Label>
                <Input
                  id="noma-ai-model"
                  className="h-11 font-mono text-xs"
                  value={modelDraft}
                  onChange={(event) => setModelDraft(event.target.value)}
                  placeholder="Model id, e.g. gpt-4o-mini"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Any model id this provider offers — new models work without an app update.
                </p>
              </div>
            </>
          )}

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
                <Label htmlFor="noma-ai-key">{openAi ? "API key" : "Gemini API key"}</Label>
                <PasswordInput
                  id="noma-ai-key"
                  enterKeyHint="done"
                  className="mt-1.5"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  placeholder={openAi ? "Paste your API key" : "Paste your Gemini API key"}
                  autoComplete="off"
                />
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {openAi ? (
                    presetKeyUrl ? (
                      <>
                        From your provider.{" "}
                        <a
                          className="inline-flex items-center gap-1 underline underline-offset-2"
                          href={presetKeyUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Get a key <ExternalLink className="size-3" aria-hidden="true" />
                        </a>
                      </>
                    ) : (
                      "From your provider's dashboard."
                    )
                  ) : (
                    <>
                      Free from Google AI Studio — no card needed.{" "}
                      <a
                        className="inline-flex items-center gap-1 underline underline-offset-2"
                        href="https://aistudio.google.com/app/apikey"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Get a free key <ExternalLink className="size-3" aria-hidden="true" />
                      </a>
                    </>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button className={`h-11 ${tap}`} disabled={!keyDraft.trim()} onClick={saveKey}>
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
              Connected — {providerName} is ready.
            </p>
          )}
          {testState.kind === "error" && (
            <p className="text-sm text-destructive" role="alert">
              {testState.message}
            </p>
          )}

          {!openAi && <p className="text-xs text-muted-foreground">Model: {GEMINI_MODEL_LABEL}</p>}
        </>
      )}
    </div>
  );
}

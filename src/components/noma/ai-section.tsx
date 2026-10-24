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
  aiSlotChanged,
  getAiRecord,
  normalizeBaseUrl,
  saveAiRecord,
  testAiConnection,
  type AiProviderSlot,
  type AiRecord,
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
 * user's own keys: every provider preset keeps its OWN key + model in
 * a slot of the per-account localStorage record (see ai.ts) — never
 * in AppSettings, so no key can ride into a backup or a sync payload.
 * Selecting a provider loads that provider's slot: its saved key, or
 * an empty key field when it has none. A provider only ever receives
 * its own key, and switching back restores its key untouched. Gemini
 * is the default provider; the OpenAI-compatible presets (plus Custom
 * endpoint) let any provider's key in, with the model as free text —
 * never a hardcoded model list.
 */
export function AiSection({ ownerId }: { ownerId: string | null }) {
  const [record, setRecord] = useState<AiRecord | null>(() => getAiRecord(ownerId));
  const refresh = useCallback(() => {
    setRecord(getAiRecord(ownerId));
  }, [ownerId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    window.addEventListener(AI_SETTINGS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(AI_SETTINGS_CHANGED_EVENT, refresh);
  }, [refresh]);

  const [presetDraft, setPresetDraft] = useState("gemini");
  const [keyDraft, setKeyDraft] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [testState, setTestState] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "ok" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Drafts follow the saved record's ACTIVE slot (account switch,
  // external clear, or a just-persisted save); edits in between are
  // the user's until the next record change.
  useEffect(() => {
    const active = record?.activePreset ?? "gemini";
    const slot = record?.providers[active];
    setPresetDraft(active);
    setKeyDraft("");
    setReplacingKey(false);
    if (active === "gemini") {
      setBaseUrlDraft("");
      setModelDraft("");
    } else if (active === "custom") {
      setBaseUrlDraft(slot?.baseUrl ?? "");
      setModelDraft(slot?.model ?? "");
    } else {
      const preset = OPENAI_PRESETS.find((item) => item.id === active);
      setBaseUrlDraft(preset?.baseUrl ?? "");
      setModelDraft(slot?.model ?? preset?.defaultModel ?? "");
    }
  }, [record]);

  const enabled = record?.enabled === true;
  const activePreset = record?.activePreset ?? "gemini";
  const slot = record?.providers[presetDraft];
  const slotKey = slot?.apiKey ?? "";
  const hasSlotKey = slotKey.trim() !== "";
  const openAi = presetDraft !== "gemini";
  const preset = OPENAI_PRESETS.find((item) => item.id === presetDraft);
  const providerName =
    presetDraft === "gemini"
      ? "Google Gemini"
      : presetDraft === "custom"
        ? "your custom endpoint"
        : (preset?.label ?? "this provider");
  const providerLabel =
    presetDraft === "gemini"
      ? "Gemini"
      : presetDraft === "custom"
        ? "Custom endpoint"
        : providerName;
  const presetKeyUrl =
    presetDraft === "gemini" ? "https://aistudio.google.com/app/apikey" : (preset?.keyUrl ?? null);
  // The key field shows when the selected provider has no key yet, or
  // the user asked to replace the one it has. Another provider's key —
  // or even its mask — is never shown here.
  const enteringKey = !hasSlotKey || replacingKey;

  function persist(next: AiRecord) {
    saveAiRecord(ownerId, next);
    emitAiChanged();
    refresh();
  }

  function toggleEnabled(checked: boolean) {
    setTestState({ kind: "idle" });
    persist(
      record
        ? { ...record, enabled: checked }
        : { enabled: checked, activePreset: "gemini", providers: {} },
    );
  }

  function selectPreset(id: string) {
    setTestState({ kind: "idle" });
    const nextSlot = record?.providers[id];
    setPresetDraft(id);
    setKeyDraft("");
    setReplacingKey(false);
    if (id === "gemini") {
      setBaseUrlDraft("");
      setModelDraft("");
    } else if (id === "custom") {
      setBaseUrlDraft(nextSlot?.baseUrl ?? "");
      setModelDraft(nextSlot?.model ?? "");
    } else {
      const next = OPENAI_PRESETS.find((item) => item.id === id);
      setBaseUrlDraft(next?.baseUrl ?? "");
      setModelDraft(nextSlot?.model ?? next?.defaultModel ?? "");
    }
  }

  /** Draft problems that must stop a save or a test, in calm words. */
  function draftError(): string | null {
    if (!openAi) return null;
    if (presetDraft === "custom" && !/^https:\/\//.test(normalizeBaseUrl(baseUrlDraft))) {
      return "Provider URL must start with https://.";
    }
    if (!modelDraft.trim()) return "Enter a model id for this provider.";
    return null;
  }

  /** The selected provider's slot as the drafts describe it. */
  function buildCandidateSlot(key: string): AiProviderSlot {
    if (presetDraft === "gemini") {
      // A stored Gemini model override is not editable here, but it
      // belongs to the Gemini slot and survives a key save.
      const next: AiProviderSlot = { apiKey: key };
      if (slot?.model) next.model = slot.model;
      return next;
    }
    const next: AiProviderSlot = { apiKey: key };
    if (modelDraft.trim()) next.model = modelDraft.trim();
    if (presetDraft === "custom") next.baseUrl = normalizeBaseUrl(baseUrlDraft);
    return next;
  }

  /** The flat settings a test runs against (drafts, not last save). */
  function buildCandidateSettings(key: string): AiSettings {
    if (presetDraft === "gemini") {
      const next: AiSettings = { enabled: true, apiKey: key, provider: "gemini" };
      if (slot?.model) next.model = slot.model;
      return next;
    }
    return {
      enabled: true,
      apiKey: key,
      provider: "openai-compatible",
      baseUrl: presetDraft === "custom" ? normalizeBaseUrl(baseUrlDraft) : (preset?.baseUrl ?? ""),
      model: modelDraft.trim(),
    };
  }

  /** Persist the selected provider's slot and make it the active one. */
  function persistSlot(key: string, message: string) {
    const error = draftError();
    if (error) {
      toast.error(error);
      return;
    }
    const base: AiRecord = record ?? { enabled: true, activePreset: presetDraft, providers: {} };
    persist({
      ...base,
      enabled: true,
      activePreset: presetDraft,
      providers: { ...base.providers, [presetDraft]: buildCandidateSlot(key) },
    });
    setTestState({ kind: "idle" });
    toast.success(message);
  }

  function saveKey() {
    const key = keyDraft.trim();
    if (!key) return;
    persistSlot(key, "AI key saved on this device");
  }

  /** Persist draft model/endpoint edits (or a provider switch) for the selected slot. */
  function saveProviderSettings() {
    persistSlot(slotKey, "Provider settings saved");
  }

  /** Remove ONLY the selected provider's key; other slots are untouched. */
  function removeKey() {
    if (!record) return;
    const providers = { ...record.providers };
    delete providers[presetDraft];
    persist({ ...record, providers });
    setTestState({ kind: "idle" });
    toast.success(`${providerLabel} key removed from this device`);
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
      await testAiConnection(keyToTest, buildCandidateSettings(keyToTest));
      setTestState({ kind: "ok" });
    } catch (err) {
      setTestState({
        kind: "error",
        message: err instanceof AiError ? err.message : "Something went wrong. Try again.",
      });
    }
  }

  // Whether the selected slot's drafts differ from what is saved for
  // it — including "a different provider is selected than the active
  // one". Drives the Save button and the test-pass copy below.
  const settingsDirty =
    presetDraft !== activePreset ||
    aiSlotChanged(slot, buildCandidateSlot(slotKey), preset?.defaultModel ?? "");

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
        Your keys stay on this device — they are never backed up or synced. Each provider keeps its
        own key.
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
                  Endpoint: {preset?.baseUrl}
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

          {enteringKey ? (
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
                  {presetDraft === "gemini" ? (
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
                  ) : presetKeyUrl ? (
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
                {replacingKey && (
                  <Button
                    variant="ghost"
                    className={`h-11 ${tap}`}
                    onClick={() => {
                      setReplacingKey(false);
                      setKeyDraft("");
                      setTestState({ kind: "idle" });
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                <span>
                  Key saved · <span className="font-mono text-xs">{maskKey(slotKey)}</span>
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {settingsDirty && (
                  <Button className={`h-11 ${tap}`} onClick={saveProviderSettings}>
                    Save provider settings
                  </Button>
                )}
                <Button
                  variant="outline"
                  className={`h-11 ${tap}`}
                  disabled={testState.kind === "busy"}
                  onClick={() => void runTest(slotKey)}
                >
                  {testState.kind === "busy" && (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  )}{" "}
                  Test connection
                </Button>
                <Button
                  variant="ghost"
                  className={`h-11 ${tap}`}
                  onClick={() => {
                    setReplacingKey(true);
                    setTestState({ kind: "idle" });
                  }}
                >
                  Replace key
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
          )}

          {testState.kind === "ok" && (
            <p className="text-sm text-primary" role="status">
              {enteringKey
                ? `Test passed — tap Save key to use ${providerName}.`
                : settingsDirty
                  ? `Test passed — save provider settings to use ${providerName}.`
                  : `Connected — ${providerName} is ready.`}
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

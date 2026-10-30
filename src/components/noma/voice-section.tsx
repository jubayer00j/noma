import { Mic } from "lucide-react";
import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSettings } from "@/hooks/use-noma";
import { defaultSpeechEngine } from "@/lib/noma/speech";
import type { SpeechLanguageSetting } from "@/lib/noma/types";

type Availability = "checking" | "available" | "unavailable";

/**
 * Voice capture settings (voice capture PR-B), on the Writing screen:
 * the dictation language plus an honest account of what the platform
 * recogniser is. The engine probe runs once on mount — where no
 * recogniser exists at all, the section says so plainly and the
 * editor simply never offers the mic (the gate-family honesty
 * pattern, same as semantic search / Ask).
 *
 * The privacy shape, in one breath: recognition is done by the
 * platform (Android's SpeechRecognizer / the browser's speech
 * service) — on newer Android it can run on-device; on older devices
 * the device's own speech service (usually Google's) does it and may
 * process speech online. Noma stores no audio, ever; only the words
 * land, as ordinary note text.
 */
export function VoiceSection() {
  const { settings, update } = useSettings();
  const [availability, setAvailability] = useState<Availability>("checking");
  const [onDevice, setOnDevice] = useState(false);
  const [blockedApp, setBlockedApp] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const engine = defaultSpeechEngine();
    if (!engine) {
      setAvailability("unavailable");
      return;
    }
    engine
      .probe()
      .then((probe) => {
        if (!live) return;
        setAvailability(probe.available ? "available" : "unavailable");
        setOnDevice(probe.onDevice);
        if (!probe.available && probe.reason === "service-disabled") {
          setBlockedApp(probe.serviceApp ?? "");
        }
      })
      .catch(() => {
        if (live) setAvailability("unavailable");
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="space-y-3 border-t border-border/70 pt-5">
      <div className="flex items-center gap-2">
        <Mic className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">Voice capture</h3>
      </div>

      <p className="text-sm text-muted-foreground">
        Dictate into any note with the mic in the editor toolbar.{" "}
        {availability === "available" && (
          <>
            Speech is recognised by your device&apos;s speech service —{" "}
            {onDevice
              ? "on this device it can run fully on-device. "
              : "on this device that service (usually Google's) may process your speech online. "}
          </>
        )}
        Noma never stores audio; only the words you dictate are kept, as note text.
      </p>

      <div className="space-y-2">
        <Label htmlFor="speech-language">Dictation language</Label>
        <Select
          value={settings.speechLanguage}
          onValueChange={(value) => void update({ speechLanguage: value as SpeechLanguageSetting })}
          disabled={availability === "unavailable"}
        >
          <SelectTrigger id="speech-language" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">System default</SelectItem>
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="bn">বাংলা (Bangla)</SelectItem>
          </SelectContent>
        </Select>
        {availability === "checking" && (
          <p className="text-xs text-muted-foreground">Checking this device…</p>
        )}
        {availability === "unavailable" &&
          (blockedApp !== null ? (
            <p className="text-xs text-muted-foreground">
              Your phone&apos;s speech service{blockedApp ? ` — ${blockedApp} —` : ""} is disabled,
              so dictation can&apos;t run. Enable it, or choose a different voice input in your
              system settings, and voice capture will be available here.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              No speech recogniser is available on this device or browser, so voice capture is off
              here. Everything else works as usual.
            </p>
          ))}
      </div>
    </div>
  );
}

import { Check, Delete } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 6;

interface PinPadProps {
  value: string;
  onChange: (pin: string) => void;
  /** Called when the user confirms a PIN of at least PIN_MIN_LENGTH digits. */
  onSubmit?: () => void;
  disabled?: boolean;
  error?: boolean;
  /** Hide the confirm button (parent submits some other way). */
  hideConfirm?: boolean;
}

/** Numeric PIN entry: progress dots over a telephone-style pad. */
export function PinPad({
  value,
  onChange,
  onSubmit,
  disabled = false,
  error = false,
  hideConfirm = false,
}: PinPadProps) {
  const press = (digit: string) => {
    if (disabled || value.length >= PIN_MAX_LENGTH) return;
    onChange(value + digit);
  };
  const backspace = () => {
    if (disabled) return;
    onChange(value.slice(0, -1));
  };
  const canSubmit = value.length >= PIN_MIN_LENGTH && !disabled;

  const keys: Array<{ label: string; action: () => void; icon?: "delete" | "check" }> = [
    ...["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => ({
      label: digit,
      action: () => press(digit),
    })),
    { label: "", action: backspace, icon: "delete" as const },
    { label: "0", action: () => press("0") },
    hideConfirm
      ? { label: "", action: () => undefined }
      : { label: "", action: () => canSubmit && onSubmit?.(), icon: "check" as const },
  ];

  return (
    <div className={cn("mx-auto w-full max-w-60", error && "animate-noma-shake")}>
      <div className="mb-5 flex items-center justify-center gap-2.5" aria-hidden="true">
        {Array.from({ length: PIN_MAX_LENGTH }).map((_, i) => (
          <span
            key={i}
            className={cn(
              "size-3 rounded-full border transition-all duration-150",
              error
                ? "border-destructive bg-destructive/20"
                : i < value.length
                  ? "border-primary bg-primary"
                  : "border-muted-foreground/40 bg-transparent",
            )}
          />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {keys.map((key, i) =>
          key.icon ? (
            <Button
              key={i}
              type="button"
              variant="ghost"
              disabled={disabled || (key.icon === "check" && !canSubmit)}
              onClick={key.action}
              aria-label={key.icon === "delete" ? "Delete digit" : "Confirm PIN"}
              className="h-12 rounded-full text-muted-foreground"
            >
              {key.icon === "delete" ? <Delete className="size-5" /> : <Check className="size-5" />}
            </Button>
          ) : key.label ? (
            <Button
              key={i}
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={key.action}
              className="h-12 rounded-full font-serif text-xl"
            >
              {key.label}
            </Button>
          ) : (
            <span key={i} />
          ),
        )}
      </div>
    </div>
  );
}

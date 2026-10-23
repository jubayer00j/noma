import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface PromptRequest {
  title: string;
  description?: string;
  initialValue?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void | Promise<void>;
}

export function PromptDialog({
  request,
  onClose,
}: {
  request: PromptRequest | null;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue(request?.initialValue ?? "");
  }, [request]);

  return (
    <Dialog open={Boolean(request)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-serif">{request?.title}</DialogTitle>
          {request?.description && <DialogDescription>{request.description}</DialogDescription>}
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!value.trim() || !request) return;
            await request.onConfirm(value.trim());
            onClose();
          }}
        >
          <Input
            autoFocus
            enterKeyHint="done"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="h-10"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim()}>
              {request?.confirmLabel ?? "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

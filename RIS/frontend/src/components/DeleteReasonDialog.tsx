import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type DeleteReasonOptions = {
  title: string;
  description?: string;
  target?: string;
};

type PendingRequest = DeleteReasonOptions & {
  resolve: (reason: string | null) => void;
};

export function useDeleteReasonDialog() {
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [reason, setReason] = useState("");
  const resolverRef = useRef<((reason: string | null) => void) | null>(null);

  const confirmDelete = (options: DeleteReasonOptions) =>
    new Promise<string | null>(resolve => {
      resolverRef.current = resolve;
      setReason("");
      setRequest({ ...options, resolve });
    });

  const close = (value: string | null) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setRequest(null);
    setReason("");
  };

  const dialog = (
    <Dialog
      open={Boolean(request)}
      onOpenChange={open => {
        if (!open) close(null);
      }}
    >
      <DialogContent className="max-w-lg rounded-lg">
        <DialogHeader>
          <DialogTitle>{request?.title || "Confirm delete"}</DialogTitle>
          <DialogDescription>
            {request?.description || "This action cannot be undone."}
          </DialogDescription>
        </DialogHeader>
        {request?.target && (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
            {request.target}
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="delete-reason">Reason for deletion</Label>
          <Textarea
            id="delete-reason"
            value={reason}
            onChange={event => setReason(event.target.value)}
            placeholder="Example: wrong study, duplicate data, admin request, or another operational reason."
            className="min-h-[120px]"
          />
          <p className="text-xs text-muted-foreground">
            Reason is required and will be stored in the audit log.
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!reason.trim()}
            onClick={() => close(reason.trim())}
            className="gap-2"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirmDelete, DeleteReasonDialog: dialog };
}

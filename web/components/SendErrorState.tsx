"use client";

import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { describeSendError, type SendErrorInput } from "@/lib/send-errors";

/**
 * The screen for a payment that cannot go ahead: no routes, every route dropped,
 * an expired price, or a failed payment. The wording lives in lib/send-errors.ts.
 */
export function SendErrorState({
  error,
  onAction,
}: {
  error: SendErrorInput;
  /** Called when the sender chooses the next step the screen offers. */
  onAction?: () => void;
}) {
  const view = describeSendError(error);
  return (
    <Card role="alert" data-error-kind={view.kind} className="space-y-3">
      <div className="flex items-center gap-2">
        <CircleAlert size={18} aria-hidden="true" />
        <h2 className="text-lg font-semibold">{view.title}</h2>
      </div>
      <p>{view.message}</p>
      {view.details.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm break-words">
          {view.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {onAction && <Button onClick={onAction}>{view.action}</Button>}
    </Card>
  );
}

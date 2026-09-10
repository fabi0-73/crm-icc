"use client";

import { Check, CheckCheck } from "lucide-react";

export type DeliveryStatus = "sent" | "delivered" | "seen";

/**
 * Tiny read-receipt indicator shown on the current user's own messages.
 *  - sent      — the insert resolved (single check)
 *  - delivered — stored in a room with ≥1 other member (double check)
 *  - seen      — every other member has read past it (brand-colored double check)
 */
export function MessageStatus({
  status,
  className = "",
}: {
  status: DeliveryStatus;
  className?: string;
}) {
  const label =
    status === "seen" ? "Seen" : status === "delivered" ? "Delivered" : "Sent";
  const tone = status === "seen" ? "text-brand-600" : "text-muted/70";

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`inline-flex items-center ${tone} ${className}`}
    >
      {status === "sent" ? (
        <Check className="size-3.5" strokeWidth={2.5} />
      ) : (
        <CheckCheck className="size-3.5" strokeWidth={2.5} />
      )}
    </span>
  );
}

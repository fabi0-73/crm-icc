import type { DeliveryStatus } from "@/components/MessageStatus";
import type { RoomMemberView } from "@/lib/types";

type ReceiptMember = Pick<
  RoomMemberView,
  "id" | "last_read_at" | "last_delivered_at"
>;

function reached(stamp: string | null | undefined, t: number): boolean {
  return stamp != null && Date.parse(stamp) >= t;
}

/**
 * Receipt state for one of the viewer's own messages, from the live roster:
 *  - seen      — every other member has read past it
 *  - delivered — it reached at least one other member's device (their
 *                last_delivered_at, or a read — reading implies delivery)
 *  - sent      — stored, but nobody else's app has received it yet
 */
export function deliveryStatus(
  createdAt: string,
  members: ReceiptMember[],
  senderId: string,
): DeliveryStatus {
  const others = members.filter((m) => m.id !== senderId);
  if (others.length === 0) return "sent";
  const t = Date.parse(createdAt);
  if (others.every((m) => reached(m.last_read_at, t))) return "seen";
  if (
    others.some(
      (m) => reached(m.last_delivered_at, t) || reached(m.last_read_at, t),
    )
  ) {
    return "delivered";
  }
  return "sent";
}

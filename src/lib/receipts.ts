import type { RoomMemberView } from "@/lib/types";

export type ReceiptStatus = "sent" | "delivered" | "read";

export function receiptStatus(
  createdAt: string,
  members: Pick<
    RoomMemberView,
    "id" | "last_read_at" | "last_delivered_at"
  >[],
  senderId: string | null,
): ReceiptStatus {
  if (!senderId) return "sent";
  const others = members.filter((m) => m.id !== senderId);
  if (others.length === 0) return "sent";
  const t = Date.parse(createdAt);
  const allRead = others.every(
    (m) => m.last_read_at && Date.parse(m.last_read_at) >= t,
  );
  if (allRead) return "read";
  const anyDelivered = others.some(
    (m) => m.last_delivered_at && Date.parse(m.last_delivered_at) >= t,
  );
  if (anyDelivered) return "delivered";
  return "sent";
}

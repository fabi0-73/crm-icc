import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import type { MyRoom } from "@/lib/types";

function formatTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function RoomList({ rooms }: { rooms: MyRoom[] }) {
  if (rooms.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-muted text-sm">
        No conversations yet
      </div>
    );
  }

  return (
    <ul className="h-full overflow-y-auto bg-paper">
      {rooms.map((room) => (
        <li key={room.room_id} className="border-b border-line">
          <Link
            href={`/rooms/${room.room_id}`}
            className="flex items-center gap-3 px-3 py-3 hover:bg-mist transition-colors"
          >
            <Avatar name={room.name} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-sm font-medium text-ink">
                  {room.name}
                </p>
                <span className="shrink-0 text-xs text-muted tabular-nums">
                  {formatTime(room.last_message_at)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2">
                <p className="truncate text-[13px] text-muted">
                  {room.last_message_kind === "system"
                    ? room.last_message_body
                    : room.last_message_sender
                      ? `${room.last_message_sender}: ${room.last_message_body ?? ""}`
                      : (room.last_message_body ?? "No messages yet")}
                </p>
                {room.unread_count > 0 && (
                  <span className="shrink-0 min-w-[1.25rem] rounded-full bg-brand-600 px-1.5 py-0.5 text-center text-[11px] font-semibold text-white">
                    {room.unread_count > 99 ? "99+" : room.unread_count}
                  </span>
                )}
              </div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

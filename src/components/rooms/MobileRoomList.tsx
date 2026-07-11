"use client";

import { useRooms } from "@/components/rooms/RoomsProvider";
import { RoomList } from "@/components/RoomList";

/** Full-screen sectioned list on mobile (Channels / Direct messages),
 *  same live state as the desktop sidebar. */
export function MobileRoomList() {
  const { rooms } = useRooms();
  const channels = rooms.filter((r) => r.type !== "dm");
  const dms = rooms.filter((r) => r.type === "dm");

  if (rooms.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted">
        No conversations yet
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-paper">
      {channels.length > 0 && (
        <>
          <p className="border-b border-line bg-mist px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Channels
          </p>
          <RoomList rooms={channels} />
        </>
      )}
      {dms.length > 0 && (
        <>
          <p className="border-b border-line bg-mist px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Direct messages
          </p>
          <RoomList rooms={dms} />
        </>
      )}
    </div>
  );
}

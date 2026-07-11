"use client";

import { useRooms } from "@/components/rooms/RoomsProvider";
import { RoomList } from "@/components/RoomList";

/** Full-screen room list on mobile — same live state as the sidebar. */
export function MobileRoomList() {
  const { rooms } = useRooms();
  return <RoomList rooms={rooms} />;
}

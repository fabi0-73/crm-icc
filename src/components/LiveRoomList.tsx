"use client";

import { useEffect, useMemo, useState } from "react";
import { RoomList } from "@/components/RoomList";
import { createClient } from "@/lib/supabase/client";
import {
  ensureRealtimeAuth,
  subscribeToAllMessageInserts,
} from "@/lib/supabase/realtime";
import type { MyRoom } from "@/lib/types";

/** Room list with live unread increments from message INSERTs. */
export function LiveRoomList({
  initialRooms,
  currentUserId,
}: {
  initialRooms: MyRoom[];
  currentUserId: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rooms, setRooms] = useState(initialRooms);

  useEffect(() => {
    setRooms(initialRooms);
  }, [initialRooms]);

  useEffect(() => {
    let channel: ReturnType<typeof subscribeToAllMessageInserts> | null = null;
    let cancelled = false;

    (async () => {
      await ensureRealtimeAuth(supabase);
      if (cancelled) return;
      channel = subscribeToAllMessageInserts(supabase, (msg) => {
        if (msg.sender_id === currentUserId) return;
        setRooms((prev) => {
          const idx = prev.findIndex((r) => r.room_id === msg.room_id);
          if (idx < 0) return prev;
          const next = [...prev];
          const room = { ...next[idx] };
          room.unread_count += 1;
          room.last_message_at = msg.created_at;
          room.last_message_body = msg.body.slice(0, 140);
          room.last_message_kind = msg.kind;
          next.splice(idx, 1);
          next.unshift(room);
          return next;
        });
      });
    })();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [supabase, currentUserId]);

  return <RoomList rooms={rooms} />;
}

"use client";

/**
 * Live room-list state for the whole shell (sidebar + mobile list).
 * Seeded from the server layout's get_my_rooms snapshot; kept live by
 * the global message-INSERT subscription. Fallback refetches cover
 * what realtime can't: rooms created after the snapshot (fresh DMs,
 * new groups, being added by someone else) and long-lived tabs.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  ensureRealtimeAuth,
  subscribeToAllMessageInserts,
} from "@/lib/supabase/realtime";
import type { MyRoom } from "@/lib/types";

type RoomsContextValue = {
  rooms: MyRoom[];
  refetch: () => Promise<void>;
};

const RoomsContext = createContext<RoomsContextValue | null>(null);

export function useRooms() {
  const ctx = useContext(RoomsContext);
  if (!ctx) throw new Error("useRooms must be used inside RoomsProvider");
  return ctx;
}

function activeRoomId(pathname: string): string | null {
  const m = pathname.match(/^\/rooms\/([0-9a-f-]{36})/);
  return m ? m[1] : null;
}

export function RoomsProvider({
  initialRooms,
  currentUserId,
  children,
}: {
  initialRooms: MyRoom[];
  currentUserId: string;
  children: React.ReactNode;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rooms, setRooms] = useState(initialRooms);
  const pathname = usePathname();
  const activeRef = useRef<string | null>(activeRoomId(pathname));
  activeRef.current = activeRoomId(pathname);

  useEffect(() => {
    setRooms(initialRooms);
  }, [initialRooms]);

  const refetch = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_my_rooms");
    if (!error && data) setRooms(data as MyRoom[]);
  }, [supabase]);

  // Live updates from message inserts (RLS-filtered per subscriber).
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
          if (idx < 0) {
            // Room not in the snapshot (e.g. brand-new DM to me) —
            // pull the authoritative list.
            void refetch();
            return prev;
          }
          const next = [...prev];
          const room = { ...next[idx] };
          // The open room is already being read — don't inflate its badge.
          if (room.room_id !== activeRef.current) {
            room.unread_count += 1;
          }
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
  }, [supabase, currentUserId, refetch]);

  // Opening a room zeroes its badge locally (ChatRoom calls
  // mark_room_read server-side); unknown room ids trigger a refetch.
  useEffect(() => {
    const id = activeRoomId(pathname);
    if (!id) return;
    setRooms((prev) => {
      const idx = prev.findIndex((r) => r.room_id === id);
      if (idx < 0) {
        void refetch();
        return prev;
      }
      if (prev[idx].unread_count === 0) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], unread_count: 0 };
      return next;
    });
  }, [pathname, refetch]);

  // Long-lived tabs self-heal on focus (mirrors ChatRoom's pattern).
  useEffect(() => {
    const onFocus = () => void refetch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  const value = useMemo(() => ({ rooms, refetch }), [rooms, refetch]);

  return <RoomsContext.Provider value={value}>{children}</RoomsContext.Provider>;
}

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
  subscribeToMyMembershipChanges,
} from "@/lib/supabase/realtime";
import { installAutoResume, playMessageChime } from "@/lib/call/tones";
import { readNotifyPrefs } from "@/lib/notify-prefs";
import { isRoomMuted, isUserMuted, loadMutes } from "@/lib/mutes";
import { notify } from "@/lib/notify";
import { setTabBadge } from "@/lib/tab-badge";
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
  // A ref mirror so the message-insert handler can look up a room's name
  // for the notification without re-subscribing on every rooms change.
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const prev_find = (id: string) => roomsRef.current.find((r) => r.room_id === id);
  const pathname = usePathname();
  const activeRef = useRef<string | null>(activeRoomId(pathname));
  activeRef.current = activeRoomId(pathname);

  useEffect(() => {
    setRooms(initialRooms);
  }, [initialRooms]);

  const refetch = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_my_rooms");
    if (error || !data) return;
    // The room being read is read by definition: mark_room_read may not
    // have landed yet, and showing a badge on the open room is wrong.
    setRooms(
      (data as MyRoom[]).map((r) =>
        r.room_id === activeRef.current ? { ...r, unread_count: 0 } : r,
      ),
    );
  }, [supabase]);

  // Delivery receipts: tell the server a message reached this device, so
  // the sender's tick turns double. One trailing call per room per burst;
  // deliveredUpTo remembers how far each room has been acknowledged, so the
  // catch-up below never repeats a call that already landed.
  const deliveredUpTo = useRef(new Map<string, number>());
  const deliveredTimers = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );
  const markDelivered = useCallback(
    (roomId: string, messageAt: string) => {
      const t = Date.parse(messageAt);
      if ((deliveredUpTo.current.get(roomId) ?? 0) >= t) return;
      deliveredUpTo.current.set(roomId, t);
      const timers = deliveredTimers.current;
      const pending = timers.get(roomId);
      if (pending) clearTimeout(pending);
      timers.set(
        roomId,
        setTimeout(() => {
          timers.delete(roomId);
          void supabase
            .rpc("mark_room_delivered", { p_room_id: roomId })
            .then(({ error }) => {
              // Forget it so the next message or focus retries.
              if (error) deliveredUpTo.current.delete(roomId);
            });
        }, 400),
      );
    },
    [supabase],
  );

  useEffect(() => {
    const timers = deliveredTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);

  // Catch-up: anything that arrived while this device was offline or the
  // app was closed shows up as unread in the room list.
  useEffect(() => {
    for (const r of rooms) {
      if (r.unread_count > 0 && r.last_message_at) {
        markDelivered(r.room_id, r.last_message_at);
      }
    }
  }, [rooms, markDelivered]);

  // Live updates from message inserts (RLS-filtered per subscriber).
  useEffect(() => {
    let channel: ReturnType<typeof subscribeToAllMessageInserts> | null = null;
    let cancelled = false;

    // The chime needs an unlocked AudioContext; CallProvider installs the
    // same gesture hook, but this provider must not depend on that.
    installAutoResume();

    (async () => {
      await ensureRealtimeAuth(supabase);
      if (cancelled) return;
      channel = subscribeToAllMessageInserts(supabase, (msg) => {
        if (msg.sender_id === currentUserId) return;
        // Only rooms this user belongs to: an admin's subscription also sees
        // rooms they merely oversee, where there is no receipt to give.
        if (msg.sender_id && roomsRef.current.some((r) => r.room_id === msg.room_id)) {
          markDelivered(msg.room_id, msg.created_at);
        }
        // Someone else's message that you are not currently reading:
        // another room, or this room while the tab is hidden/unfocused.
        // System notices ("X joined") stay silent.
        const notLooking =
          msg.room_id !== activeRef.current ||
          document.visibilityState !== "visible" ||
          !document.hasFocus();
        // A muted conversation, or a muted person anywhere, stays silent.
        const muted =
          isRoomMuted(msg.room_id) ||
          Boolean(msg.sender_id && isUserMuted(msg.sender_id));
        if (msg.kind !== "system" && notLooking && !muted) {
          const prefs = readNotifyPrefs();
          const mentions = (msg.metadata as { mentions?: string[] } | null)
            ?.mentions;
          const mentioned =
            Array.isArray(mentions) && mentions.includes(currentUserId);
          // @mentions keep their own switch so muting the room's general
          // sound doesn't silence someone calling you out by name. A room
          // the user muted (isRoomMuted) stays fully silent — no chime and
          // no pop-up — regardless of the global switches.
          if (mentioned ? prefs.mentions : prefs.messages) {
            playMessageChime();
            const room = prev_find(msg.room_id);
            const preview =
              msg.kind === "file" ? "Sent an attachment" : msg.body.slice(0, 140);
            // Desktop/mobile pop-up: notify() only fires when the app is
            // not the focused surface, so it covers another tab, another
            // section, or a backgrounded PWA. No-ops without permission.
            notify({
              title: room?.display_name || "New message",
              body: preview,
              tag: `room:${msg.room_id}`,
              url: `/rooms/${msg.room_id}`,
            });
          }
        }
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
          // We don't know the new sender's name here; keeping the old one
          // would label this message with the previous speaker.
          room.last_message_sender = null;
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
  }, [supabase, currentUserId, refetch, markDelivered]);

  // Being added to or removed from a room produces no message the current
  // list would notice, and room_members is not something the message
  // subscription sees. Watch this user's own membership rows and pull the
  // authoritative list when one appears or disappears.
  //
  // This user's own delivered stamps land here too, once per incoming
  // burst. Only a read (on this or another device) changes the badges, so an
  // UPDATE that leaves last_read_at where it was needs no refetch.
  const lastReadSeen = useRef(new Map<string, string>());
  useEffect(() => {
    let channel: ReturnType<typeof subscribeToMyMembershipChanges> | null = null;
    let cancelled = false;
    (async () => {
      await ensureRealtimeAuth(supabase);
      if (cancelled) return;
      channel = subscribeToMyMembershipChanges(
        supabase,
        currentUserId,
        ({ eventType, row }) => {
          if (eventType === "UPDATE" && row.room_id) {
            const readAt = row.last_read_at ?? "";
            if (lastReadSeen.current.get(row.room_id) === readAt) return;
            lastReadSeen.current.set(row.room_id, readAt);
          }
          void refetch();
        },
      );
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

  // Mutes are per person and shared across devices; load them once here,
  // the one provider every signed-in screen sits under.
  useEffect(() => {
    void loadMutes();
  }, []);

  // Long-lived tabs self-heal on focus (mirrors ChatRoom's pattern), which
  // also picks up mutes changed on another device.
  useEffect(() => {
    const onFocus = () => {
      void refetch();
      void loadMutes();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetch]);

  // #9 Browser-tab unread indicator: title prefix + favicon dot. Cleared
  // automatically as the unread count returns to zero (rooms marked read).
  useEffect(() => {
    setTabBadge(rooms.reduce((n, r) => n + r.unread_count, 0));
  }, [rooms]);

  const value = useMemo(() => ({ rooms, refetch }), [rooms, refetch]);

  return <RoomsContext.Provider value={value}>{children}</RoomsContext.Provider>;
}

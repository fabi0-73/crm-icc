"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  ensureRealtimeAuth,
  subscribeToAllMessageInserts,
} from "@/lib/supabase/realtime";
import {
  requestDesktopNotifications,
  showDesktopNotification,
} from "@/lib/notifications";
import { useMutes } from "@/components/mute/MuteProvider";

function activeRoomId(pathname: string): string | null {
  const m = pathname.match(/^\/rooms\/([0-9a-f-]{36})/);
  return m ? m[1] : null;
}

/** OS/browser pop-ups for new messages when the chat is not on screen. */
export function NotificationProvider({
  userId,
  children,
}: {
  userId: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const { isRoomMuted, isUserMuted } = useMutes();

  useEffect(() => {
    const ask = () => requestDesktopNotifications();
    window.addEventListener("pointerdown", ask, { once: true, capture: true });
    return () => window.removeEventListener("pointerdown", ask, true);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof subscribeToAllMessageInserts> | null = null;
    (async () => {
      await ensureRealtimeAuth(supabase);
      if (cancelled) return;
      channel = subscribeToAllMessageInserts(supabase, (msg) => {
        if (msg.sender_id === userId || msg.kind === "system") return;
        if (isRoomMuted(msg.room_id)) return;
        if (msg.sender_id && isUserMuted(msg.sender_id)) return;
        const openRoom = activeRoomId(pathname);
        const lookingAtRoom =
          openRoom === msg.room_id &&
          document.visibilityState === "visible" &&
          document.hasFocus();
        if (lookingAtRoom) return;
        const preview =
          msg.kind === "file"
            ? msg.metadata?.voice === true || msg.body === "Voice message"
              ? "Voice message"
              : "Sent an attachment"
            : msg.body.slice(0, 140);
        showDesktopNotification("ICC Desk", preview, {
          tag: `msg:${msg.room_id}`,
        });
      });
    })();
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userId, pathname, isRoomMuted, isUserMuted]);

  return <>{children}</>;
}

"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { ensureRealtimeAuth } from "@/lib/supabase/realtime";

const PresenceContext = createContext<ReadonlySet<string>>(new Set());

/** One presence channel per tab; presence key = userId collapses a
 *  user's multiple tabs into a single online entry. */
export function PresenceProvider({
  userId,
  children,
}: {
  userId: string;
  children: React.ReactNode;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    (async () => {
      await ensureRealtimeAuth(supabase);
      if (cancelled) return;
      channel = supabase.channel("presence:global", {
        config: { presence: { key: userId } },
      });
      channel
        .on("presence", { event: "sync" }, () => {
          const state = channel!.presenceState<{ user_id: string }>();
          setOnline(new Set(Object.values(state).flat().map((m) => m.user_id)));
        })
        .subscribe(async (status) => {
          if (status === "SUBSCRIBED") {
            await channel!.track({ user_id: userId });
          }
        });
    })();

    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [supabase, userId]);

  return (
    <PresenceContext.Provider value={online}>
      {children}
    </PresenceContext.Provider>
  );
}

export const useOnlineUsers = () => useContext(PresenceContext);

export function useIsOnline(id?: string | null) {
  const s = useContext(PresenceContext);
  return !!id && s.has(id);
}

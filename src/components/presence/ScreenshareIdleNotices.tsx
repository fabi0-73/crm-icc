"use client";

/**
 * Shown only to admins and managers, and only on top of a screenshare
 * that is already on screen. Names someone in that share who has had no
 * mouse or keyboard input. The card leaves after a few seconds, or when
 * its X is pressed. Nothing is mounted for anyone else, or outside the call.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { X } from "lucide-react";
import { useCall } from "@/components/call/CallProvider";
import { createClient } from "@/lib/supabase/client";
import { ensureRealtimeAuth } from "@/lib/supabase/realtime";
import { DIALER_IDLE_LABEL } from "@/lib/dialer-idle";

const SHOW_MS = 5000;

type ActivityRow = { user_id: string; away: boolean };
type Card = { id: string; name: string; body: string };

export function ScreenshareIdleNotices({ compact = false }: { compact?: boolean }) {
  const { selfId, userRole, phase, call, sharing, groupPeers, remoteHasVideo } = useCall();
  const supervisor = userRole === "admin" || userRole === "manager";
  const supabase = useMemo(() => createClient(), []);
  const [cards, setCards] = useState<Card[]>([]);
  const shownAway = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const sharers = useMemo(() => {
    const map = new Map<string, string>();
    if (!call || phase !== "in-call") return map;
    const shareOn =
      sharing ||
      groupPeers.some((peer) => peer.sharing) ||
      Boolean(!call.group && !call.video && remoteHasVideo);
    if (!shareOn) return map;
    if (call.group) {
      for (const peer of groupPeers) {
        if (peer.id !== selfId) map.set(peer.id, peer.name);
      }
      return map;
    }
    if (call.peerId && call.peerId !== selfId) map.set(call.peerId, call.peerName);
    return map;
  }, [call, phase, groupPeers, selfId, sharing, remoteHasVideo]);

  const sharersRef = useRef(sharers);
  sharersRef.current = sharers;
  const inShare = sharers.size > 0;

  const dismiss = (id: string) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setCards((prev) => prev.filter((card) => card.id !== id));
  };

  const show = (name: string, body: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setCards((prev) => [...prev, { id, name, body }]);
    const timer = setTimeout(() => dismiss(id), SHOW_MS);
    timers.current.set(id, timer);
  };

  useEffect(() => {
    if (!supervisor || !inShare) return;
    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    const apply = (row: ActivityRow, announceBack: boolean) => {
      if (!row?.user_id || !sharersRef.current.has(row.user_id)) return;
      const name = sharersRef.current.get(row.user_id) || "Someone";
      if (row.away) {
        if (shownAway.current.has(row.user_id)) return;
        shownAway.current.add(row.user_id);
        show(name, `No mouse or keyboard activity for ${DIALER_IDLE_LABEL}`);
        return;
      }
      if (!shownAway.current.has(row.user_id)) return;
      shownAway.current.delete(row.user_id);
      if (announceBack) show(name, "Back at their computer");
    };

    (async () => {
      const { data } = await supabase
        .from("dialer_activity")
        .select("user_id, away")
        .eq("away", true);
      if (cancelled) return;
      for (const row of (data ?? []) as ActivityRow[]) apply(row, false);

      await ensureRealtimeAuth(supabase);
      if (cancelled) return;
      channel = supabase
        .channel("screenshare-idle")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "dialer_activity" },
          (payload) => {
            if (cancelled) return;
            apply(payload.new as ActivityRow, true);
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
      setCards([]);
      if (channel) void supabase.removeChannel(channel);
    };
    // show/dismiss close over the latest sharer map via sharersRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supervisor, inShare, supabase]);

  useEffect(() => {
    for (const id of [...shownAway.current]) {
      if (!sharers.has(id)) shownAway.current.delete(id);
    }
  }, [sharers]);

  if (!supervisor || cards.length === 0) return null;

  return (
    <div
      className={
        compact
          ? "absolute inset-x-1 top-1 z-30 flex flex-col gap-1"
          : "absolute right-4 top-20 z-30 flex w-72 flex-col gap-2"
      }
    >
      {cards.map((card) => (
        <div
          key={card.id}
          role="status"
          className="pointer-events-auto flex items-start gap-2 rounded-xl bg-ink/95 px-3 py-2.5 text-white shadow-lg ring-1 ring-white/15"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-semibold leading-tight">{card.name}</p>
            <p className="mt-0.5 text-[12px] leading-snug text-white/70">{card.body}</p>
          </div>
          <button
            type="button"
            onClick={() => dismiss(card.id)}
            aria-label="Close"
            className="rounded-full p-0.5 text-white/70 hover:bg-white/15 hover:text-white"
          >
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

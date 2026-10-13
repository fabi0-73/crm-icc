"use client";

/**
 * Admin-only. Lists dialers whose CRM session has had no mouse or
 * keyboard input for 5 minutes, and raises a desktop notification when
 * someone newly goes away. Other roles never mount this.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { ensureRealtimeAuth } from "@/lib/supabase/realtime";
import { notify } from "@/lib/notify";
import { DIALER_IDLE_LABEL } from "@/lib/dialer-idle";

type ActivityRow = {
  user_id: string;
  away: boolean;
};

type BackNotice = { id: string; name: string };

export function AdminAwayNotices() {
  const supabase = useMemo(() => createClient(), []);
  const [away, setAway] = useState<Map<string, string>>(new Map());
  const [backs, setBacks] = useState<BackNotice[]>([]);
  const namesRef = useRef<Map<string, string>>(new Map());
  const readyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    const backTimers = new Set<ReturnType<typeof setTimeout>>();

    const nameOf = async (userId: string) => {
      const cached = namesRef.current.get(userId);
      if (cached) return cached;
      const { data } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", userId)
        .maybeSingle();
      const name = data?.full_name?.trim() || "A dialer";
      namesRef.current.set(userId, name);
      return name;
    };

    const apply = async (row: ActivityRow, announce: boolean) => {
      if (!row?.user_id) return;
      const name = await nameOf(row.user_id);
      if (cancelled) return;
      if (row.away) {
        let already = false;
        setAway((prev) => {
          already = prev.has(row.user_id);
          if (already) return prev;
          const next = new Map(prev);
          next.set(row.user_id, name);
          return next;
        });
        if (announce && !already) {
          notify({
            title: "Dialer inactive",
            body: `${name} has had no mouse or keyboard activity for ${DIALER_IDLE_LABEL}`,
            tag: `idle-${row.user_id}`,
          });
        }
        return;
      }
      let wasAway = false;
      setAway((prev) => {
        wasAway = prev.has(row.user_id);
        if (!wasAway) return prev;
        const next = new Map(prev);
        next.delete(row.user_id);
        return next;
      });
      if (announce && wasAway) {
        const id = `${row.user_id}-${Date.now()}`;
        setBacks((prev) => [...prev, { id, name }]);
        const timer = setTimeout(() => {
          backTimers.delete(timer);
          setBacks((prev) => prev.filter((b) => b.id !== id));
        }, 4000);
        backTimers.add(timer);
      }
    };

    (async () => {
      const { data } = await supabase
        .from("dialer_activity")
        .select("user_id, away")
        .eq("away", true);
      if (cancelled) return;
      for (const row of (data ?? []) as ActivityRow[]) {
        await apply(row, false);
      }
      readyRef.current = true;

      await ensureRealtimeAuth(supabase);
      if (cancelled) return;
      channel = supabase
        .channel("admin-dialer-idle")
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "dialer_activity" },
          (payload) => {
            const row = payload.new as ActivityRow;
            void apply(row, readyRef.current);
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      for (const timer of backTimers) clearTimeout(timer);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [supabase]);

  if (away.size === 0 && backs.length === 0) return null;

  return (
    <div className="fixed top-3 right-3 z-[140] flex w-72 flex-col gap-2">
      {[...away.entries()].map(([id, name]) => (
        <div key={id} className="rounded-xl bg-ink px-3 py-2.5 text-white shadow-lg">
          <p className="text-[13px] font-semibold leading-tight">{name}</p>
          <p className="mt-0.5 text-[12px] text-white/70">
            No mouse or keyboard activity for {DIALER_IDLE_LABEL}
          </p>
        </div>
      ))}
      {backs.map((b) => (
        <div
          key={b.id}
          role="status"
          className="rounded-xl bg-ink px-3 py-2.5 text-white shadow-lg"
        >
          <p className="text-[13px] font-semibold leading-tight">{b.name}</p>
          <p className="mt-0.5 text-[12px] text-white/70">Back at their computer</p>
        </div>
      ))}
    </div>
  );
}

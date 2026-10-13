"use client";

/**
 * Silent for the person using it. While a screenshare is up in their
 * call, this tab watches mouse and keyboard input and, after
 * DIALER_IDLE_MS with none, reports them away. Leaving that share
 * clears it. People outside the screenshare are never reported.
 */

import { useEffect, useMemo, useRef } from "react";
import { useCall } from "@/components/call/CallProvider";
import { createClient } from "@/lib/supabase/client";
import { DIALER_IDLE_MS } from "@/lib/dialer-idle";

const INPUT_KEY = "icc-dialer-last-input";
const SHARE_KEY = "icc-screenshare-alive";
const CHECK_MS = 10_000;

export function DialerIdleReporter() {
  const { sharing, groupPeers, call, phase, remoteHasVideo } = useCall();
  const inScreenshare =
    phase === "in-call" &&
    (sharing ||
      groupPeers.some((peer) => peer.sharing) ||
      Boolean(call && !call.group && !call.video && remoteHasVideo));
  const supabase = useMemo(() => createClient(), []);
  const tabId = useRef(
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : String(Math.random()),
  );

  useEffect(() => {
    if (!inScreenshare) return;
    let cancelled = false;
    const away = { current: false };
    const last = { current: Date.now() };

    const beat = () => {
      try {
        localStorage.setItem(
          SHARE_KEY,
          JSON.stringify({ tab: tabId.current, t: Date.now() }),
        );
      } catch {
        /* private mode */
      }
    };
    const clearBeat = () => {
      try {
        const raw = localStorage.getItem(SHARE_KEY);
        const cur = raw ? (JSON.parse(raw) as { tab?: string }) : null;
        if (cur?.tab === tabId.current) localStorage.removeItem(SHARE_KEY);
      } catch {
        /* private mode */
      }
    };

    const report = async (next: boolean) => {
      if (cancelled || away.current === next) return;
      const { error } = await supabase.rpc("report_dialer_activity", { p_away: next });
      if (cancelled) return;
      if (error) {
        console.warn("dialer activity", error.message);
        return;
      }
      away.current = next;
    };

    beat();
    try {
      localStorage.setItem(INPUT_KEY, String(Date.now()));
    } catch {
      /* private mode */
    }

    let lastWrite = 0;
    const onInput = () => {
      const now = Date.now();
      last.current = now;
      if (now - lastWrite > 2000) {
        lastWrite = now;
        try {
          localStorage.setItem(INPUT_KEY, String(now));
        } catch {
          /* private mode */
        }
      }
      if (away.current) void report(false);
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key !== INPUT_KEY || !e.newValue) return;
      const t = Number(e.newValue);
      if (Number.isFinite(t) && t > last.current) last.current = t;
      if (away.current) void report(false);
    };

    const opts: AddEventListenerOptions = { capture: true, passive: true };
    const events = ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"] as const;
    for (const name of events) window.addEventListener(name, onInput, opts);
    window.addEventListener("storage", onStorage);

    const timer = window.setInterval(() => {
      beat();
      let stored = 0;
      try {
        stored = Number(localStorage.getItem(INPUT_KEY) || 0);
      } catch {
        stored = 0;
      }
      const seen = Math.max(last.current, Number.isFinite(stored) ? stored : 0);
      if (Date.now() - seen >= DIALER_IDLE_MS) void report(true);
    }, CHECK_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const name of events) window.removeEventListener(name, onInput, opts);
      window.removeEventListener("storage", onStorage);
      clearBeat();
      if (away.current) {
        void supabase.rpc("report_dialer_activity", { p_away: false });
      }
    };
  }, [inScreenshare, supabase]);

  return null;
}

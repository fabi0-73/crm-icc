"use client";

/**
 * Silent for the person using it. An assistant's open CRM tab watches
 * mouse and keyboard input; after DIALER_IDLE_MS with none, it reports
 * away. Coming back reports active. Nothing is rendered — admins are
 * the only role that can read the row.
 *
 * Input in any tab counts (a shared timestamp), so working in a second
 * chat tab does not look like being away.
 */

import { useEffect, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { DIALER_IDLE_MS } from "@/lib/dialer-idle";

const STORAGE_KEY = "icc-dialer-last-input";
const CHECK_MS = 10_000;

export function DialerIdleReporter() {
  const supabase = useMemo(() => createClient(), []);
  const lastRef = useRef(Date.now());
  const awayRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const report = async (away: boolean) => {
      if (cancelled || awayRef.current === away) return;
      const { error } = await supabase.rpc("report_dialer_activity", {
        p_away: away,
      });
      if (cancelled) return;
      if (error) {
        console.warn("dialer activity", error.message);
        return;
      }
      awayRef.current = away;
    };

    const noteInput = () => {
      const now = Date.now();
      lastRef.current = now;
      try {
        localStorage.setItem(STORAGE_KEY, String(now));
      } catch {
        /* private mode */
      }
      if (awayRef.current) void report(false);
    };

    let lastWrite = 0;
    const onInput = () => {
      const now = Date.now();
      lastRef.current = now;
      if (now - lastWrite > 2000) {
        lastWrite = now;
        try {
          localStorage.setItem(STORAGE_KEY, String(now));
        } catch {
          /* private mode */
        }
      }
      if (awayRef.current) void report(false);
    };

    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      const t = Number(e.newValue);
      if (Number.isFinite(t) && t > lastRef.current) lastRef.current = t;
      if (awayRef.current) void report(false);
    };

    noteInput();
    void report(false);

    const opts: AddEventListenerOptions = { capture: true, passive: true };
    const events = ["pointerdown", "keydown", "wheel", "touchstart", "mousemove"] as const;
    for (const name of events) window.addEventListener(name, onInput, opts);
    window.addEventListener("storage", onStorage);

    const timer = window.setInterval(() => {
      let stored = 0;
      try {
        stored = Number(localStorage.getItem(STORAGE_KEY) || 0);
      } catch {
        stored = 0;
      }
      const last = Math.max(lastRef.current, Number.isFinite(stored) ? stored : 0);
      if (Date.now() - last >= DIALER_IDLE_MS) void report(true);
    }, CHECK_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const name of events) window.removeEventListener(name, onInput, opts);
      window.removeEventListener("storage", onStorage);
    };
  }, [supabase]);

  return null;
}

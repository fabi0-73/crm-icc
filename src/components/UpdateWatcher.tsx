"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useCall } from "@/components/call/CallProvider";

const CHECK_EVERY_MS = 5 * 60_000;
/** The build a tab has already reloaded itself for, so a wrong answer can
 *  never turn into a reload loop. */
const RELOADED_FOR_KEY = "icc:reloaded-for-build";

/** Anything typed that a reload would throw away (the app keeps no drafts). */
function hasUnsentInput(): boolean {
  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "textarea, input:not([type=hidden]):not([type=checkbox]):not([type=radio])",
  );
  return [...fields].some((f) => f.value !== f.defaultValue);
}

/**
 * Keeps long-lived tabs on the current version. Moving around inside the app
 * never reloads its code, so after a deploy a tab kept running the old build
 * until someone happened to reload (2026-09-19: testers still hit the removed
 * one-share limit an hour after the fix shipped).
 *
 * The tab learns which build it started on from the FIRST answer /api/version
 * gives it, and only calls itself stale when a later answer differs. It must
 * not compare a constant baked into the browser bundle against one baked into
 * the server bundle: next.config is evaluated once per compilation, so those
 * two are minted seconds apart and never match. That is what the first
 * version did, which left every tab permanently "stale" — showing a banner
 * that no reload could clear, and silently reloading itself every time it was
 * backgrounded (2026-09-19 to 2026-09-23, a reload per tab switch for
 * everyone).
 *
 * Checks when the tab comes back into view and every few minutes. A newer
 * build reloads the tab on its own only while nobody is looking at it — never
 * during a call, never over something typed and unsent, and at most once per
 * tab per build; otherwise a small banner offers the reload.
 */
export function UpdateWatcher() {
  const { phase, lobby } = useCall();
  const busy = phase !== "idle" || Boolean(lobby);
  const [stale, setStale] = useState(false);
  /** The build the server was running when this tab started. */
  const startedOn = useRef<string | null>(null);
  /** The newer build that made this tab stale. */
  const newest = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { buildId } = (await res.json()) as { buildId?: string | null };
        if (stopped || !buildId) return;
        if (startedOn.current === null) {
          startedOn.current = buildId;
          return;
        }
        if (buildId !== startedOn.current) {
          newest.current = buildId;
          setStale(true);
        }
      } catch {
        /* offline or mid-deploy — try again later */
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    void check();
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    if (!stale || busy) return;
    const reloadIfUnseen = () => {
      if (document.visibilityState !== "hidden" || hasUnsentInput()) return;
      const target = newest.current;
      if (!target) return;
      // One automatic reload per tab per build. Without this, anything that
      // makes `stale` wrong reloads the tab on every single tab switch.
      try {
        if (sessionStorage.getItem(RELOADED_FOR_KEY) === target) return;
        sessionStorage.setItem(RELOADED_FOR_KEY, target);
      } catch {
        // Can't remember having done it, so don't risk doing it repeatedly.
        // The banner still offers the reload.
        return;
      }
      window.location.reload();
    };
    reloadIfUnseen();
    document.addEventListener("visibilitychange", reloadIfUnseen);
    return () => document.removeEventListener("visibilitychange", reloadIfUnseen);
  }, [stale, busy]);

  if (!stale) return null;
  return (
    <div
      role="status"
      className="fixed left-1/2 top-[max(0.5rem,env(safe-area-inset-top))] z-[140] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-line/70 bg-paper py-1.5 pl-4 pr-1.5 shadow-lg"
    >
      <span className="truncate text-[13px] text-ink">
        {busy ? "Update ready — reload after your call" : "A new version is ready"}
      </span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-brand-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-brand-700"
      >
        <RefreshCw className="size-3.5" />
        Reload
      </button>
    </div>
  );
}

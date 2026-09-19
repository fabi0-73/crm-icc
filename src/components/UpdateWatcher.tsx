"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useCall } from "@/components/call/CallProvider";

/** The build this tab loaded (inlined at build time, see next.config.ts). */
const LOADED_BUILD = process.env.NEXT_PUBLIC_BUILD_ID;
const CHECK_EVERY_MS = 5 * 60_000;

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
 * Checks /api/version when the tab comes back into view and every few
 * minutes. A newer build reloads the tab on its own only while nobody is
 * looking at it — never during a call, never over something typed and unsent;
 * otherwise a small banner offers the reload.
 */
export function UpdateWatcher() {
  const { phase, lobby } = useCall();
  const busy = phase !== "idle" || Boolean(lobby);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (!LOADED_BUILD) return;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        const { buildId } = (await res.json()) as { buildId?: string | null };
        if (!stopped && buildId && buildId !== LOADED_BUILD) setStale(true);
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
      if (document.visibilityState === "hidden" && !hasUnsentInput()) {
        window.location.reload();
      }
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

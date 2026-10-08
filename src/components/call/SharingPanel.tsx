"use client";

import { MonitorUp } from "lucide-react";

/**
 * Stands in for the sharer's own screen. A live preview of the screen being
 * shared is drawn ON that screen whenever the call window is visible, so
 * every frame changes the next one: the browser can never skip an unchanged
 * frame and the laptop captures and encodes nonstop (with the CPU cost of
 * painting the preview on top). Without it, a still screen costs next to
 * nothing.
 */
export function SharingPanel({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-ink-soft px-2 text-center text-white">
      <MonitorUp
        className={size === "sm" ? "size-4" : size === "md" ? "size-6" : "size-9"}
        aria-hidden
      />
      {size !== "sm" && (
        <span className={size === "lg" ? "text-[15px] font-medium" : "text-[12px] font-medium"}>
          You are sharing your screen
        </span>
      )}
    </div>
  );
}

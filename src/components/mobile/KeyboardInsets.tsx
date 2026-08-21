"use client";

import { useEffect } from "react";

/**
 * Keeps the `--vvh` CSS variable (used by the `h-app` utility) in sync
 * with the visual viewport. On iOS Safari the on-screen keyboard
 * OVERLAYS the layout viewport instead of resizing it, so `100dvh`
 * leaves the composer hidden behind the keyboard; sizing the shell to
 * `visualViewport.height` keeps it visible. Android (and Capacitor)
 * resize the layout viewport themselves, so the variable stays unset
 * there and `100dvh` wins.
 */
export function KeyboardInsets() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;

    const update = () => {
      const gap = window.innerHeight - vv.height;
      // Only a keyboard produces a large gap; toolbar collapse is small.
      if (gap > 80) {
        root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
        // Safari sometimes scrolls the layout viewport when focusing —
        // pin it back so the fixed-height shell stays aligned.
        window.scrollTo(0, 0);
      } else {
        root.style.removeProperty("--vvh");
      }
    };

    vv.addEventListener("resize", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      root.style.removeProperty("--vvh");
    };
  }, []);

  return null;
}

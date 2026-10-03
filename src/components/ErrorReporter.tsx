"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-errors";

/** Uncaught errors outside React's render (timers, events, promises) go to
 *  the server log too — a call or realtime callback can fail there. */
export function ErrorReporter() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      // Harmless browser chatter, not a crash.
      if (/ResizeObserver loop/.test(e.message)) return;
      reportClientError(e.error ?? e.message, "window.error");
    };
    const onRejection = (e: PromiseRejectionEvent) =>
      reportClientError(e.reason, "unhandledrejection");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}

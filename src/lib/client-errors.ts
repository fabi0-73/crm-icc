/**
 * Browser crashes, sent to the server log (journalctl -u crm-icc | grep
 * client-error). Before this, "Application error: a client-side exception"
 * on someone's laptop left nothing behind to trace.
 *
 * Fire-and-forget (sendBeacon survives the page being reloaded or closed),
 * at most a few per page, and the same message only once.
 */
const MAX_PER_PAGE = 5;
const sent = new Set<string>();

export function reportClientError(error: unknown, where: string) {
  if (typeof window === "undefined") return;
  const err =
    error instanceof Error
      ? error
      : new Error(typeof error === "string" ? error : JSON.stringify(error ?? null));
  const key = `${where}|${err.message}`;
  if (sent.has(key) || sent.size >= MAX_PER_PAGE) return;
  sent.add(key);
  const body = JSON.stringify({
    where,
    message: err.message.slice(0, 500),
    stack: (err.stack ?? "").slice(0, 2500),
    digest: (err as Error & { digest?: string }).digest,
    url: location.pathname,
    build: process.env.APP_BUILD_ID ?? null,
    ua: navigator.userAgent.slice(0, 200),
    memory:
      (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? null,
  });
  try {
    if (!navigator.sendBeacon?.("/api/client-error", new Blob([body], { type: "application/json" }))) {
      void fetch("/api/client-error", { method: "POST", body, keepalive: true }).catch(() => undefined);
    }
  } catch {
    /* reporting must never throw */
  }
}

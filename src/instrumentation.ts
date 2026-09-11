/**
 * Next.js instrumentation — runs once per server instance at startup.
 *
 * We use it to boot the Web Push sender (a realtime subscriber that pushes
 * message/call alerts to closed apps). It must run only in the Node.js server
 * runtime, never the edge runtime, and the web-push import is dynamic so it is
 * never pulled into an edge bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPushSender } = await import("./lib/push/sender");
    startPushSender();
  }
}

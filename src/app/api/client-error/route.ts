/**
 * Receives browser crash reports (see lib/client-errors.ts) and writes one
 * line each to the server log. Excluded from the middleware so a crash on
 * the login page reports too. Unauthenticated, so: small bodies only, and a
 * global cap per minute so nobody can flood the log.
 */
export const dynamic = "force-dynamic";

const PER_MINUTE = 60;
let windowStart = 0;
let count = 0;

const clip = (v: unknown, n: number) =>
  String(v ?? "").replace(/[\r\n]+/g, " ⏎ ").slice(0, n);

export async function POST(req: Request) {
  const now = Date.now();
  if (now - windowStart > 60_000) {
    windowStart = now;
    count = 0;
  }
  if (++count > PER_MINUTE) return new Response(null, { status: 204 });

  const text = (await req.text()).slice(0, 8_000);
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response(null, { status: 204 });
  }
  const mb = typeof r.memory === "number" ? ` heap=${Math.round(r.memory / 1e6)}MB` : "";
  console.error(
    `[client-error] ${clip(r.where, 40)} ${clip(r.url, 120)} build=${clip(r.build, 12)}${mb}` +
      ` | ${clip(r.message, 500)} | ${clip(r.ua, 200)} | ${clip(r.stack, 2500)}`,
  );
  return new Response(null, { status: 204 });
}

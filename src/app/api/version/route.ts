/**
 * The build this server is running. Open tabs read it when they start and
 * compare later answers against that first one (see UpdateWatcher) to notice
 * a newer deploy. Excluded from the middleware, so polling it costs no
 * session lookup.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { buildId: process.env.APP_BUILD_ID ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

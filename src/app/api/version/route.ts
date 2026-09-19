/**
 * The build this server is running. Open tabs compare it with the build they
 * loaded (see UpdateWatcher) to notice a newer deploy. Excluded from the
 * middleware, so polling it costs no session lookup.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sitePath } from "@/lib/site-url";

/**
 * Drops the session cookies and returns to the login page.
 * A Route Handler (unlike a Server Component) may write cookies, so this
 * is the only place a session that is valid to Supabase but unusable to
 * the app — deactivated profile, deleted profile row — can be cleared.
 * Without it those users bounce between /rooms and /login forever.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });

  const reason = new URL(request.url).searchParams.get("reason");
  const query = reason === "inactive" ? "?error=deactivated" : "";
  return NextResponse.redirect(sitePath(`/login${query}`, request.headers));
}

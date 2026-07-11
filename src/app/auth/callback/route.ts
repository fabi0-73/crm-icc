import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sitePath } from "@/lib/site-url";

/** Handles email magic-link / invite / recovery redirects. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/auth/reset-password";
  const dest = next.startsWith("/") ? next : "/auth/reset-password";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(sitePath(dest, request.headers));
    }
  }

  return NextResponse.redirect(sitePath("/login?error=auth", request.headers));
}

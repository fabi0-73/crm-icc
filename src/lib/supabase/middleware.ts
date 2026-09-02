import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { sitePath } from "@/lib/site-url";

// Everything else needs a session. /auth/signout is deliberately NOT
// here: it runs with the (still valid) session it is about to clear.
const PUBLIC_PATHS = ["/login"];

function isPublic(pathname: string) {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

function supabaseConfigured() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  return (
    url.length > 0 &&
    key.length > 0 &&
    !url.includes("YOUR-PROJECT-REF") &&
    key !== "your-anon-key"
  );
}

function redirectPublic(request: NextRequest, path: string) {
  return NextResponse.redirect(sitePath(path, request.headers));
}

/**
 * Keep middleware light: refresh the session cookie and gate login only.
 * Role checks / agent redirects live in pages (RLS is the real enforcement).
 */
export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!supabaseConfigured()) {
    if (pathname === "/login") return NextResponse.next({ request });
    return redirectPublic(request, "/login?error=config");
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(
          cookiesToSet: {
            name: string;
            value: string;
            options?: Record<string, unknown>;
          }[],
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublic(pathname)) {
    const next = encodeURIComponent(pathname);
    return redirectPublic(request, `/login?next=${next}`);
  }

  if (user && pathname === "/login") {
    return redirectPublic(request, "/rooms");
  }

  return response;
}

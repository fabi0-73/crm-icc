/**
 * Public origin for redirects behind nginx.
 * Never use Next's internal listen URL (http://localhost:3010 / 127.0.0.1).
 */
export function getSiteOrigin(headersList?: Headers | null): string {
  const site = (process.env.NEXT_PUBLIC_SITE_URL || "").replace(/\/$/, "");

  if (headersList) {
    const host = (
      headersList.get("x-forwarded-host") ||
      headersList.get("host") ||
      ""
    )
      .split(",")[0]
      .trim();

    const isLoopback =
      !host ||
      host.startsWith("localhost") ||
      host.startsWith("127.0.0.1") ||
      host.startsWith("[::1]");

    if (!isLoopback) {
      const proto = (
        headersList.get("x-forwarded-proto") ||
        (host.includes("iccdesk.duckdns.org") ? "https" : "http")
      )
        .split(",")[0]
        .trim();
      return `${proto}://${host}`;
    }
  }

  return site || "https://iccdesk.duckdns.org";
}

export function sitePath(path: string, headersList?: Headers | null): string {
  const origin = getSiteOrigin(headersList);
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${p}`;
}

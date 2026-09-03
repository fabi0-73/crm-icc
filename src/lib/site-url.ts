/**
 * Public origin for redirects behind nginx.
 * Never use Next's internal listen URL (http://localhost:3010 / 127.0.0.1).
 */

/**
 * Hostnames nginx terminates TLS for. Only consulted when a proxy fails to
 * send x-forwarded-proto; the first entry is the canonical one.
 */
const PUBLIC_HOSTS = ["chat.icenterconsult.com", "iccdesk.duckdns.org"];

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
        (PUBLIC_HOSTS.some((h) => host.includes(h)) ? "https" : "http")
      )
        .split(",")[0]
        .trim();
      return `${proto}://${host}`;
    }
  }

  return site || `https://${PUBLIC_HOSTS[0]}`;
}

export function sitePath(path: string, headersList?: Headers | null): string {
  const origin = getSiteOrigin(headersList);
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${p}`;
}

import type { NextConfig } from "next";

// One id per build, inlined into both the server and the browser bundle: an
// open tab compares its own with /api/version to notice a newer deploy and
// update itself (components/UpdateWatcher). next.config is evaluated again by
// `next start`, but `env` values are fixed into the code at build time.
const buildId = process.env.BUILD_ID || `b${Date.now().toString(36)}`;

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
  // web-push relies on Node built-ins and dynamic requires — keep it external
  // to the server bundle so the instrumentation sender loads it cleanly.
  serverExternalPackages: ["web-push"],
  // Keep soft-navigated pages warm so tab switches feel instant.
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
};

export default nextConfig;

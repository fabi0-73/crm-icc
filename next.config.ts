import type { NextConfig } from "next";

// One id per build, served by /api/version so an open tab can notice a newer
// deploy and update itself (components/UpdateWatcher).
//
// It is deliberately NOT exposed to the browser. next.config is evaluated
// once per compilation, so a value minted here reaches the browser bundle and
// the server bundle seconds apart and the two never match — comparing those
// constants left every tab permanently "stale" (2026-09-19 to 2026-09-23).
// The browser now learns the build from /api/version at runtime instead.
//
// scripts/deploy.sh sets BUILD_ID to the deployed commit, which also makes
// /api/version answer "what is live?"; the timestamp is a local fallback.
const buildId = process.env.BUILD_ID || `b${Date.now().toString(36)}`;

const nextConfig: NextConfig = {
  env: { APP_BUILD_ID: buildId },
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

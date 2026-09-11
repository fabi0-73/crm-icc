import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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

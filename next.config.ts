import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep soft-navigated pages warm so tab switches feel instant.
  experimental: {
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
};

export default nextConfig;

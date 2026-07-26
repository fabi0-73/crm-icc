import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.iccdesk.app",
  appName: "ICC Desk",
  // Placeholder web assets; the shell loads the production app remotely.
  webDir: "mobile/www",
  server: {
    url: "https://iccdesk.duckdns.org",
    // Shown when the remote app fails to load (offline, server down).
    errorPath: "error.html",
  },
  ios: {
    contentInset: "automatic",
  },
};

export default config;

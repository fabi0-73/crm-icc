"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/client-errors";

/**
 * A crash outside every page's own error screen (the app shell: sidebar,
 * calls) used to leave Next's bare "Application error: a client-side
 * exception has occurred". This replaces it with a way back, and sends the
 * error to the server log. It replaces the root layout, so it brings its
 * own <html> and plain inline styles.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error, "global-error");
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#16181d",
          color: "#f3f4f6",
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          textAlign: "center",
          padding: 24,
        }}
      >
        <div>
          <p style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
            Something went wrong
          </p>
          <p style={{ fontSize: 14, opacity: 0.7, margin: "8px 0 20px" }}>
            The error has been reported. Reloading usually fixes it.
          </p>
          <button
            type="button"
            onClick={() => location.reload()}
            style={{
              height: 40,
              padding: "0 20px",
              borderRadius: 999,
              border: 0,
              background: "#0f766e",
              color: "#fff",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}

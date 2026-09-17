"use client";

import { useEffect, useState } from "react";

export type SignFn = (path: string) => Promise<string | null>;

/**
 * Signs the object as soon as the bubble renders. File attachments are
 * opened through a plain <a>: signing inside the click handler leaves the
 * user gesture behind, and mobile Safari then blocks the window silently.
 */
export function useSignedUrl(path: string | null, sign: SignFn) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setFailed(false);
    void sign(path)
      .then((signed) => {
        if (cancelled) return;
        if (signed) setUrl(signed);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, sign]);

  return { url, failed, setFailed };
}

"use client";

import Link from "next/link";

/** Without this, a thrown "Permission denied" (hand-typed /admin URL) or
 *  a transient query failure renders Next's raw crash screen. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const denied = error.message === "Permission denied";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-stream px-6 text-center">
      <div>
        <p className="text-[17px] font-semibold text-ink">
          {denied ? "You don't have access to that page" : "Something went wrong"}
        </p>
        <p className="mt-1 text-[13px] text-muted">
          {denied
            ? "Ask an admin if you think you should have access."
            : "The page failed to load. Try again, or go back to your chats."}
        </p>
      </div>
      <div className="flex gap-2">
        {!denied && (
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-9 items-center rounded-lg border border-line bg-paper px-3.5 text-[13px] font-medium text-ink shadow-xs active:bg-mist"
          >
            Try again
          </button>
        )}
        <Link
          href="/rooms"
          className="inline-flex h-9 items-center rounded-lg bg-brand-grad px-3.5 text-[13px] font-semibold text-white shadow-brand"
        >
          Go to chats
        </Link>
      </div>
    </div>
  );
}

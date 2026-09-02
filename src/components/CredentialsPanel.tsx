"use client";

import { Button } from "@/components/ui/Button";

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[4.5rem] shrink-0 text-xs font-medium text-emerald-800">
        {label}
      </span>
      <input
        readOnly
        value={value}
        onFocus={(e) => e.target.select()}
        className="min-w-0 flex-1 rounded-md border border-emerald-200 bg-paper px-2 py-1 font-mono text-xs text-ink"
        aria-label={label}
      />
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(value)}
        className="shrink-0 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white"
      >
        Copy
      </button>
    </div>
  );
}

/**
 * The one-time credentials, owned by the button component rather than the
 * form: a successful create revalidates the page, which remounts the form
 * and would otherwise wipe the password off the screen before it can be
 * copied.
 */
export function CredentialsPanel({
  message,
  credentials,
  onDone,
}: {
  message?: string;
  credentials: { username: string; password: string };
  onDone: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-md bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700">
        <p>{message ?? "Account ready. Share these — shown only once:"}</p>
        <div className="mt-2 space-y-1.5">
          <CopyRow label="Username" value={credentials.username} />
          <CopyRow label="Password" value={credentials.password} />
        </div>
      </div>
      <Button type="button" onClick={onDone} className="w-full">
        Done
      </Button>
    </div>
  );
}

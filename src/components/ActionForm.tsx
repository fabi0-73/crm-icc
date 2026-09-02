"use client";

import { useActionState } from "react";
import type { ActionState } from "@/app/actions/admin";

export function FormMessage({ state }: { state: ActionState }) {
  if (state.error) {
    return (
      <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
        <p>{state.success}</p>
        {state.credentials && (
          <div className="mt-2 space-y-1.5">
            <CopyRow label="Username" value={state.credentials.username} />
            <CopyRow label="Password" value={state.credentials.password} />
          </div>
        )}
      </div>
    );
  }
  return null;
}

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

export function ActionForm({
  action,
  children,
  className,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});

  return (
    <form action={formAction} className={className}>
      <FormMessage state={state} />
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
    </form>
  );
}

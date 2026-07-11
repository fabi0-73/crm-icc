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
        {state.link && <CopyLink link={state.link} />}
      </div>
    );
  }
  return null;
}

function CopyLink({ link }: { link: string }) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <input
        readOnly
        value={link}
        onFocus={(e) => e.target.select()}
        className="min-w-0 flex-1 rounded-md border border-emerald-200 bg-paper px-2 py-1 text-xs text-ink"
        aria-label="Set-password link"
      />
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(link)}
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

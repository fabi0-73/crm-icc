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
      <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
        {state.success}
      </p>
    );
  }
  return null;
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

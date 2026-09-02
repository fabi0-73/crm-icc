"use client";

import { useActionState, useEffect, useRef } from "react";
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
  onResult,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  className?: string;
  /**
   * Fires once per submit with the action's result. Anything that must
   * outlive the form (one-time credentials, cleared selections) belongs
   * in the parent: a revalidating action remounts this component.
   */
  onResult?: (state: ActionState) => void;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const seenRef = useRef(state);
  const cbRef = useRef(onResult);
  cbRef.current = onResult;

  useEffect(() => {
    if (state === seenRef.current) return;
    seenRef.current = state;
    cbRef.current?.(state);
  }, [state]);

  return (
    <form action={formAction} className={className}>
      <FormMessage state={state} />
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
    </form>
  );
}

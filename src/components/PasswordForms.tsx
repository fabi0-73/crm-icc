"use client";

import { useActionState } from "react";
import { updatePassword } from "@/app/actions/auth";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";

/** Self-service password change for the signed-in user. */
export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(updatePassword, {});

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.success && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {state.success}
        </p>
      )}
      <div>
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          className="py-3 text-[16px]"
        />
      </div>
      <div>
        <Label htmlFor="confirm">Repeat new password</Label>
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          className="py-3 text-[16px]"
        />
      </div>
      <Button type="submit" disabled={pending} className="h-11 w-full">
        {pending ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}

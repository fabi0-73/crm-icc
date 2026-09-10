"use client";

import { useActionState } from "react";
import { updateMyPublicName } from "@/app/actions/profile";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";

export function PublicNameForm({
  fullName,
  publicName,
}: {
  fullName: string;
  publicName: string | null;
}) {
  const [state, action, pending] = useActionState(updateMyPublicName, {});
  return (
    <form action={action} className="space-y-3">
      <div>
        <Label htmlFor="public-name">Public name</Label>
        <Input
          id="public-name"
          name="public_name"
          defaultValue={publicName ?? ""}
          placeholder={fullName}
          maxLength={80}
        />
        <p className="mt-1 text-[13px] text-muted">
          Shown in chats. Leave empty to use your account name ({fullName}).
          Your role and login stay unchanged.
        </p>
      </div>
      {state.error && (
        <p className="text-[13px] text-red-600">{state.error}</p>
      )}
      {state.success && (
        <p className="text-[13px] text-emerald-700">{state.success}</p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Saving…" : "Save public name"}
      </Button>
    </form>
  );
}

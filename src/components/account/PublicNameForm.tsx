"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { updateMyPublicName } from "@/app/actions/profile";
import type { ActionState } from "@/app/actions/admin";
import { Input, Label } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

/**
 * Assistants and agents pick the name shown in chats and calls. It sits
 * alongside their account name rather than replacing it, so admin screens
 * (Users, Agents, Audit) keep showing who the account really belongs to.
 * Empty goes back to the account name.
 */
export function PublicNameForm({
  fullName,
  publicName,
}: {
  fullName: string;
  publicName: string | null;
}) {
  const [value, setValue] = useState(publicName ?? "");
  const [note, setNote] = useState<string | null>(null);

  function onResult(state: ActionState) {
    if (state.error) setNote(state.error);
    else if (state.success) {
      setNote("Saved.");
      // Reflected across the app (sidebar, chat header) on next load.
      setTimeout(() => window.location.reload(), 500);
    }
  }

  return (
    <ActionForm action={updateMyPublicName} className="space-y-3" onResult={onResult}>
      <div>
        <Label htmlFor="public-name">Display name</Label>
        <Input
          id="public-name"
          name="public_name"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setNote(null);
          }}
          placeholder={fullName}
          maxLength={80}
        />
        <p className="mt-1 text-[12px] text-muted">
          Leave empty to use your account name ({fullName}).
        </p>
      </div>
      {note && (
        <p className="text-[13px] text-muted" aria-live="polite">
          {note}
        </p>
      )}
      <Button type="submit">Save name</Button>
    </ActionForm>
  );
}

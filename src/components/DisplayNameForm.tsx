"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { updateMyName, type ActionState } from "@/app/actions/admin";
import { Input, Label } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

/** Lets the signed-in user edit their own public display name. */
export function DisplayNameForm({ initialName }: { initialName: string }) {
  const [value, setValue] = useState(initialName);
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
    <ActionForm action={updateMyName} className="space-y-3" onResult={onResult}>
      <div>
        <Label htmlFor="display-name">Display name</Label>
        <Input
          id="display-name"
          name="full_name"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setNote(null);
          }}
          required
        />
        <p className="mt-1 text-[12px] text-muted">
          This is the name other people see.
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

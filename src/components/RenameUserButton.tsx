"use client";

import { useState } from "react";
import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { renameUser, type ActionState } from "@/app/actions/admin";
import { Input, Label } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

/** Admin: rename a staff member from the Users table. */
export function RenameUserButton({
  userId,
  name,
}: {
  userId: string;
  name: string;
}) {
  const { open, openModal, closeModal } = useModal();
  const [value, setValue] = useState(name);

  function onResult(state: ActionState) {
    if (state.success) {
      closeModal();
      // staleTimes serves the old table for 30s; reload to show the name.
      window.location.reload();
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setValue(name);
          openModal();
        }}
        className="font-medium text-brand-600 hover:underline"
      >
        Rename
      </button>
      <Modal title="Rename user" open={open} onClose={closeModal}>
        <ActionForm action={renameUser} className="space-y-4" onResult={onResult}>
          <input type="hidden" name="user_id" value={userId} />
          <div>
            <Label htmlFor={`rename-${userId}`}>Full name</Label>
            <Input
              id={`rename-${userId}`}
              name="full_name"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full">
            Save name
          </Button>
        </ActionForm>
      </Modal>
    </>
  );
}

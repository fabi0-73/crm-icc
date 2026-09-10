"use client";

import { useState } from "react";
import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { updateAssistantName, type ActionState } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";

export function EditAssistantNameButton({
  userId,
  name,
}: {
  userId: string;
  name: string;
}) {
  const { open, openModal, closeModal } = useModal();
  const [value, setValue] = useState(name);
  const [result, setResult] = useState<ActionState | null>(null);

  function start() {
    setValue(name);
    setResult(null);
    openModal();
  }

  function onResult(state: ActionState) {
    setResult(state);
    if (state.success) window.location.reload();
  }

  return (
    <>
      <button
        type="button"
        onClick={start}
        className="font-medium text-brand-600 hover:underline"
      >
        Edit name
      </button>
      <Modal title="Edit assistant name" open={open} onClose={closeModal}>
        <ActionForm action={updateAssistantName} onResult={onResult}>
          <input type="hidden" name="user_id" value={userId} />
          <Label htmlFor="assistant-full-name">Name</Label>
          <Input
            id="assistant-full-name"
            name="full_name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            required
          />
          {result?.error && (
            <p className="mt-2 text-sm text-red-600">{result.error}</p>
          )}
          <Button type="submit" className="mt-4 w-full">
            Save name
          </Button>
        </ActionForm>
      </Modal>
    </>
  );
}

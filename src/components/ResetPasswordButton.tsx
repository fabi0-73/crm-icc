"use client";

import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { resetUserPassword } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";

export function ResetPasswordButton({
  userId,
  name,
}: {
  userId: string;
  name: string;
}) {
  const { open, openModal, closeModal } = useModal();

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="font-medium text-brand-600 hover:underline"
      >
        Reset password
      </button>
      <Modal title="Reset password" open={open} onClose={closeModal}>
        <ActionForm action={resetUserPassword} className="space-y-4">
          <input type="hidden" name="user_id" value={userId} />
          <p className="text-sm text-muted">
            Generate a new password for{" "}
            <span className="font-medium text-ink">{name}</span>? Their current
            password stops working immediately.
          </p>
          <Button type="submit" className="w-full">
            Generate new password
          </Button>
        </ActionForm>
      </Modal>
    </>
  );
}

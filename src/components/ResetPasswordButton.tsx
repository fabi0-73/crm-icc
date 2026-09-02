"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { CredentialsPanel } from "@/components/CredentialsPanel";
import { resetUserPassword, type ActionState } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";

export function ResetPasswordButton({
  userId,
  name,
}: {
  userId: string;
  name: string;
}) {
  const { open, openModal, closeModal } = useModal();
  const router = useRouter();
  const [result, setResult] = useState<ActionState | null>(null);

  function finish() {
    closeModal();
    setResult(null);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setResult(null);
          openModal();
        }}
        className="font-medium text-brand-600 hover:underline"
      >
        Reset password
      </button>
      <Modal title="Reset password" open={open} onClose={finish}>
        {result?.credentials ? (
          <CredentialsPanel
            message={result.success}
            credentials={result.credentials}
            onDone={finish}
          />
        ) : (
          <ActionForm
            action={resetUserPassword}
            className="space-y-4"
            onResult={setResult}
          >
            <input type="hidden" name="user_id" value={userId} />
            <p className="text-sm text-muted">
              Generate a new password for{" "}
              <span className="font-medium text-ink">{name}</span>? Their
              current password stops working immediately.
            </p>
            <Button type="submit" className="w-full">
              Generate new password
            </Button>
          </ActionForm>
        )}
      </Modal>
    </>
  );
}

"use client";

import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { createAgent } from "@/app/actions/agents";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";

export function CreateAgentButton() {
  const { open, openModal, closeModal } = useModal();

  return (
    <>
      <Button size="sm" type="button" onClick={openModal}>
        New agent
      </Button>
      <Modal title="Create agent" open={open} onClose={closeModal}>
        <ActionForm action={createAgent} className="space-y-4">
          <div>
            <Label htmlFor="agent-display-name">Display name</Label>
            <Input id="agent-display-name" name="display_name" required />
          </div>
          <div>
            <Label htmlFor="agent-full-name">Full name</Label>
            <Input
              id="agent-full-name"
              name="full_name"
              placeholder="Defaults to display name"
            />
          </div>
          <div>
            <Label htmlFor="agent-email">Email (login)</Label>
            <Input id="agent-email" name="email" type="email" required />
          </div>
          <Button type="submit" className="w-full">
            Create & invite
          </Button>
        </ActionForm>
      </Modal>
    </>
  );
}

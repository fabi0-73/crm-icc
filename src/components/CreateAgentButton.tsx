"use client";

import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { createAgent } from "@/app/actions/agents";
import { USERNAME_HINT } from "@/lib/username";
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
            <Label htmlFor="agent-username">Username (login)</Label>
            <Input
              id="agent-username"
              name="username"
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="e.g. marco.b"
            />
            <p className="mt-1 text-xs text-muted">{USERNAME_HINT}</p>
          </div>
          <div>
            <Label htmlFor="agent-password">Password</Label>
            <Input
              id="agent-password"
              name="password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Leave empty to auto-generate"
            />
          </div>
          <Button type="submit" className="w-full">
            Create agent
          </Button>
        </ActionForm>
      </Modal>
    </>
  );
}

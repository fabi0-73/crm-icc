"use client";

import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { inviteUser } from "@/app/actions/admin";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";

export function InviteUserButton() {
  const { open, openModal, closeModal } = useModal();

  return (
    <>
      <Button size="sm" type="button" onClick={openModal}>
        Invite user
      </Button>
      <Modal title="Invite user" open={open} onClose={closeModal}>
        <ActionForm action={inviteUser} className="space-y-4">
          <div>
            <Label htmlFor="invite-full-name">Full name</Label>
            <Input id="invite-full-name" name="full_name" required />
          </div>
          <div>
            <Label htmlFor="invite-email">Email</Label>
            <Input id="invite-email" name="email" type="email" required />
          </div>
          <div>
            <Label htmlFor="invite-role">Role</Label>
            <Select id="invite-role" name="role" defaultValue="assistant">
              <option value="admin">Admin</option>
              <option value="manager">Manager</option>
              <option value="assistant">Assistant</option>
            </Select>
            <p className="mt-1 text-xs text-muted">
              Agent accounts are created from the Agents page.
            </p>
          </div>
          <Button type="submit" className="w-full">
            Send invite
          </Button>
        </ActionForm>
      </Modal>
    </>
  );
}

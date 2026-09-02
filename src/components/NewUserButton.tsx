"use client";

import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { createUserAccount } from "@/app/actions/admin";
import { USERNAME_HINT } from "@/lib/username";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";

export function NewUserButton() {
  const { open, openModal, closeModal } = useModal();

  return (
    <>
      <Button size="sm" type="button" onClick={openModal}>
        New user
      </Button>
      <Modal title="New user" open={open} onClose={closeModal}>
        <ActionForm action={createUserAccount} className="space-y-4">
          <div>
            <Label htmlFor="new-user-full-name">Full name</Label>
            <Input id="new-user-full-name" name="full_name" required />
          </div>
          <div>
            <Label htmlFor="new-user-username">Username</Label>
            <Input
              id="new-user-username"
              name="username"
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="e.g. anna.k"
            />
            <p className="mt-1 text-xs text-muted">{USERNAME_HINT}</p>
          </div>
          <div>
            <Label htmlFor="new-user-password">Password</Label>
            <Input
              id="new-user-password"
              name="password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Leave empty to auto-generate"
            />
          </div>
          <div>
            <Label htmlFor="new-user-role">Role</Label>
            <Select id="new-user-role" name="role" defaultValue="assistant">
              <option value="admin">Admin</option>
              <option value="manager">Manager</option>
              <option value="assistant">Assistant</option>
            </Select>
            <p className="mt-1 text-xs text-muted">
              Agent accounts are created from the Agents page.
            </p>
          </div>
          <Button type="submit" className="w-full">
            Create user
          </Button>
        </ActionForm>
      </Modal>
    </>
  );
}

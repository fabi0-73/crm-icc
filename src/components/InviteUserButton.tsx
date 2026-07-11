"use client";

import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { inviteUser } from "@/app/actions/admin";

export function InviteUserButton() {
  const { open, openModal, closeModal } = useModal();

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="rounded-full bg-brand-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-brand-700"
      >
        Invite user
      </button>
      <Modal title="Invite user" open={open} onClose={closeModal}>
        <ActionForm action={inviteUser} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Full name
            </label>
            <input
              name="full_name"
              required
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              name="email"
              type="email"
              required
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Role
            </label>
            <select
              name="role"
              defaultValue="assistant"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="admin">Admin</option>
              <option value="manager">Manager</option>
              <option value="assistant">Assistant</option>
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Agent accounts are created from the Agents page.
            </p>
          </div>
          <button
            type="submit"
            className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-medium text-white"
          >
            Send invite
          </button>
        </ActionForm>
      </Modal>
    </>
  );
}

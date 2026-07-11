"use client";

import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { createAgent } from "@/app/actions/agents";

export function CreateAgentButton() {
  const { open, openModal, closeModal } = useModal();

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="rounded-full bg-brand-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-brand-700"
      >
        New agent
      </button>
      <Modal title="Create agent" open={open} onClose={closeModal}>
        <ActionForm action={createAgent} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Display name
            </label>
            <input
              name="display_name"
              required
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Full name
            </label>
            <input
              name="full_name"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder="Defaults to display name"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Email (login)
            </label>
            <input
              name="email"
              type="email"
              required
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-medium text-white"
          >
            Create & invite
          </button>
        </ActionForm>
      </Modal>
    </>
  );
}

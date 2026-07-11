"use client";

import { useState } from "react";
import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { swapAssistants } from "@/app/actions/agents";
import { HISTORY_PRESET_OPTIONS } from "@/lib/history-presets";

type Person = { id: string; full_name: string };

export function SwapAssistantsButton({
  agentId,
  assigned,
  available,
}: {
  agentId: string;
  assigned: Person[];
  available: Person[];
}) {
  const { open, openModal, closeModal } = useModal();
  const [removeIds, setRemoveIds] = useState<string[]>([]);

  function toggleRemove(id: string) {
    setRemoveIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="rounded-full bg-brand-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-brand-700"
      >
        Swap assistants
      </button>
      <Modal title="Swap assistants" open={open} onClose={closeModal}>
        <ActionForm action={swapAssistants} className="space-y-4">
          <input type="hidden" name="agent_id" value={agentId} />
          <input type="hidden" name="remove_ids" value={removeIds.join(",")} />

          {assigned.length > 0 && (
            <div>
              <p className="text-sm font-medium text-gray-700 mb-2">
                Remove
              </p>
              <ul className="space-y-1 border border-gray-200 rounded-lg p-2">
                {assigned.map((a) => (
                  <li key={a.id}>
                    <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={removeIds.includes(a.id)}
                        onChange={() => toggleRemove(a.id)}
                      />
                      {a.full_name}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Add assistant
            </label>
            <select
              name="add_user_id"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              defaultValue=""
            >
              <option value="">— none —</option>
              {available.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.full_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              History access for new assistant
            </label>
            <select
              name="history_preset"
              defaultValue="none"
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              {HISTORY_PRESET_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Reason (audit only — never shown in chat)
            </label>
            <textarea
              name="reason"
              rows={2}
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder="Optional"
            />
          </div>

          <button
            type="submit"
            className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-medium text-white"
          >
            Apply swap
          </button>
        </ActionForm>
      </Modal>
    </>
  );
}

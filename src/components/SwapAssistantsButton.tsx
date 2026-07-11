"use client";

import { useState } from "react";
import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { swapAssistants } from "@/app/actions/agents";
import { HISTORY_PRESET_OPTIONS } from "@/lib/history-presets";
import { Button } from "@/components/ui/Button";
import { Label, Select, Textarea } from "@/components/ui/Field";

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
      <Button size="sm" type="button" onClick={openModal}>
        Swap assistants
      </Button>
      <Modal title="Swap assistants" open={open} onClose={closeModal}>
        <ActionForm action={swapAssistants} className="space-y-4">
          <input type="hidden" name="agent_id" value={agentId} />
          <input type="hidden" name="remove_ids" value={removeIds.join(",")} />

          {assigned.length > 0 && (
            <div>
              <p className="mb-1.5 text-[13px] font-medium text-ink">Remove</p>
              <ul className="space-y-1 rounded-md border border-line p-2">
                {assigned.map((a) => (
                  <li key={a.id}>
                    <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer hover:bg-mist">
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
            <Label htmlFor="swap-add">Add assistant</Label>
            <Select id="swap-add" name="add_user_id" defaultValue="">
              <option value="">— none —</option>
              {available.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.full_name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="swap-history">
              History access for new assistant
            </Label>
            <Select id="swap-history" name="history_preset" defaultValue="none">
              {HISTORY_PRESET_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="swap-reason">
              Reason (audit only — never shown in chat)
            </Label>
            <Textarea
              id="swap-reason"
              name="reason"
              rows={2}
              placeholder="Optional"
            />
          </div>

          <Button type="submit" className="w-full">
            Apply swap
          </Button>
        </ActionForm>
      </Modal>
    </>
  );
}

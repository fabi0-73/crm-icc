"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { setAgentManager, type ActionState } from "@/app/actions/admin";
import { Select } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

type Manager = { id: string; full_name: string };

/** Admin control to set the manager responsible for an agent. */
export function AgentManagerSelect({
  agentId,
  managers,
  currentManagerId,
}: {
  agentId: string;
  managers: Manager[];
  currentManagerId: string | null;
}) {
  const [value, setValue] = useState(currentManagerId ?? "");
  const [note, setNote] = useState<string | null>(null);

  function onResult(state: ActionState) {
    if (state.error) setNote(state.error);
    else if (state.success) setNote(state.success);
  }

  return (
    <ActionForm
      action={setAgentManager}
      className="flex flex-wrap items-end gap-2"
      onResult={onResult}
    >
      <input type="hidden" name="agent_id" value={agentId} />
      <div className="min-w-[12rem] flex-1">
        <Select
          name="manager_id"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setNote(null);
          }}
          aria-label="Manager"
        >
          <option value="">Unassigned</option>
          {managers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" variant="secondary" size="sm">
        Save
      </Button>
      {note && <span className="text-[12px] text-muted">{note}</span>}
    </ActionForm>
  );
}

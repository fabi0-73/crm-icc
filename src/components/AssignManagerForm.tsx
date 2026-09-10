"use client";

import { useState } from "react";
import { ActionForm } from "@/components/ActionForm";
import { setAgentManager } from "@/app/actions/agents";
import { Button } from "@/components/ui/Button";
import { Label, Select } from "@/components/ui/Field";

export function AssignManagerForm({
  agentId,
  managerId,
  managers,
}: {
  agentId: string;
  managerId: string | null;
  managers: { id: string; full_name: string }[];
}) {
  const [value, setValue] = useState(managerId ?? "");
  return (
    <ActionForm action={setAgentManager} className="space-y-3">
      <input type="hidden" name="agent_id" value={agentId} />
      <div>
        <Label htmlFor="agent-manager">Assigned manager</Label>
        <Select
          id="agent-manager"
          name="manager_id"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="">No manager</option>
          {managers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" size="sm">
        Save manager
      </Button>
    </ActionForm>
  );
}

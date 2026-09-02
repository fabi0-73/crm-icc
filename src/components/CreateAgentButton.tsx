"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { CredentialsPanel } from "@/components/CredentialsPanel";
import { createAgent } from "@/app/actions/agents";
import type { ActionState } from "@/app/actions/admin";
import { USERNAME_HINT } from "@/lib/username";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";

export function CreateAgentButton() {
  const { open, openModal, closeModal } = useModal();
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<ActionState | null>(null);

  function start() {
    setDisplayName("");
    setFullName("");
    setUsername("");
    setPassword("");
    setResult(null);
    openModal();
  }

  function finish() {
    closeModal();
    setResult(null);
    router.refresh();
  }

  return (
    <>
      <Button size="sm" type="button" onClick={start}>
        New agent
      </Button>
      <Modal title="Create agent" open={open} onClose={finish}>
        {result?.credentials ? (
          <CredentialsPanel
            message={result.success}
            credentials={result.credentials}
            onDone={finish}
          />
        ) : (
          <ActionForm
            action={createAgent}
            className="space-y-4"
            onResult={setResult}
          >
            <div>
              <Label htmlFor="agent-display-name">Display name</Label>
              <Input
                id="agent-display-name"
                name="display_name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="agent-full-name">Full name</Label>
              <Input
                id="agent-full-name"
                name="full_name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Defaults to display name"
              />
            </div>
            <div>
              <Label htmlFor="agent-username">Username (login)</Label>
              <Input
                id="agent-username"
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
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
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
        )}
      </Modal>
    </>
  );
}

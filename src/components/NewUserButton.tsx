"use client";

import { useState } from "react";
import { Modal, useModal } from "@/components/Modal";
import { ActionForm } from "@/components/ActionForm";
import { CredentialsPanel } from "@/components/CredentialsPanel";
import { createUserAccount, type ActionState } from "@/app/actions/admin";
import { USERNAME_HINT } from "@/lib/username";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";

export function NewUserButton({
  actorRole = "admin",
}: {
  actorRole?: "admin" | "manager";
}) {
  const { open, openModal, closeModal } = useModal();
  // Controlled: React resets uncontrolled fields when a form action
  // returns, so a rejected username used to wipe everything typed.
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("assistant");
  const [result, setResult] = useState<ActionState | null>(null);
  const managerOnly = actorRole === "manager";

  function start() {
    setFullName("");
    setUsername("");
    setPassword("");
    setRole("assistant");
    setResult(null);
    openModal();
  }

  function finish() {
    closeModal();
    setResult(null);
    // A reload, not router.refresh(): with staleTimes the client router
    // cache serves the old table for 30s and the new account never shows.
    window.location.reload();
  }

  return (
    <>
      <Button size="sm" type="button" onClick={start}>
        New user
      </Button>
      <Modal title="New user" open={open} onClose={finish}>
        {result?.credentials ? (
          <CredentialsPanel
            message={result.success}
            credentials={result.credentials}
            onDone={finish}
          />
        ) : (
          <ActionForm
            action={createUserAccount}
            className="space-y-4"
            onResult={setResult}
          >
            <div>
              <Label htmlFor="new-user-full-name">Full name</Label>
              <Input
                id="new-user-full-name"
                name="full_name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="new-user-username">Username</Label>
              <Input
                id="new-user-username"
                name="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
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
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Leave empty to auto-generate"
              />
            </div>
            <div>
              <Label htmlFor="new-user-role">Role</Label>
              {managerOnly ? (
                <>
                  <input type="hidden" name="role" value="assistant" />
                  <p className="rounded-lg border border-line bg-mist px-3.5 py-2.5 text-sm text-ink">
                    Regular user (assistant)
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Managers can add regular users only. Agents are created by
                    admins.
                  </p>
                </>
              ) : (
                <>
                  <Select
                    id="new-user-role"
                    name="role"
                    value={role}
                    onChange={(e) => setRole(e.target.value)}
                  >
                    <option value="admin">Admin</option>
                    <option value="manager">Manager</option>
                    <option value="assistant">Assistant</option>
                  </Select>
                  <p className="mt-1 text-xs text-muted">
                    Agent accounts are created from the Agents page.
                  </p>
                </>
              )}
            </div>
            <Button type="submit" className="w-full">
              Create user
            </Button>
          </ActionForm>
        )}
      </Modal>
    </>
  );
}

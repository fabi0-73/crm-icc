"use client";

import { useEffect, useState } from "react";
import { Modal, useModal } from "@/components/Modal";
import { createGroupAndRedirect } from "@/app/actions/rooms";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";
import { PlusIcon } from "@/components/icons";
import type { Profile } from "@/lib/types";

export function NewGroupButton({
  compact = false,
  dark = false,
}: {
  compact?: boolean;
  dark?: boolean;
}) {
  const { open, openModal, closeModal } = useModal();
  const [staff, setStaff] = useState<Pick<Profile, "id" | "full_name" | "role">[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const supabase = createClient();
    void supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("is_active", true)
      .in("role", ["admin", "manager", "assistant"])
      .order("full_name")
      .then(({ data }) => setStaff((data ?? []) as typeof staff));
  }, [open]);

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    fd.set("member_ids", selected.join(","));
    try {
      await createGroupAndRedirect(fd);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create group");
      setPending(false);
    }
  }

  return (
    <>
      {compact ? (
        <button
          type="button"
          onClick={openModal}
          className={`rounded-md p-1 ${
            dark
              ? "text-white/60 hover:bg-white/10 hover:text-white"
              : "text-muted hover:bg-mist hover:text-ink"
          }`}
          aria-label="New group"
          title="New group"
        >
          <PlusIcon />
        </button>
      ) : (
        <Button size="sm" type="button" onClick={openModal}>
          New group
        </Button>
      )}
      <Modal title="New group" open={open} onClose={closeModal}>
        <form onSubmit={onSubmit} className="space-y-4">
          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <div>
            <Label htmlFor="group-name">Name</Label>
            <Input id="group-name" name="name" required />
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-ink">Members</p>
            <ul className="max-h-48 overflow-y-auto space-y-1 rounded-md border border-line p-2">
              {staff.map((p) => (
                <li key={p.id}>
                  <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-mist cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selected.includes(p.id)}
                      onChange={() => toggle(p.id)}
                    />
                    <span className="flex-1">{p.full_name}</span>
                    <span className="text-xs text-muted capitalize">
                      {p.role}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
          <Button type="submit" disabled={pending} className="w-full">
            Create
          </Button>
        </form>
      </Modal>
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Modal, useModal } from "@/components/Modal";
import { openDm } from "@/app/actions/rooms";
import { createClient } from "@/lib/supabase/client";
import { Avatar } from "@/components/Avatar";
import { PresenceDot } from "@/components/PresenceDot";
import { useIsOnline } from "@/components/presence/PresenceProvider";
import { ComposeIcon } from "@/components/icons";
import type { Profile } from "@/lib/types";

type StaffRow = Pick<Profile, "id" | "full_name" | "role">;

function PersonRow({
  person,
  pending,
  onPick,
}: {
  person: StaffRow;
  pending: boolean;
  onPick: () => void;
}) {
  const online = useIsOnline(person.id);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onPick}
      className="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left hover:bg-mist disabled:opacity-50"
    >
      <span className="relative shrink-0">
        <Avatar name={person.full_name} size="sm" />
        <PresenceDot
          online={online}
          className="absolute -bottom-0.5 -right-0.5 ring-2 ring-paper"
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
        {person.full_name}
      </span>
      <span className="text-xs capitalize text-muted">{person.role}</span>
    </button>
  );
}

/** "New message" — staff picker that opens the 1:1 DM. */
export function NewDmButton() {
  const { open, openModal, closeModal } = useModal();
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const supabase = createClient();
    void supabase.auth.getUser().then(async ({ data: { user } }) => {
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, role")
        .eq("is_active", true)
        .in("role", ["admin", "manager", "assistant"])
        .neq("id", user?.id ?? "")
        .order("full_name");
      setStaff((data ?? []) as StaffRow[]);
    });
  }, [open]);

  async function pick(id: string) {
    setPendingId(id);
    setError(null);
    try {
      await openDm(id); // redirects on success
    } catch (err) {
      // Next.js redirect() throws a control-flow error — let it through.
      if (err && typeof err === "object" && "digest" in err) throw err;
      setError(err instanceof Error ? err.message : "Could not open chat");
      setPendingId(null);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="rounded-md p-1 text-muted hover:bg-paper hover:text-ink"
        aria-label="New message"
        title="New message"
      >
        <ComposeIcon size={14} />
      </button>
      <Modal title="New message" open={open} onClose={closeModal}>
        {error && (
          <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <ul className="-mx-2 max-h-[60vh] overflow-y-auto">
          {staff.map((p) => (
            <li key={p.id}>
              <PersonRow
                person={p}
                pending={pendingId !== null}
                onPick={() => void pick(p.id)}
              />
            </li>
          ))}
          {staff.length === 0 && (
            <li className="px-2 py-8 text-center text-sm text-muted">
              No other staff members
            </li>
          )}
        </ul>
      </Modal>
    </>
  );
}

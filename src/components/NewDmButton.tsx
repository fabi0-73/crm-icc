"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
export function NewDmButton({
  dark = false,
  big = false,
}: {
  dark?: boolean;
  /** 40px round trigger for the mobile header. */
  big?: boolean;
}) {
  const { open, openModal, closeModal } = useModal();
  const router = useRouter();
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const supabase = createClient();
    void supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      // Who you may DM mirrors the get_or_create_dm rules: staff DM staff;
      // an assistant may also DM agents (private agent↔assistant chats),
      // so include agents in the picker only for assistants.
      const { data: me } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle<{ role: StaffRow["role"] }>();
      const allowed: StaffRow["role"][] =
        me?.role === "assistant"
          ? ["admin", "manager", "assistant", "agent"]
          : ["admin", "manager", "assistant"];
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, role")
        .eq("is_active", true)
        .in("role", allowed)
        .neq("id", user.id)
        .order("full_name");
      setStaff((data ?? []) as StaffRow[]);
    });
  }, [open]);

  async function pick(id: string) {
    setPendingId(id);
    setError(null);
    const result = await openDm(id);
    setPendingId(null);
    if (result.error || !result.roomId) {
      setError(result.error ?? "Could not open chat");
      return;
    }
    closeModal();
    router.push(`/rooms/${result.roomId}`);
  }

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className={
          big
            ? "flex h-10 w-10 items-center justify-center rounded-full bg-brand-grad text-white shadow-brand active:brightness-95"
            : `rounded-md p-1.5 ${
                dark
                  ? "text-white/60 hover:bg-white/10 hover:text-white"
                  : "text-muted hover:bg-mist hover:text-ink"
              }`
        }
        aria-label="New message"
        title="New message"
      >
        <ComposeIcon size={big ? 18 : 16} />
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

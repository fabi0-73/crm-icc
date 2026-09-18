"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/uikit/input";
import { useRouter } from "next/navigation";
import { Modal, useModal } from "@/components/Modal";
import { openDm } from "@/app/actions/rooms";
import { createClient } from "@/lib/supabase/client";
import { Avatar } from "@/components/Avatar";
import { matchesName, publicDisplayName } from "@/lib/display-name";
import { PresenceDot } from "@/components/PresenceDot";
import { useIsOnline } from "@/components/presence/PresenceProvider";
import { ComposeIcon } from "@/components/icons";
import type { Profile } from "@/lib/types";

type StaffRow = Pick<Profile, "id" | "full_name" | "public_name" | "role">;

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
        <Avatar name={publicDisplayName(person)} size="sm" userId={person.id} />
        <PresenceDot
          online={online}
          className="absolute -bottom-0.5 -right-0.5 ring-2 ring-paper"
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
        {publicDisplayName(person)}
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
  const [query, setQuery] = useState("");

  // Filters the roster this person is already allowed to message, so search
  // can never surface someone they may not DM.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return staff;
    return staff.filter(
      (p) => matchesName(p, q) || p.role.toLowerCase().includes(q),
    );
  }, [staff, query]);

  useEffect(() => {
    if (!open) return;
    const supabase = createClient();
    void supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return;
      // Who you may DM mirrors the get_or_create_dm rules: staff DM staff; an
      // assistant may also DM agents, and an agent may ONLY DM assistants
      // (private agent↔assistant chats). Anything else the RPC would reject.
      const { data: me } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle<{ role: StaffRow["role"] }>();
      const allowed: StaffRow["role"][] =
        me?.role === "assistant"
          ? ["admin", "manager", "assistant", "agent"]
          : me?.role === "agent"
            ? ["assistant"]
            : ["admin", "manager", "assistant"];
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, public_name, role")
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
        <div className="relative mb-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people"
            aria-label="Search people"
            autoFocus
            className="h-10 rounded-full border-line/80 bg-paper pl-9 text-[14px]"
          />
        </div>
        <ul className="-mx-2 max-h-[60vh] overflow-y-auto">
          {visible.map((p) => (
            <li key={p.id}>
              <PersonRow
                person={p}
                pending={pendingId !== null}
                onPick={() => void pick(p.id)}
              />
            </li>
          ))}
          {visible.length === 0 && (
            <li className="px-2 py-8 text-center text-sm text-muted">
              {staff.length === 0
                ? "No other staff members"
                : "Nobody matches that search"}
            </li>
          )}
        </ul>
      </Modal>
    </>
  );
}

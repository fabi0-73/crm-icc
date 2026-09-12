"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { Modal, useModal } from "@/components/Modal";
import { openDm } from "@/app/actions/rooms";
import { lookupUsernames } from "@/app/actions/profile";
import { publicDisplayName } from "@/lib/display-name";
import { createClient } from "@/lib/supabase/client";
import { Avatar } from "@/components/Avatar";
import { PresenceDot } from "@/components/PresenceDot";
import { useIsOnline } from "@/components/presence/PresenceProvider";
import { ComposeIcon } from "@/components/icons";
import type { Profile } from "@/lib/types";

type StaffRow = Pick<Profile, "id" | "full_name" | "role"> & {
  public_name?: string | null;
  avatar_url?: string | null;
};

function PersonRow({
  person,
  username,
  pending,
  onPick,
}: {
  person: StaffRow;
  username?: string;
  pending: boolean;
  onPick: () => void;
}) {
  const online = useIsOnline(person.id);
  const shown = publicDisplayName(person);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={onPick}
      className="flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left hover:bg-mist disabled:opacity-50"
    >
      <span className="relative shrink-0">
        <Avatar
          name={shown}
          size="sm"
          userId={person.id}
          src={person.avatar_url}
        />
        <PresenceDot
          online={online}
          className="absolute -bottom-0.5 -right-0.5 ring-2 ring-paper"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">
          {shown}
        </span>
        {username && (
          <span className="block truncate font-mono text-[11px] text-muted">
            {username}
          </span>
        )}
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
  const [usernames, setUsernames] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const supabase = createClient();
    void lookupUsernames().then(setUsernames).catch(() => {});
    void supabase.auth.getUser().then(async ({ data: { user } }) => {
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, public_name, avatar_url, role")
        .eq("is_active", true)
        .in("role", ["admin", "manager", "assistant"])
        .neq("id", user?.id ?? "")
        .order("full_name");
      const staff = (data ?? []) as StaffRow[];

      const { data: links } = await supabase
        .from("assignments")
        .select("agent_id")
        .eq("assistant_id", user?.id ?? "")
        .is("removed_at", null);
      const agentIds = (links ?? []).map((l) => l.agent_id as string);
      let agents: StaffRow[] = [];
      if (agentIds.length) {
        const { data: agentRows } = await supabase
          .from("agents")
          .select("user_id, status")
          .in("id", agentIds)
          .eq("status", "active");
        const userIds = (agentRows ?? []).map((a) => a.user_id as string);
        if (userIds.length) {
          const { data: agentProfiles } = await supabase
            .from("profiles")
            .select("id, full_name, public_name, avatar_url, role")
            .in("id", userIds);
          agents = (agentProfiles ?? []) as StaffRow[];
        }
      }
      setStaff([...staff, ...agents]);
    });
  }, [open]);

  // Only names the caller is already allowed to see are searched — the
  // candidate list itself is what enforces who can be messaged.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return staff;
    return staff.filter(
      (p) =>
        p.full_name.toLowerCase().includes(q) ||
        (p.public_name ?? "").toLowerCase().includes(q) ||
        (usernames[p.id] ?? "").toLowerCase().includes(q),
    );
  }, [staff, query, usernames]);

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
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people"
            autoComplete="off"
            className="h-10 w-full rounded-lg border border-line bg-paper pl-9 pr-3 text-[15px] text-ink outline-none placeholder:text-muted focus:border-brand-500"
            aria-label="Search people"
          />
        </div>
        <ul className="-mx-2 max-h-[60vh] overflow-y-auto">
          {visible.map((p) => (
            <li key={p.id}>
              <PersonRow
                person={p}
                username={usernames[p.id]}
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

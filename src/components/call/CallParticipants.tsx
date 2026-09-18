"use client";

import { useEffect, useMemo, useState } from "react";
import { UserMinus, UserPlus, X } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { matchesName, publicDisplayName } from "@/lib/display-name";
import { Input } from "@/components/uikit/input";
import { createClient } from "@/lib/supabase/client";
import { useCall } from "@/components/call/CallProvider";

type Candidate = {
  id: string;
  full_name: string;
  public_name: string | null;
  role: string;
};

/**
 * Manage who is in the call while it is running.
 *
 * Adding someone re-uses the SAME call id, so accepting drops them into the
 * same LiveKit room as everyone else rather than starting a second call.
 * Removing goes through a server action, because only LiveKit's server API
 * can evict a participant and that needs the API secret.
 *
 * Visible only to admins and managers; the server re-checks both the role and
 * that the actor is in the conversation.
 */
export function CallParticipants({ onClose }: { onClose: () => void }) {
  const { selfId, call, groupPeers, canManageCall, addParticipant, removeParticipant } =
    useCall();
  const supabase = useMemo(() => createClient(), []);
  const [roster, setRoster] = useState<Candidate[]>([]);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const roomId = call?.roomId;

  // Everyone in the conversation, so we can offer the ones not yet in the
  // call. RLS keeps this to rooms the viewer belongs to.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    void (async () => {
      const { data: rows } = await supabase
        .from("room_members")
        .select("user_id")
        .eq("room_id", roomId);
      const ids = (rows ?? []).map((r: { user_id: string }) => r.user_id);
      if (ids.length === 0 || cancelled) return;
      const { data: people } = await supabase
        .from("profiles")
        .select("id, full_name, public_name, role")
        .in("id", ids)
        .eq("is_active", true)
        .order("full_name");
      if (!cancelled) setRoster((people ?? []) as Candidate[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, supabase]);

  const inCall = new Set(groupPeers.map((p) => p.id));
  const q = query.trim().toLowerCase();
  const canAdd = roster.filter(
    (p) =>
      !inCall.has(p.id) &&
      matchesName(p, q),
  );

  async function run(id: string, fn: () => Promise<void>) {
    setBusyId(id);
    try {
      await fn();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col border-l border-white/10 bg-ink-soft/95 backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <p className="text-[15px] font-semibold text-white">
          In this call ({groupPeers.length + 1})
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close participants"
          className="rounded-full p-1.5 text-white/70 hover:bg-white/10 hover:text-white"
        >
          <X className="size-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        <ul className="space-y-0.5">
          <li className="flex items-center gap-3 rounded-lg px-2 py-2">
            <Avatar name="You" size="sm" userId={selfId} />
            <span className="min-w-0 flex-1 truncate text-[14px] text-white">
              You
            </span>
          </li>
          {groupPeers.map((p) => (
            <li key={p.id} className="flex items-center gap-3 rounded-lg px-2 py-2">
              <Avatar name={p.name} size="sm" userId={p.id} />
              <span className="min-w-0 flex-1 truncate text-[14px] text-white">
                {p.name}
              </span>
              {canManageCall && (
                <button
                  type="button"
                  disabled={busyId === p.id}
                  onClick={() => void run(p.id, () => removeParticipant(p.id))}
                  title="Remove from call"
                  aria-label={`Remove ${p.name} from the call`}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-red-300 hover:bg-red-500/20 disabled:opacity-40"
                >
                  <UserMinus className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>

        {canManageCall && (
          <>
            <p className="px-2 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-white/40">
              Add from this conversation
            </p>
            <div className="px-2 pb-2">
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people"
                aria-label="Search people to add"
                className="h-9 border-white/15 bg-white/10 text-[14px] text-white placeholder:text-white/40"
              />
            </div>
            <ul className="space-y-0.5">
              {canAdd.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-3 rounded-lg px-2 py-2"
                >
                  <Avatar name={publicDisplayName(p)} size="sm" userId={p.id} />
                  <span className="min-w-0 flex-1 truncate text-[14px] text-white/90">
                    {publicDisplayName(p)}
                  </span>
                  <button
                    type="button"
                    disabled={busyId === p.id}
                    onClick={() => void run(p.id, () => addParticipant(p.id))}
                    title="Ring into this call"
                    aria-label={`Add ${publicDisplayName(p)} to the call`}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-brand-200 hover:bg-brand-500/25 disabled:opacity-40"
                  >
                    <UserPlus className="size-4" />
                  </button>
                </li>
              ))}
              {canAdd.length === 0 && (
                <li className="px-2 py-4 text-center text-[13px] text-white/50">
                  Everyone here is already in the call.
                </li>
              )}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Hash, MessageSquareText, Search, UserRound } from "lucide-react";
import { Modal } from "@/components/Modal";
import { Input } from "@/components/uikit/input";
import { Avatar } from "@/components/Avatar";
import { publicDisplayName } from "@/lib/display-name";
import { createClient } from "@/lib/supabase/client";
import { useRooms } from "@/components/rooms/RoomsProvider";
import { openDm } from "@/app/actions/rooms";
import type { MyRoom, Profile } from "@/lib/types";

/** Anything can ask for the palette by dispatching this on window. */
export const OPEN_SEARCH_EVENT = "icc-open-search";

const DEBOUNCE_MS = 250;
const MAX_MESSAGES = 20;
const MAX_PEOPLE = 8;
const MAX_ROOMS = 8;

type PersonHit = Pick<Profile, "id" | "full_name" | "public_name" | "role">;

type MessageHit = {
  id: string;
  roomId: string;
  roomLabel: string;
  senderName: string;
  body: string;
  createdAt: string;
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "2-digit" });
}

/** Excerpt around the first match, so a long message shows the relevant bit. */
function excerpt(body: string, term: string): { before: string; hit: string; after: string } {
  const i = body.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return { before: body.slice(0, 120), hit: "", after: "" };
  const start = Math.max(0, i - 40);
  return {
    before: (start > 0 ? "…" : "") + body.slice(start, i),
    hit: body.slice(i, i + term.length),
    after: body.slice(i + term.length, i + term.length + 80),
  };
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2 pb-1 pt-3 text-[12px] font-medium text-muted">
      {children}
    </p>
  );
}

/**
 * App-wide search over conversations, people and message history.
 *
 * Runs entirely as the signed-in user through RLS: message matches are
 * constrained by the messages_select policy (membership + each member's
 * history cutoff + the admin override), and the people list reuses the same
 * pairing rules as starting a DM. So there is no permission logic here to get
 * wrong — the database decides what can match.
 */
export function GlobalSearch() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const { rooms } = useRooms();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<PersonHit[]>([]);
  const [messages, setMessages] = useState<MessageHit[]>([]);
  const runId = useRef(0);

  // Ctrl/Cmd+K, plus any button that dispatches OPEN_SEARCH_EVENT.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    const onAsk = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_SEARCH_EVENT, onAsk);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_SEARCH_EVENT, onAsk);
    };
  }, []);

  const term = query.trim();

  // Conversations come from the live room list already in memory — no query,
  // so they filter instantly as you type.
  const roomHits: MyRoom[] = useMemo(() => {
    if (!term) return [];
    const q = term.toLowerCase();
    return rooms
      .filter((r) => r.display_name.toLowerCase().includes(q))
      .slice(0, MAX_ROOMS);
  }, [rooms, term]);

  const search = useCallback(
    async (q: string) => {
      const mine = ++runId.current;
      setBusy(true);
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        const { data: me } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", user.id)
          .maybeSingle<{ role: Profile["role"] }>();
        // Same pairing rules as starting a DM, so search can never surface
        // someone this person isn't allowed to message.
        const allowed: Profile["role"][] =
          me?.role === "assistant"
            ? ["admin", "manager", "assistant", "agent"]
            : me?.role === "agent"
              ? ["assistant"]
              : ["admin", "manager", "assistant"];

        // Either name matches. Quoted so commas or brackets in what was
        // typed can't break PostgREST's or() syntax.
        const pattern = `"%${q.replace(/["\\]/g, "\\$&")}%"`;
        const [peopleRes, msgRes] = await Promise.all([
          supabase
            .from("profiles")
            .select("id, full_name, public_name, role")
            .eq("is_active", true)
            .in("role", allowed)
            .neq("id", user.id)
            .or(`full_name.ilike.${pattern},public_name.ilike.${pattern}`)
            .order("full_name")
            .limit(MAX_PEOPLE),
          supabase
            .from("messages")
            .select("id, room_id, sender_id, body, created_at")
            .is("deleted_at", null)
            .neq("kind", "system")
            .ilike("body", `%${q}%`)
            .order("created_at", { ascending: false })
            .limit(MAX_MESSAGES),
        ]);
        if (runId.current !== mine) return; // a newer keystroke won

        setPeople((peopleRes.data ?? []) as PersonHit[]);

        const rawMsgs = (msgRes.data ?? []) as {
          id: string;
          room_id: string;
          sender_id: string | null;
          body: string;
          created_at: string;
        }[];

        // Two FKs from messages to profiles (sender_id and pinned_by) make
        // PostgREST embedding ambiguous, so names are resolved separately.
        const senderIds = [...new Set(rawMsgs.map((m) => m.sender_id).filter(Boolean))] as string[];
        const roomIds = [...new Set(rawMsgs.map((m) => m.room_id))];
        const [sendersRes, roomsRes] = await Promise.all([
          senderIds.length
            ? supabase
                .from("profiles")
                .select("id, full_name, public_name")
                .in("id", senderIds)
            : Promise.resolve({
                data: [] as {
                  id: string;
                  full_name: string;
                  public_name: string | null;
                }[],
              }),
          roomIds.length
            ? supabase.from("rooms").select("id, name, type").in("id", roomIds)
            : Promise.resolve({ data: [] as { id: string; name: string; type: string }[] }),
        ]);
        if (runId.current !== mine) return;

        const nameById = new Map(
          (
            (sendersRes.data ?? []) as {
              id: string;
              full_name: string;
              public_name: string | null;
            }[]
          ).map((p) => [p.id, publicDisplayName(p)]),
        );
        const roomById = new Map(
          ((roomsRes.data ?? []) as { id: string; name: string; type: string }[]).map((r) => [
            r.id,
            r,
          ]),
        );
        // The live room list knows a DM's display name (the other person);
        // rooms.name is empty for DMs.
        const liveLabel = new Map(rooms.map((r) => [r.room_id, r.display_name]));

        setMessages(
          rawMsgs.map((m) => {
            const room = roomById.get(m.room_id);
            const label =
              liveLabel.get(m.room_id) ??
              (room?.type === "dm" ? "Direct message" : room?.name) ??
              "Conversation";
            return {
              id: m.id,
              roomId: m.room_id,
              roomLabel: label,
              senderName: m.sender_id ? (nameById.get(m.sender_id) ?? "Member") : "System",
              body: m.body,
              createdAt: m.created_at,
            };
          }),
        );
      } finally {
        if (runId.current === mine) setBusy(false);
      }
    },
    [rooms, supabase],
  );

  useEffect(() => {
    if (!open) return;
    if (term.length < 2) {
      setPeople([]);
      setMessages([]);
      return;
    }
    const t = setTimeout(() => void search(term), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [open, term, search]);

  function close() {
    setOpen(false);
    setQuery("");
    setPeople([]);
    setMessages([]);
  }

  function go(href: string) {
    close();
    router.push(href);
  }

  async function openPerson(id: string) {
    setBusy(true);
    const res = await openDm(id);
    setBusy(false);
    if (res.roomId) {
      go(`/rooms/${res.roomId}`);
    }
    // If it's refused, the pairing rules said no — leave the palette open
    // rather than navigating nowhere.
  }

  const nothing =
    term.length >= 2 &&
    !busy &&
    roomHits.length === 0 &&
    people.length === 0 &&
    messages.length === 0;

  return (
    <Modal title="Search" open={open} onClose={close}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search messages, people and conversations"
          aria-label="Search"
          autoFocus
          className="h-10 rounded-full border-line/80 bg-paper pl-9 text-[14px]"
        />
      </div>

      <div className="-mx-2 mt-1 max-h-[60vh] overflow-y-auto">
        {term.length < 2 ? (
          <p className="px-3 py-8 text-center text-[13px] text-muted">
            Type at least two characters. Tip: ⌘K / Ctrl+K opens this anywhere.
          </p>
        ) : (
          <>
            {roomHits.length > 0 && (
              <>
                <SectionLabel>Conversations</SectionLabel>
                {roomHits.map((r) => (
                  <button
                    key={r.room_id}
                    type="button"
                    onClick={() => go(`/rooms/${r.room_id}`)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-mist"
                  >
                    {r.type === "dm" ? (
                      <Avatar
                        name={r.display_name}
                        size="sm"
                        userId={r.dm_other_user_id}
                      />
                    ) : (
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300">
                        <Hash className="size-4" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
                      {r.display_name}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted">
                      {r.type === "dm" ? "Direct" : "Channel"}
                    </span>
                  </button>
                ))}
              </>
            )}

            {people.length > 0 && (
              <>
                <SectionLabel>People</SectionLabel>
                {people.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => void openPerson(p.id)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-mist"
                  >
                    <Avatar name={publicDisplayName(p)} size="sm" userId={p.id} />
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
                      {publicDisplayName(p)}
                    </span>
                    <span className="shrink-0 text-[11px] capitalize text-muted">
                      {p.role}
                    </span>
                  </button>
                ))}
              </>
            )}

            {messages.length > 0 && (
              <>
                <SectionLabel>Messages</SectionLabel>
                {messages.map((m) => {
                  const ex = excerpt(m.body, term);
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => go(`/rooms/${m.roomId}?m=${m.id}`)}
                      className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-mist"
                    >
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted">
                        <MessageSquareText className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="truncate text-[13px] font-medium text-ink">
                            {m.senderName}
                            <span className="font-normal text-muted"> · {m.roomLabel}</span>
                          </span>
                          <span className="shrink-0 text-[11px] text-muted">
                            {formatWhen(m.createdAt)}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[13px] text-muted">
                          {ex.before}
                          <mark className="rounded bg-amber-200/80 px-0.5 text-ink">
                            {ex.hit}
                          </mark>
                          {ex.after}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </>
            )}

            {busy && (
              <p className="px-3 py-4 text-center text-[12px] text-muted">Searching…</p>
            )}
            {nothing && (
              <div className="px-3 py-8 text-center">
                <UserRound className="mx-auto mb-2 size-5 text-muted" />
                <p className="text-[13px] text-muted">
                  Nothing found for “{term}”.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

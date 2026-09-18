"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Hash, MessagesSquare, Search, Telescope } from "lucide-react";
import { OPEN_SEARCH_EVENT } from "@/components/GlobalSearch";
import { useRooms } from "@/components/rooms/RoomsProvider";
import { useIsOnline } from "@/components/presence/PresenceProvider";
import { Avatar } from "@/components/Avatar";
import { PresenceDot } from "@/components/PresenceDot";
import { NewDmButton } from "@/components/NewDmButton";
import { NewGroupButton } from "@/components/NewGroupButton";
import { Input } from "@/components/uikit/input";
import type { MyRoom } from "@/lib/types";

type Filter = "all" | "unread" | "channels" | "dms";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "channels", label: "Channels" },
  { key: "dms", label: "Direct" },
];

function formatTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 6);
  if (d > weekAgo) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function preview(room: MyRoom) {
  if (!room.last_message_at) return "No messages yet";
  if (room.last_message_kind === "system") return room.last_message_body ?? "";
  const body =
    room.last_message_kind === "file"
      ? `📎 ${room.last_message_body ?? "Attachment"}`
      : (room.last_message_body ?? "");
  return room.last_message_sender
    ? `${room.last_message_sender.split(" ")[0]}: ${body}`
    : body;
}

function ChatRow({ room }: { room: MyRoom }) {
  const online = useIsOnline(room.dm_other_user_id);
  const unread = room.unread_count > 0;

  return (
    <Link
      href={`/rooms/${room.room_id}`}
      className="flex items-center gap-3 px-4 transition-colors active:bg-mist"
    >
      {room.type === "dm" ? (
        <span className="relative shrink-0">
          <Avatar
            name={room.display_name}
            userId={room.dm_other_user_id}
            className="ring-1 ring-black/5"
          />
          <PresenceDot
            online={online}
            className="absolute -bottom-0.5 -right-0.5 ring-2 ring-paper"
          />
        </span>
      ) : room.avatar_url ? (
        <Avatar
          name={room.display_name}
          src={room.avatar_url}
          className="ring-1 ring-black/5"
        />
      ) : (
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 text-brand-700 ring-1 ring-brand-200/60 dark:from-brand-900/50 dark:to-brand-950 dark:text-brand-300 dark:ring-brand-800">
          <Hash className="size-5" strokeWidth={2.2} />
        </span>
      )}

      <div className="min-w-0 flex-1 border-b border-line/70 py-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <p
            className={`truncate text-[15px] text-ink ${
              unread ? "font-bold" : "font-semibold"
            }`}
          >
            {room.display_name}
          </p>
          <span
            suppressHydrationWarning
            className={`shrink-0 text-[12px] tabular-nums ${
              unread ? "font-semibold text-brand-600 dark:text-brand-300" : "text-muted"
            }`}
          >
            {formatTime(room.last_message_at)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p
            className={`truncate text-[13px] ${
              room.last_message_kind === "system"
                ? "italic text-muted"
                : unread
                  ? "font-medium text-ink-soft"
                  : "text-muted"
            }`}
          >
            {preview(room)}
          </p>
          {unread && (
            <span className="shrink-0 min-w-[1.25rem] rounded-full bg-brand-grad px-1.5 py-0.5 text-center text-[11px] font-bold leading-none text-white shadow-bubble">
              {room.unread_count > 99 ? "99+" : room.unread_count}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

/** Phone home screen: large title, search, filter chips, unified
 *  conversation list. Same live state as the desktop sidebar. */
export function MobileChatsScreen({
  canCreateGroup,
}: {
  canCreateGroup: boolean;
}) {
  const { rooms } = useRooms();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const unreadCount = rooms.filter((r) => r.unread_count > 0).length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rooms.filter((r) => {
      if (filter === "unread" && r.unread_count === 0) return false;
      if (filter === "channels" && r.type === "dm") return false;
      if (filter === "dms" && r.type !== "dm") return false;
      if (!q) return true;
      return (
        r.display_name.toLowerCase().includes(q) ||
        (r.last_message_body ?? "").toLowerCase().includes(q)
      );
    });
  }, [rooms, query, filter]);

  return (
    <div className="flex h-full flex-col bg-paper">
      <header className="shrink-0 bg-mist pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between gap-3 px-4 pt-1">
          <h1 className="text-[26px] font-extrabold tracking-tight text-ink">
            Chats
          </h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT))
              }
              aria-label="Search everything"
              title="Search messages, people and conversations"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-paper text-ink shadow-xs ring-1 ring-line/60 active:bg-mist"
            >
              <Telescope className="size-[18px]" />
            </button>
            <NewDmButton big />
            {canCreateGroup && <NewGroupButton compact big />}
          </div>
        </div>

        <div className="relative mt-2.5 px-4">
          <Search className="pointer-events-none absolute left-[30px] top-1/2 size-[18px] -translate-y-1/2 text-muted" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            className="h-11 rounded-full border-line/80 bg-paper pl-10 text-[16px] shadow-xs placeholder:text-muted"
            aria-label="Search conversations"
          />
        </div>

        <div className="no-scrollbar mt-2.5 flex gap-2 overflow-x-auto px-4 pb-3">
          {FILTERS.map((f) => {
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${
                  active
                    ? "bg-ink text-white shadow-soft"
                    : "border border-line/80 bg-paper text-muted shadow-xs active:bg-mist"
                }`}
              >
                {f.label}
                {f.key === "unread" && unreadCount > 0 && (
                  <span
                    className={`rounded-full px-1.5 py-px text-[11px] font-bold ${
                      active ? "bg-white/20 text-white" : "bg-brand-600 text-white"
                    }`}
                  >
                    {unreadCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto border-t border-line">
        {visible.length > 0 ? (
          <ul>
            {visible.map((room) => (
              <li key={room.room_id}>
                <ChatRow room={room} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-8 pb-16 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-secondary text-muted">
              <MessagesSquare className="size-7" />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-ink">
                {rooms.length === 0
                  ? "No conversations yet"
                  : "Nothing matches"}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">
                {rooms.length === 0
                  ? "Start a direct message with the compose button above."
                  : "Try a different search or filter."}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

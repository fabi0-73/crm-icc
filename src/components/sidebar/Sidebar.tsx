"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/app/actions/auth";
import { useRooms } from "@/components/rooms/RoomsProvider";
import { useIsOnline } from "@/components/presence/PresenceProvider";
import { Avatar } from "@/components/Avatar";
import { PresenceDot } from "@/components/PresenceDot";
import { NewGroupButton } from "@/components/NewGroupButton";
import { NewDmButton } from "@/components/NewDmButton";
import { HashIcon, SignOutIcon } from "@/components/icons";
import type { MyRoom, Profile } from "@/lib/types";

export const NAV: { href: string; label: string; roles: Profile["role"][] }[] = [
  { href: "/agents", label: "Agents", roles: ["admin", "manager"] },
  { href: "/admin/users", label: "Users", roles: ["admin", "manager"] },
  { href: "/admin/audit", label: "Audit", roles: ["admin", "manager"] },
];

function UnreadBadge({ count, active }: { count: number; active: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className={`ml-auto min-w-[1.1rem] shrink-0 rounded-full px-1.5 text-center text-[11px] font-semibold leading-[1.1rem] ${
        active ? "bg-white text-brand-700" : "bg-brand-500 text-white"
      }`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function RoomRow({ room, active }: { room: MyRoom; active: boolean }) {
  const online = useIsOnline(room.dm_other_user_id);
  const unread = room.unread_count > 0;
  return (
    <Link
      href={`/rooms/${room.room_id}`}
      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors ${
        active
          ? "bg-brand-grad font-medium text-white shadow-bubble"
          : "text-white/60 hover:bg-white/8 hover:text-white"
      }`}
    >
      {room.type === "dm" ? (
        <span className="relative shrink-0">
          <Avatar name={room.display_name} size="sm" className="!h-5 !w-5 !text-[9px]" />
          <PresenceDot
            online={online}
            className="absolute -bottom-0.5 -right-0.5 ring-2 ring-ink"
          />
        </span>
      ) : room.avatar_url ? (
        <Avatar
          name={room.display_name}
          size="sm"
          src={room.avatar_url}
          className="!h-5 !w-5"
        />
      ) : (
        <HashIcon className="shrink-0 opacity-70" />
      )}
      <span className={`truncate ${unread && !active ? "font-semibold text-white" : ""}`}>
        {room.display_name}
      </span>
      <UnreadBadge count={room.unread_count} active={active} />
    </Link>
  );
}

function SectionHeader({
  label,
  action,
}: {
  label: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mt-4 mb-1 flex items-center justify-between px-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-white/40">
        {label}
      </p>
      {action}
    </div>
  );
}

export function Sidebar({ profile }: { profile: Profile }) {
  const { rooms } = useRooms();
  const pathname = usePathname();
  const selfOnline = useIsOnline(profile.id);

  const channels = rooms.filter((r) => r.type !== "dm");
  const dms = rooms.filter((r) => r.type === "dm");
  const canManage = profile.role === "admin" || profile.role === "manager";
  const nav = NAV.filter((n) => n.roles.includes(profile.role));

  return (
    <aside className="hidden sm:flex w-64 shrink-0 flex-col border-r border-white/5 bg-ink-grad text-white">
      <Link
        href="/rooms"
        className="flex items-center gap-2.5 border-b border-white/10 px-3 py-3"
      >
        <span className="rounded-lg bg-white p-[3px] shadow-soft">
          <Image src="/logo-sm.png" alt="ICC" width={22} height={20} className="rounded-md" priority />
        </span>
        <span className="text-[15px] font-bold tracking-tight">
          ICC Desk
        </span>
      </Link>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {nav.length > 0 && (
          <nav className="mt-3 space-y-0.5">
            {nav.map((l) => {
              const active =
                pathname === l.href || pathname.startsWith(`${l.href}/`);
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`block rounded-lg px-2 py-1.5 text-[13px] font-medium transition-colors ${
                    active
                      ? "bg-brand-grad text-white shadow-bubble"
                      : "text-white/60 hover:bg-white/8 hover:text-white"
                  }`}
                >
                  {l.label}
                </Link>
              );
            })}
          </nav>
        )}

        <SectionHeader
          label="Channels"
          action={canManage ? <NewGroupButton compact dark /> : undefined}
        />
        <div className="space-y-0.5">
          {channels.map((r) => (
            <RoomRow
              key={r.room_id}
              room={r}
              active={pathname === `/rooms/${r.room_id}`}
            />
          ))}
          {channels.length === 0 && (
            <p className="px-2 py-1 text-[12px] text-white/40">No channels yet</p>
          )}
        </div>

        <SectionHeader label="Direct messages" action={<NewDmButton dark />} />
        <div className="space-y-0.5">
          {dms.map((r) => (
            <RoomRow
              key={r.room_id}
              room={r}
              active={pathname === `/rooms/${r.room_id}`}
            />
          ))}
          {dms.length === 0 && (
            <p className="px-2 py-1 text-[12px] text-white/40">
              No direct messages yet
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 border-t border-white/10 bg-white/[0.04] px-3 py-2.5">
        <Link
          href="/account"
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-0.5 hover:bg-white/10"
          title="Account & password"
        >
          <span className="relative shrink-0">
            <Avatar name={profile.full_name} size="sm" className="!h-7 !w-7 !text-[10px]" />
            <PresenceDot
              online={selfOnline}
              className="absolute -bottom-0.5 -right-0.5 ring-2 ring-ink"
            />
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {profile.full_name}
          </span>
        </Link>
        <form action={signOut}>
          <button
            type="submit"
            className="rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white"
            aria-label="Sign out"
            title="Sign out"
          >
            <SignOutIcon />
          </button>
        </form>
      </div>
    </aside>
  );
}

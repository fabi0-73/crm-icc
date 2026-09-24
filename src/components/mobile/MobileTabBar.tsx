"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronRight,
  ContactRound,
  LogOut,
  MessageCircle,
  ScrollText,
  UserCog,
} from "lucide-react";
import { signOut } from "@/app/actions/auth";
import { useRooms } from "@/components/rooms/RoomsProvider";
import { useIsOnline } from "@/components/presence/PresenceProvider";
import { Avatar } from "@/components/Avatar";
import { publicDisplayName } from "@/lib/display-name";
import { PresenceDot } from "@/components/PresenceDot";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/uikit/drawer";
import type { Profile } from "@/lib/types";

/** Admin destinations that live inside the "You" drawer on mobile. */
const DRAWER_NAV: {
  href: string;
  label: string;
  sub: string;
  roles: Profile["role"][];
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    href: "/agents",
    label: "Agents",
    sub: "Directory and assignments",
    roles: ["admin"],
    icon: ContactRound,
  },
  {
    href: "/admin/users",
    label: "User management",
    sub: "Create staff logins and reset passwords",
    roles: ["admin", "manager"],
    icon: UserCog,
  },
  {
    href: "/admin/audit",
    label: "Audit log",
    sub: "Recent admin activity",
    roles: ["admin", "manager"],
    icon: ScrollText,
  },
];

function TabButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1"
    >
      <span
        className={`relative flex h-8 min-w-14 items-center justify-center rounded-full transition-colors ${
          active ? "bg-brand-600 text-white" : "text-white/60"
        }`}
      >
        {children}
      </span>
      <span
        className={`text-[11px] font-medium ${
          active ? "text-white" : "text-white/60"
        }`}
      >
        {label}
      </span>
    </button>
  );
}

/** Bottom navigation for phones — the mobile face of the dark desktop
 *  sidebar. Hidden inside a conversation so chat gets the full screen. */
export function MobileTabBar({ profile }: { profile: Profile }) {
  const pathname = usePathname();
  const router = useRouter();
  const { rooms } = useRooms();
  const [youOpen, setYouOpen] = useState(false);
  const selfOnline = useIsOnline(profile.id);

  // Conversations are immersive — no bar inside a room.
  if (/^\/rooms\/[0-9a-f-]{36}/.test(pathname)) return null;

  const unread = rooms.reduce((n, r) => n + r.unread_count, 0);
  const drawerNav = DRAWER_NAV.filter((n) => n.roles.includes(profile.role));
  const chatsActive = pathname === "/rooms" || pathname.startsWith("/rooms/");
  const agentsActive = pathname.startsWith("/agents");
  const showAgentsTab = drawerNav.some((n) => n.href === "/agents");

  return (
    <>
      <nav
        className="shrink-0 border-t border-white/10 bg-ink-grad pb-[env(safe-area-inset-bottom)] sm:hidden"
        aria-label="Primary"
      >
        <div className="flex items-stretch px-2">
          <TabButton
            active={chatsActive}
            label="Chats"
            onClick={() => router.push("/rooms")}
          >
            <MessageCircle className="size-[22px]" strokeWidth={1.75} />
            {unread > 0 && (
              <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand-300 px-1 text-[10px] font-bold text-[#0a2e33] ring-2 ring-[#131519]">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </TabButton>

          {showAgentsTab && (
            <TabButton
              active={agentsActive}
              label="Agents"
              onClick={() => router.push("/agents")}
            >
              <ContactRound className="size-[22px]" strokeWidth={1.75} />
            </TabButton>
          )}

          <TabButton active={youOpen} label="You" onClick={() => setYouOpen(true)}>
            <Avatar
              name={publicDisplayName(profile)}
              size="sm"
              userId={profile.id}
              className="!h-6 !w-6 !text-[9px]"
            />
          </TabButton>
        </div>
      </nav>

      <Drawer open={youOpen} onOpenChange={setYouOpen} showSwipeHandle>
        <DrawerContent>
          <DrawerHeader className="sr-only">
            <DrawerTitle>Your account</DrawerTitle>
          </DrawerHeader>

          <div className="px-4 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
            <Link
              href="/account"
              onClick={() => setYouOpen(false)}
              className="-mx-2 flex items-center gap-3 rounded-2xl px-2 py-3 active:bg-mist"
            >
              <span className="relative shrink-0">
                <Avatar name={publicDisplayName(profile)} userId={profile.id} />
                <PresenceDot
                  online={selfOnline}
                  className="absolute -bottom-0.5 -right-0.5 ring-2 ring-paper"
                />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-ink">
                  {publicDisplayName(profile)}
                </p>
                <p className="text-[13px] text-muted">
                  Account &amp; password
                </p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-line-strong" />
            </Link>

            {drawerNav.length > 0 && (
              <div className="mt-1 overflow-hidden rounded-2xl border border-line bg-paper">
                {drawerNav.map((item, i) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setYouOpen(false)}
                    className={`flex items-center gap-3 px-3.5 py-3 active:bg-mist ${
                      i > 0 ? "border-t border-line" : ""
                    }`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-secondary text-ink-soft">
                      <item.icon className="size-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium text-ink">
                        {item.label}
                      </span>
                      <span className="block text-[12px] text-muted">
                        {item.sub}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-line-strong" />
                  </Link>
                ))}
              </div>
            )}

            <form action={signOut} className="mt-3">
              <button
                type="submit"
                className="flex w-full items-center gap-3 rounded-2xl border border-line bg-paper px-3.5 py-3 text-left active:bg-mist"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400">
                  <LogOut className="size-[18px]" />
                </span>
                <span className="text-[15px] font-medium text-red-600 dark:text-red-400">
                  Sign out
                </span>
              </button>
            </form>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}

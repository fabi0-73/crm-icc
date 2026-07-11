"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/app/actions/auth";
import type { Profile } from "@/lib/types";

const NAV: { href: string; label: string; roles: Profile["role"][] }[] = [
  { href: "/rooms", label: "Chats", roles: ["admin", "manager", "assistant"] },
  { href: "/agents", label: "Agents", roles: ["admin", "manager"] },
  { href: "/admin/users", label: "Users", roles: ["admin"] },
  { href: "/admin/audit", label: "Audit", roles: ["admin", "manager"] },
];

export function AppShell({
  profile,
  children,
}: {
  profile: Profile;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const links = NAV.filter((n) => n.roles.includes(profile.role));

  return (
    <div className="flex h-dvh flex-col bg-mist">
      <header className="shrink-0 border-b border-line bg-paper">
        <div className="flex items-center justify-between gap-3 px-3 py-2.5 sm:px-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/rooms" prefetch className="flex items-center gap-2 shrink-0">
              <Image
                src="/logo-sm.png"
                alt="ICC"
                width={32}
                height={30}
                className="rounded-md"
                priority
              />
              <span className="text-[15px] font-semibold tracking-tight text-ink">
                ICC Desk
              </span>
            </Link>
            <nav className="hidden sm:flex items-center gap-0.5 ml-2">
              {links.map((l) => {
                const active =
                  pathname === l.href || pathname.startsWith(`${l.href}/`);
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    prefetch
                    className={`rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
                      active
                        ? "bg-brand-50 text-brand-700"
                        : "text-muted hover:bg-mist hover:text-ink"
                    }`}
                  >
                    {l.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <nav className="flex sm:hidden gap-0.5 overflow-x-auto max-w-[40vw]">
              {links.map((l) => {
                const active =
                  pathname === l.href || pathname.startsWith(`${l.href}/`);
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    prefetch
                    className={`rounded-md px-2 py-1 text-xs font-medium ${
                      active ? "bg-brand-50 text-brand-700" : "text-muted"
                    }`}
                  >
                    {l.label}
                  </Link>
                );
              })}
            </nav>
            <span className="hidden md:inline text-[13px] text-muted truncate max-w-[8rem]">
              {profile.full_name}
            </span>
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-mist hover:text-ink"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="flex-1 min-h-0 overflow-hidden">{children}</main>
    </div>
  );
}

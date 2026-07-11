"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "@/app/actions/auth";
import { NAV } from "@/components/sidebar/Sidebar";
import type { Profile } from "@/lib/types";

/** Mobile-only top bar — desktop navigation lives in the Sidebar. */
export function MobileTopBar({ profile }: { profile: Profile }) {
  const pathname = usePathname();
  const links = [
    { href: "/rooms", label: "Chats", roles: ["admin", "manager", "assistant"] as Profile["role"][] },
    ...NAV,
  ].filter((n) => n.roles.includes(profile.role));

  return (
    <header className="shrink-0 border-b border-line bg-paper sm:hidden">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <Link href="/rooms" prefetch className="flex items-center gap-2 shrink-0">
          <Image
            src="/logo-sm.png"
            alt="ICC"
            width={28}
            height={26}
            className="rounded-md"
            priority
          />
        </Link>
        <nav className="flex gap-0.5 overflow-x-auto">
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
        <form action={signOut}>
          <button
            type="submit"
            className="rounded-md px-2 py-1 text-xs font-medium text-muted hover:bg-mist hover:text-ink"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

"use client";

import { RoomsProvider } from "@/components/rooms/RoomsProvider";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { MobileTopBar } from "@/components/AppShell";
import type { MyRoom, Profile } from "@/lib/types";

/** Staff shell: persistent sidebar on desktop, top bar + stacked flow
 *  on mobile. Owns the live room-list state for both. */
export function SidebarShell({
  profile,
  initialRooms,
  children,
}: {
  profile: Profile;
  initialRooms: MyRoom[];
  children: React.ReactNode;
}) {
  return (
    <RoomsProvider initialRooms={initialRooms} currentUserId={profile.id}>
      <div className="flex h-dvh flex-col bg-mist sm:flex-row">
        <MobileTopBar profile={profile} />
        <Sidebar profile={profile} />
        <main className="flex-1 min-h-0 overflow-hidden">{children}</main>
      </div>
    </RoomsProvider>
  );
}

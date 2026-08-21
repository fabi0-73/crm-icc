"use client";

import { RoomsProvider } from "@/components/rooms/RoomsProvider";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { MobileTabBar } from "@/components/mobile/MobileTabBar";
import type { MyRoom, Profile } from "@/lib/types";

/** Staff shell: persistent sidebar on desktop, bottom tab bar on
 *  mobile. Owns the live room-list state for both. */
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
      <div className="flex h-app flex-col bg-mist sm:flex-row">
        <Sidebar profile={profile} />
        <main className="flex-1 min-h-0 overflow-hidden">{children}</main>
        <MobileTabBar profile={profile} />
      </div>
    </RoomsProvider>
  );
}

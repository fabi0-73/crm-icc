import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { SidebarShell } from "@/components/sidebar/SidebarShell";
import { CallProvider } from "@/components/call/CallProvider";
import { PresenceProvider } from "@/components/presence/PresenceProvider";
import { requireProfile } from "@/lib/auth";
import { sitePath } from "@/lib/site-url";
import type { MyRoom } from "@/lib/types";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  try {
    const { supabase, profile } = await requireProfile();
    // CallProvider + PresenceProvider wrap BOTH branches so agents
    // ring and register presence too; agents keep the bare layout.
    if (profile.role === "agent") {
      return (
        <CallProvider userId={profile.id} userName={profile.full_name}>
          <PresenceProvider userId={profile.id}>
            <div className="h-dvh">{children}</div>
          </PresenceProvider>
        </CallProvider>
      );
    }
    const { data } = await supabase.rpc("get_my_rooms");
    return (
      <CallProvider userId={profile.id} userName={profile.full_name}>
        <PresenceProvider userId={profile.id}>
          <SidebarShell
            profile={profile}
            initialRooms={(data ?? []) as MyRoom[]}
          >
            {children}
          </SidebarShell>
        </PresenceProvider>
      </CallProvider>
    );
  } catch {
    const h = await headers();
    redirect(sitePath("/login", h));
  }
}

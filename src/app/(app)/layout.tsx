import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { SidebarShell } from "@/components/sidebar/SidebarShell";
import { CallProvider } from "@/components/call/CallProvider";
import { PresenceProvider } from "@/components/presence/PresenceProvider";
import { KeyboardInsets } from "@/components/mobile/KeyboardInsets";
import { MuteProvider } from "@/components/mute/MuteProvider";
import { NotificationProvider } from "@/components/notifications/NotificationProvider";
import { requireProfile } from "@/lib/auth";
import { sitePath } from "@/lib/site-url";
import { publicDisplayName } from "@/lib/display-name";
import type { MyRoom } from "@/lib/types";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Only the identity lookup may bounce the request; a failing rooms
  // query must surface as an error, not as a redirect to a page that
  // sends the (valid) session straight back here.
  let ctx;
  try {
    ctx = await requireProfile();
  } catch {
    // The session is real but unusable (deactivated or missing profile).
    // Clear it in the route handler — a layout cannot write cookies, and
    // /login would bounce this still-valid session back to /rooms.
    const h = await headers();
    redirect(sitePath("/auth/signout?reason=inactive", h));
  }

  const { supabase, profile } = ctx;

  const displayName = publicDisplayName(profile);

  // CallProvider + PresenceProvider wrap BOTH branches so agents
  // ring and register presence too; agents keep the bare layout.
  if (profile.role === "agent") {
    return (
      <MuteProvider userId={profile.id}>
        <NotificationProvider userId={profile.id}>
        <CallProvider userId={profile.id} userName={displayName}>
          <PresenceProvider userId={profile.id}>
            <KeyboardInsets />
            <div className="h-app">{children}</div>
          </PresenceProvider>
        </CallProvider>
        </NotificationProvider>
      </MuteProvider>
    );
  }

  const { data } = await supabase.rpc("get_my_rooms");
  return (
    <MuteProvider userId={profile.id}>
      <NotificationProvider userId={profile.id}>
      <CallProvider userId={profile.id} userName={displayName}>
        <PresenceProvider userId={profile.id}>
          <KeyboardInsets />
          <SidebarShell profile={profile} initialRooms={(data ?? []) as MyRoom[]}>
            {children}
          </SidebarShell>
        </PresenceProvider>
      </CallProvider>
      </NotificationProvider>
    </MuteProvider>
  );
}

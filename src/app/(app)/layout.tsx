import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { SidebarShell } from "@/components/sidebar/SidebarShell";
import { CallProvider } from "@/components/call/CallProvider";
import { PresenceProvider } from "@/components/presence/PresenceProvider";
import { ProfileAvatarsProvider } from "@/components/presence/ProfileAvatarsProvider";
import { KeyboardInsets } from "@/components/mobile/KeyboardInsets";
import { PushRegistrar } from "@/components/PushRegistrar";
import { NotificationPrompt } from "@/components/NotificationPrompt";
import { requireProfile } from "@/lib/auth";
import { sitePath } from "@/lib/site-url";
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

  // Everyone — agents included — gets the sidebar dashboard now. Agents have
  // their workspace and any agent↔assistant DMs to navigate between, so they
  // get the same groups + direct-messages rail as staff (get_my_rooms is
  // membership-keyed, so it simply returns the rooms the agent belongs to).
  const { data } = await supabase.rpc("get_my_rooms");
  return (
    <ProfileAvatarsProvider
      initial={{ [profile.id]: profile.avatar_url ?? null }}
    >
      <CallProvider
        userId={profile.id}
        userName={profile.full_name}
        userRole={profile.role}
      >
        <PresenceProvider userId={profile.id}>
          <KeyboardInsets />
          <PushRegistrar />
          <NotificationPrompt />
          <SidebarShell
            profile={profile}
            initialRooms={(data ?? []) as MyRoom[]}
          >
            {children}
          </SidebarShell>
        </PresenceProvider>
      </CallProvider>
    </ProfileAvatarsProvider>
  );
}

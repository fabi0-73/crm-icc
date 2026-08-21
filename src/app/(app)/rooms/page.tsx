import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireProfile } from "@/lib/auth";
import { MobileChatsScreen } from "@/components/rooms/MobileChatsScreen";
import { sitePath } from "@/lib/site-url";

export default async function RoomsPage() {
  const { supabase, profile } = await requireProfile();

  if (profile.role === "agent") {
    const { data: agent } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", profile.id)
      .maybeSingle();
    if (agent) {
      const { data: room } = await supabase
        .from("rooms")
        .select("id")
        .eq("agent_id", agent.id)
        .eq("type", "agent_workspace")
        .maybeSingle();
      if (room) {
        const h = await headers();
        redirect(sitePath(`/rooms/${room.id}`, h));
      }
    }
  }

  const canCreateGroup =
    profile.role === "admin" || profile.role === "manager";

  return (
    <>
      {/* Mobile: the full chats home (live via RoomsProvider). */}
      <div className="h-full sm:hidden">
        <MobileChatsScreen canCreateGroup={canCreateGroup} />
      </div>
      {/* Desktop: the sidebar already lists everything. */}
      <div className="hidden h-full items-center justify-center bg-paper sm:flex">
        <div className="text-center">
          <p className="text-sm font-medium text-ink">Select a conversation</p>
          <p className="mt-1 text-[13px] text-muted">
            Pick a channel or direct message from the sidebar.
          </p>
        </div>
      </div>
    </>
  );
}

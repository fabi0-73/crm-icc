import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireProfile } from "@/lib/auth";
import { MobileRoomList } from "@/components/rooms/MobileRoomList";
import { NewGroupButton } from "@/components/NewGroupButton";
import { PageHeader } from "@/components/ui/PageHeader";
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
      {/* Mobile: the full-screen conversation list (live via RoomsProvider). */}
      <div className="flex h-full flex-col bg-paper sm:hidden">
        <PageHeader
          title="Chats"
          actions={canCreateGroup ? <NewGroupButton /> : undefined}
        />
        <div className="flex-1 min-h-0">
          <MobileRoomList />
        </div>
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

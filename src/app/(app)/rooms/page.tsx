import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireProfile } from "@/lib/auth";
import { LiveRoomList } from "@/components/LiveRoomList";
import { NewGroupButton } from "@/components/NewGroupButton";
import { PageHeader } from "@/components/ui/PageHeader";
import type { MyRoom } from "@/lib/types";
import { sitePath } from "@/lib/site-url";

export default async function RoomsPage() {
  const { supabase, profile, user } = await requireProfile();

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

  const { data, error } = await supabase.rpc("get_my_rooms");
  if (error) {
    return (
      <div className="p-6 text-sm text-red-700">
        Failed to load rooms: {error.message}
      </div>
    );
  }

  const rooms = (data ?? []) as MyRoom[];
  const canCreateGroup =
    profile.role === "admin" || profile.role === "manager";

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col bg-paper sm:border-x sm:border-line">
      <PageHeader
        title="Chats"
        actions={canCreateGroup ? <NewGroupButton /> : undefined}
      />
      <div className="flex-1 min-h-0">
        <LiveRoomList initialRooms={rooms} currentUserId={user.id} />
      </div>
    </div>
  );
}

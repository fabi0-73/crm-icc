import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { ChatRoom } from "@/components/ChatRoom";
import { fetchRecentMessages } from "@/lib/supabase/realtime";
import type { Profile } from "@/lib/types";

export default async function RoomPage({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  const { supabase, user, profile } = await requireProfile();

  const { data: room } = await supabase
    .from("rooms")
    .select("id, name, type")
    .eq("id", roomId)
    .maybeSingle();

  if (!room) notFound();

  if (profile.role === "agent" && room.type !== "agent_workspace") {
    notFound();
  }

  const { data: memberRows } = await supabase
    .from("room_members")
    .select("user_id")
    .eq("room_id", roomId);

  const memberIds = (memberRows ?? []).map((m) => m.user_id);
  const { data: memberProfiles } = await supabase
    .from("profiles")
    .select("id, full_name, role")
    .in(
      "id",
      memberIds.length ? memberIds : ["00000000-0000-0000-0000-000000000000"],
    );

  const messages = await fetchRecentMessages(supabase, roomId, 100);

  return (
    <ChatRoom
      roomId={room.id}
      roomName={room.name}
      currentUserId={user.id}
      members={
        (memberProfiles ?? []) as Pick<Profile, "id" | "full_name" | "role">[]
      }
      initialMessages={messages}
    />
  );
}

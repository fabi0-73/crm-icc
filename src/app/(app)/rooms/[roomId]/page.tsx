import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { ChatRoom } from "@/components/ChatRoom";
import { JoinRoomPrompt } from "@/components/JoinRoomPrompt";
import { fetchRecentMessages } from "@/lib/supabase/realtime";
import type { Profile, RoomType } from "@/lib/types";

/** First page of history; older messages load on demand. */
const INITIAL_MESSAGES = 60;

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
    .maybeSingle<{ id: string; name: string; type: RoomType }>();

  if (!room) notFound();

  if (profile.role === "agent" && room.type !== "agent_workspace") {
    notFound();
  }

  // Admin/manager row-level access lets them SEE any room, but messages
  // need a membership row — offer to join instead of an empty, unusable
  // chat. DMs are private: never joinable.
  const { data: membership } = await supabase
    .from("room_members")
    .select("user_id")
    .eq("room_id", roomId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership) {
    const canJoin =
      room.type !== "dm" &&
      (profile.role === "admin" || profile.role === "manager");
    if (!canJoin) notFound();
    return <JoinRoomPrompt roomId={room.id} roomName={room.name} />;
  }

  const { data: memberRows } = await supabase
    .from("room_members")
    .select("user_id")
    .eq("room_id", roomId);

  const memberIds = (memberRows ?? []).map((m) => m.user_id);
  const { data: memberProfiles } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active")
    .in(
      "id",
      memberIds.length ? memberIds : ["00000000-0000-0000-0000-000000000000"],
    );

  const messages = await fetchRecentMessages(
    supabase,
    roomId,
    INITIAL_MESSAGES,
  );

  const memberList = (memberProfiles ?? []) as Pick<
    Profile,
    "id" | "full_name" | "role" | "is_active"
  >[];
  const dmOther =
    room.type === "dm"
      ? (memberList.find((m) => m.id !== user.id) ?? null)
      : null;

  return (
    <ChatRoom
      roomId={room.id}
      roomName={dmOther ? dmOther.full_name : room.name}
      roomType={room.type}
      dmOtherUserId={dmOther?.id ?? null}
      currentUserId={user.id}
      members={memberList}
      initialMessages={messages}
      hasOlder={messages.length === INITIAL_MESSAGES}
      leading={profile.role === "agent" ? "account" : "back"}
    />
  );
}

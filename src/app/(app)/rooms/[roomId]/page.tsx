import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { ChatRoom } from "@/components/ChatRoom";
import { JoinRoomPrompt } from "@/components/JoinRoomPrompt";
import { fetchRecentMessages } from "@/lib/supabase/realtime";
import type { RoomMemberRole, RoomMemberView, RoomType } from "@/lib/types";
import { publicDisplayName } from "@/lib/display-name";

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
    .select("id, name, type, avatar_url, background_url")
    .eq("id", roomId)
    .maybeSingle<{
      id: string;
      name: string;
      type: RoomType;
      avatar_url: string | null;
      background_url: string | null;
    }>();

  if (!room) notFound();

  if (profile.role === "agent" && room.type !== "agent_workspace" && room.type !== "dm") {
    notFound();
  }

  // Admin/manager row-level access lets them SEE any room, but messages
  // need a membership row — offer to join instead of an empty, unusable
  // chat. DMs are private: never joinable.
  const { data: membership } = await supabase
    .from("room_members")
    .select("user_id, role")
    .eq("room_id", roomId)
    .eq("user_id", user.id)
    .maybeSingle<{ user_id: string; role: RoomMemberRole }>();

  if (!membership) {
    if (profile.role === "admin") {
      // Admins may read any conversation without joining.
    } else {
      const canJoin = room.type !== "dm" && profile.role === "manager";
      if (!canJoin) notFound();
      return <JoinRoomPrompt roomId={room.id} roomName={room.name} />;
    }
  }

  const { data: memberRows } = await supabase
    .from("room_members")
    .select("user_id, role, last_read_at, last_delivered_at")
    .eq("room_id", roomId);

  const roleById = new Map<string, RoomMemberRole>(
    (memberRows ?? []).map((m) => [m.user_id, m.role as RoomMemberRole]),
  );
  const readById = new Map(
    (memberRows ?? []).map((m) => [
      m.user_id,
      {
        last_read_at: (m as { last_read_at?: string }).last_read_at ?? null,
        last_delivered_at:
          (m as { last_delivered_at?: string }).last_delivered_at ?? null,
      },
    ]),
  );
  const memberIds = [...roleById.keys()];
  const { data: memberProfiles } = await supabase
    .from("profiles")
    .select("id, full_name, public_name, avatar_url, role, is_active")
    .in(
      "id",
      memberIds.length ? memberIds : ["00000000-0000-0000-0000-000000000000"],
    );

  const messages = await fetchRecentMessages(
    supabase,
    roomId,
    INITIAL_MESSAGES,
  );

  const memberList: RoomMemberView[] = (memberProfiles ?? []).map((p) => ({
    id: p.id,
    full_name: p.full_name,
    public_name: (p as { public_name?: string | null }).public_name ?? null,
    avatar_url: (p as { avatar_url?: string | null }).avatar_url ?? null,
    role: p.role,
    is_active: p.is_active,
    room_role: roleById.get(p.id) ?? "member",
    last_read_at: readById.get(p.id)?.last_read_at ?? null,
    last_delivered_at: readById.get(p.id)?.last_delivered_at ?? null,
  }));
  const dmOther =
    room.type === "dm"
      ? (memberList.find((m) => m.id !== user.id) ?? null)
      : null;

  return (
    <ChatRoom
      // Remount per room: without this the previous conversation's
      // messages stay in state while the new ones stream in.
      key={room.id}
      roomId={room.id}
      roomName={dmOther ? publicDisplayName(dmOther) : room.name}
      roomType={room.type}
      roomAvatarUrl={room.avatar_url}
      roomBackgroundUrl={room.type === "group" ? room.background_url : null}
      dmOtherUserId={dmOther?.id ?? null}
      currentUserId={user.id}
      currentUserRole={profile.role}
      myRoomRole={membership?.role ?? "member"}
      members={memberList}
      initialMessages={messages}
      hasOlder={messages.length === INITIAL_MESSAGES}
      leading={profile.role === "agent" && room.type === "agent_workspace" ? "account" : "back"}
      readOnly={!membership}
    />
  );
}

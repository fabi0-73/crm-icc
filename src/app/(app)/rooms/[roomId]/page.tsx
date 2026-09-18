import { notFound } from "next/navigation";
import { publicDisplayName } from "@/lib/display-name";
import { requireProfile } from "@/lib/auth";
import { ChatRoom } from "@/components/ChatRoom";
import { JoinRoomPrompt } from "@/components/JoinRoomPrompt";
import { fetchRecentMessages } from "@/lib/supabase/realtime";
import type { RoomMemberRole, RoomMemberView, RoomType } from "@/lib/types";

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
    .select("id, name, type, avatar_url, background_url, created_by")
    .eq("id", roomId)
    .maybeSingle<{
      id: string;
      name: string;
      type: RoomType;
      avatar_url: string | null;
      background_url: string | null;
      created_by: string;
    }>();

  if (!room) notFound();

  // Agents live in their workspace; they may also open a DM they belong
  // to (membership is enforced below, so a non-member agent still 404s).
  // Group rooms stay off-limits to agents.
  if (
    profile.role === "agent" &&
    room.type !== "agent_workspace" &&
    room.type !== "dm"
  ) {
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

  // A non-member with row-level read access: an admin drops straight into
  // a READ-ONLY view (read history without joining); a manager still gets
  // the join prompt; everyone else — and any non-member on a private DM —
  // gets a 404.
  const readOnly = !membership;
  if (!membership) {
    if (room.type === "dm") notFound();
    if (profile.role === "manager") {
      return <JoinRoomPrompt roomId={room.id} roomName={room.name} />;
    }
    if (profile.role !== "admin") notFound();
    // admin → fall through and render the room read-only
  }

  const { data: memberRows } = await supabase
    .from("room_members")
    .select("user_id, role, last_read_at, last_delivered_at")
    .eq("room_id", roomId);

  const roleById = new Map<string, RoomMemberRole>(
    (memberRows ?? []).map((m) => [m.user_id, m.role as RoomMemberRole]),
  );
  // Seeds per-message "seen" state on first paint; the live room_members
  // subscription keeps it current thereafter.
  const readAtById = new Map<string, string | null>(
    (memberRows ?? []).map((m) => [
      m.user_id,
      (m as { last_read_at: string | null }).last_read_at ?? null,
    ]),
  );
  const deliveredAtById = new Map<string, string | null>(
    (memberRows ?? []).map((m) => [
      m.user_id,
      (m as { last_delivered_at: string | null }).last_delivered_at ?? null,
    ]),
  );
  const memberIds = [...roleById.keys()];
  const { data: memberProfiles } = await supabase
    .from("profiles")
    .select("id, full_name, public_name, role, is_active, avatar_url")
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
    role: p.role,
    is_active: p.is_active,
    room_role: roleById.get(p.id) ?? "member",
    last_read_at: readAtById.get(p.id) ?? null,
    last_delivered_at: deliveredAtById.get(p.id) ?? null,
    avatar_url: (p as { avatar_url: string | null }).avatar_url ?? null,
    public_name: (p as { public_name: string | null }).public_name ?? null,
  }));
  const dmOther =
    room.type === "dm"
      ? (memberList.find((m) => m.id !== user.id) ?? null)
      : null;

  return (
    <ChatRoom
      // Force a fresh instance per room: without it the component's message,
      // scroll and composer state depends on Next choosing to remount, and a
      // reused instance would interleave the previous room's messages.
      key={room.id}
      roomId={room.id}
      roomName={dmOther ? publicDisplayName(dmOther) : room.name}
      roomType={room.type}
      roomAvatarUrl={room.avatar_url}
      roomBackgroundUrl={room.type === "group" ? room.background_url : null}
      roomCreatedBy={room.created_by}
      dmOtherUserId={dmOther?.id ?? null}
      currentUserId={user.id}
      currentUserRole={profile.role}
      myRoomRole={membership?.role ?? "member"}
      members={memberList}
      initialMessages={messages}
      hasOlder={messages.length === INITIAL_MESSAGES}
      leading="back"
      readOnly={readOnly}
    />
  );
}

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { Message, RoomMemberRole, RoomMemberView } from "@/lib/types";

type MessageHandler = (message: Message) => void;

export type TypingEvent = { user_id: string };

/**
 * Subscribe to new messages in a room. Caller must refresh the realtime
 * auth token on JWT refresh (see ensureRealtimeAuth). Optionally also
 * receives ephemeral typing broadcasts on the same channel.
 */
export function subscribeToRoomMessages(
  supabase: SupabaseClient,
  roomId: string,
  onInsert: MessageHandler,
  onTyping?: (event: TypingEvent) => void,
  onSubscribed?: () => void,
  onUpdate?: MessageHandler,
): RealtimeChannel {
  const channel = supabase.channel(`room:${roomId}`).on(
    "postgres_changes",
    {
      event: "INSERT",
      schema: "public",
      table: "messages",
      filter: `room_id=eq.${roomId}`,
    },
    (payload) => {
      onInsert(payload.new as Message);
    },
  );
  // Pinning is an UPDATE on an existing row, so it needs its own binding
  // for the banner to move without a refresh.
  if (onUpdate) {
    channel.on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "messages",
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        onUpdate(payload.new as Message);
      },
    );
  }
  if (onTyping) {
    channel.on("broadcast", { event: "typing" }, ({ payload }) => {
      onTyping(payload as TypingEvent);
    });
  }
  // Fires on the initial join AND every rejoin after the socket drops, so
  // the caller can pull whatever was inserted while it was not listening.
  return channel.subscribe((status) => {
    if (status === "SUBSCRIBED") onSubscribed?.();
  });
}

/** Ephemeral "I'm typing" ping to everyone else in the room's channel. */
export function sendTyping(channel: RealtimeChannel, userId: string) {
  void channel.send({
    type: "broadcast",
    event: "typing",
    payload: { user_id: userId } satisfies TypingEvent,
  });
}

/**
 * Watch the membership of one room. Fires on INSERT/UPDATE/DELETE of
 * room_members for this room so the roster (and each viewer's own
 * standing) updates live — someone added, removed, promoted, or leaving
 * lands without a refresh. The callback just says "something changed";
 * the caller re-reads the authoritative roster.
 */
export function subscribeToRoomMembers(
  supabase: SupabaseClient,
  roomId: string,
  onChange: () => void,
): RealtimeChannel {
  return supabase
    .channel(`room_members:${roomId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "room_members",
        filter: `room_id=eq.${roomId}`,
      },
      () => onChange(),
    )
    .subscribe();
}

/**
 * Watch the current user's own membership rows across all rooms, so the
 * room list reacts when they are added to or removed from a room. The
 * filter is on user_id, so it only ever carries this user's rows (RLS
 * agrees), and the callback re-reads the list authoritatively.
 */
export function subscribeToMyMembershipChanges(
  supabase: SupabaseClient,
  userId: string,
  onChange: () => void,
): RealtimeChannel {
  return supabase
    .channel(`my_memberships:${userId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "room_members",
        filter: `user_id=eq.${userId}`,
      },
      () => onChange(),
    )
    .subscribe();
}

/** Global INSERT listener for room-list unread badges. */
export function subscribeToAllMessageInserts(
  supabase: SupabaseClient,
  onInsert: MessageHandler,
): RealtimeChannel {
  return supabase
    .channel("messages:all")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      (payload) => {
        onInsert(payload.new as Message);
      },
    )
    .subscribe();
}

/** Clients that already have a token listener attached. */
const authListenerAttached = new WeakSet<SupabaseClient>();

/**
 * Keep realtime auth in sync with the session JWT. Called on every room
 * visit, so the listener must be registered once per client — one
 * subscription per mount meant a token refresh fired setAuth N times and
 * churned the socket that calls and typing ride on.
 */
export async function ensureRealtimeAuth(supabase: SupabaseClient) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.access_token) {
    await supabase.realtime.setAuth(session.access_token);
  }

  if (authListenerAttached.has(supabase)) return;
  authListenerAttached.add(supabase);
  supabase.auth.onAuthStateChange((_event, next) => {
    if (next?.access_token) {
      void supabase.realtime.setAuth(next.access_token);
    }
  });
}

/**
 * Fetch messages at or after `after` for reconciliation (mount, rejoin,
 * focus). Inclusive on purpose: two messages can share a timestamp, and
 * the caller dedupes by id, so re-reading the boundary row is free while
 * skipping it would lose a message for good.
 */
export async function fetchMessagesSince(
  supabase: SupabaseClient,
  roomId: string,
  after: string | null,
  limit = 100,
): Promise<Message[]> {
  let query = supabase
    .from("messages")
    .select("*")
    .eq("room_id", roomId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (after) {
    query = query.gte("created_at", after);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Message[];
}

/**
 * Read a room's current roster (members joined to their profiles), used
 * to seed and to reconcile after a room_members change. Returns each
 * person with their in-room role. RLS lets a member see co-members.
 */
export async function fetchRoomMembers(
  supabase: SupabaseClient,
  roomId: string,
): Promise<RoomMemberView[]> {
  const { data, error } = await supabase
    .from("room_members")
    .select("role, last_read_at, last_delivered_at, profiles!inner(id, full_name, public_name, avatar_url, role, is_active)")
    .eq("room_id", roomId);
  if (error) throw error;

  type Row = {
    role: RoomMemberRole;
    last_read_at: string | null;
    last_delivered_at: string | null;
    profiles: {
      id: string;
      full_name: string;
      public_name: string | null;
      avatar_url: string | null;
      role: RoomMemberView["role"];
      is_active: boolean | null;
    } | null;
  };

  return ((data ?? []) as unknown as Row[])
    .filter((r): r is Row & { profiles: NonNullable<Row["profiles"]> } =>
      Boolean(r.profiles),
    )
    .map((r) => ({
      id: r.profiles.id,
      full_name: r.profiles.full_name,
      public_name: r.profiles.public_name,
      avatar_url: r.profiles.avatar_url,
      role: r.profiles.role,
      is_active: r.profiles.is_active,
      room_role: r.role,
      last_read_at: r.last_read_at,
      last_delivered_at: r.last_delivered_at,
    }));
}

/** Older page for "load earlier messages" (exclusive of `before`). */
export async function fetchMessagesBefore(
  supabase: SupabaseClient,
  roomId: string,
  before: string,
  limit = 50,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("room_id", roomId)
    .lt("created_at", before)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as Message[]).reverse();
}

/** Pinned messages for a room, newest pin first. */
export async function fetchPinnedMessages(
  supabase: SupabaseClient,
  roomId: string,
): Promise<Message[]> {
  const { data, error } = await supabase.rpc("get_pinned_messages", {
    p_room_id: roomId,
  });
  if (error) throw error;
  return (data ?? []) as Message[];
}

/**
 * Every message in a room that carries an attachment or a link — the
 * media history. Read straight from `messages`, so the RLS policy that
 * governs the chat (membership plus each member's history cutoff)
 * governs this list too.
 */
export async function fetchRoomMediaMessages(
  supabase: SupabaseClient,
  roomId: string,
  limit = 300,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("room_id", roomId)
    .neq("kind", "system")
    .or("attachment_path.not.is.null,body.ilike.*http*,body.ilike.*www.*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data ?? []) as Message[];
}

export async function fetchRecentMessages(
  supabase: SupabaseClient,
  roomId: string,
  limit = 80,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return ((data ?? []) as Message[]).reverse();
}

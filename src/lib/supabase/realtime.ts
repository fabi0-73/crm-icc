import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type {
  Message,
  RoomMember,
  RoomMemberRole,
  RoomMemberView,
} from "@/lib/types";

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
  // Edits and deletes are UPDATEs (delete is a soft tombstone), so the
  // open chat reflects them live without a refresh.
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

/** One room_members change as realtime delivers it. `row` is the new row
 *  for INSERT/UPDATE; for DELETE it carries only the key columns. */
export type MembershipChange = {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  row: Partial<RoomMember>;
};

function toMembershipChange(payload: {
  eventType: string;
  new: unknown;
  old: unknown;
}): MembershipChange {
  const eventType = payload.eventType as MembershipChange["eventType"];
  const row = (eventType === "DELETE" ? payload.old : payload.new) as
    | Partial<RoomMember>
    | null;
  return { eventType, row: row ?? {} };
}

/**
 * Watch the membership of one room. Fires on INSERT/UPDATE/DELETE of
 * room_members for this room so the roster (and each viewer's own
 * standing) updates live — someone added, removed, promoted, leaving, or
 * reading/receiving messages lands without a refresh. UPDATEs carry the
 * whole row, so the caller can patch read/delivered state in place instead
 * of re-reading the roster for every tick.
 */
export function subscribeToRoomMembers(
  supabase: SupabaseClient,
  roomId: string,
  onChange: (change: MembershipChange) => void,
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
      (payload) => onChange(toMembershipChange(payload)),
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
  onChange: (change: MembershipChange) => void,
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
      (payload) => onChange(toMembershipChange(payload)),
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
    .select(
      "role, last_read_at, last_delivered_at, profiles!inner(id, full_name, public_name, role, is_active, avatar_url)",
    )
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
      role: RoomMemberView["role"];
      is_active: boolean | null;
      avatar_url: string | null;
    } | null;
  };

  return ((data ?? []) as unknown as Row[])
    .filter((r): r is Row & { profiles: NonNullable<Row["profiles"]> } =>
      Boolean(r.profiles),
    )
    .map((r) => ({
      id: r.profiles.id,
      full_name: r.profiles.full_name,
      role: r.profiles.role,
      is_active: r.profiles.is_active,
      room_role: r.role,
      last_read_at: r.last_read_at,
      last_delivered_at: r.last_delivered_at,
      avatar_url: r.profiles.avatar_url,
      public_name: r.profiles.public_name,
    }));
}

/**
 * Every pinned, undeleted message in a room, newest pin first — the pinned
 * banner needs pins older than the loaded window too. An ordinary query on
 * purpose: messages_select still applies each member's history cutoff, so
 * a pin from before someone joined stays hidden from them.
 */
export async function fetchPinnedMessages(
  supabase: SupabaseClient,
  roomId: string,
): Promise<Message[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("room_id", roomId)
    .not("pinned_at", "is", null)
    .is("deleted_at", null)
    .order("pinned_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as Message[];
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

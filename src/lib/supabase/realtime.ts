import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { Message } from "@/lib/types";

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
  if (onTyping) {
    channel.on("broadcast", { event: "typing" }, ({ payload }) => {
      onTyping(payload as TypingEvent);
    });
  }
  return channel.subscribe();
}

/** Ephemeral "I'm typing" ping to everyone else in the room's channel. */
export function sendTyping(channel: RealtimeChannel, userId: string) {
  void channel.send({
    type: "broadcast",
    event: "typing",
    payload: { user_id: userId } satisfies TypingEvent,
  });
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

/** Keep realtime auth in sync with the session JWT. */
export async function ensureRealtimeAuth(supabase: SupabaseClient) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.access_token) {
    await supabase.realtime.setAuth(session.access_token);
  }

  supabase.auth.onAuthStateChange((_event, next) => {
    if (next?.access_token) {
      void supabase.realtime.setAuth(next.access_token);
    }
  });
}

/**
 * Fetch messages newer than `after` (exclusive) for focus reconciliation.
 * Append-only model makes this trivial.
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
    query = query.gt("created_at", after);
  }

  const { data, error } = await query;
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

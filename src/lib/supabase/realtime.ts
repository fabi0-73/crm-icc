import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { Message } from "@/lib/types";

type MessageHandler = (message: Message) => void;

/**
 * Subscribe to new messages in a room. Caller must refresh the realtime
 * auth token on JWT refresh (see ensureRealtimeAuth).
 */
export function subscribeToRoomMessages(
  supabase: SupabaseClient,
  roomId: string,
  onInsert: MessageHandler,
): RealtimeChannel {
  return supabase
    .channel(`room:${roomId}`)
    .on(
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

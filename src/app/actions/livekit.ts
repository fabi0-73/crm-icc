"use server";

import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { requireProfile, requireRole } from "@/lib/auth";
import { publicDisplayName } from "@/lib/display-name";
import { createServiceClient } from "@/lib/supabase/server";

/**
 * Refuse a callId that belongs to a DIFFERENT room.
 *
 * Membership is checked against the client-supplied roomId, so without this a
 * member of room A could present room B's callId and be issued a token for
 * (or evict someone from) B's call. Call ids are random UUIDs and call_signals
 * is RLS-restricted, so learning a foreign one is already hard — this closes
 * the hole rather than relying on that.
 *
 * Uses the SERVICE client deliberately: with the caller's own client, RLS
 * could hide the very conflicting row we are looking for and the check would
 * pass. An unknown callId is allowed — that is a brand-new call, so there is
 * no other call to hijack.
 */
async function callBelongsToRoom(callId: string, roomId: string): Promise<boolean> {
  try {
    const service = createServiceClient();
    const { data } = await service
      .from("call_signals")
      .select("room_id")
      .eq("call_id", callId)
      .limit(1)
      .maybeSingle<{ room_id: string }>();
    return !data || data.room_id === roomId;
  } catch {
    // Can't verify (service client misconfigured) — fail closed.
    return false;
  }
}

export type CallTokenResult = { token?: string; url?: string; error?: string };

/**
 * Mint a LiveKit access token for a group call.
 *
 * This is the permission gate for call media: the token is only issued to a
 * caller who is actually a member of the room, and it is scoped to that one
 * call's LiveKit room. The API secret never leaves the server — the browser
 * only ever sees the resulting short-lived JWT.
 */
export async function createCallToken(
  roomId: string,
  callId: string,
): Promise<CallTokenResult> {
  if (!roomId || !callId) return { error: "Missing call details." };

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    return { error: "Group calling is not configured on this server." };
  }

  try {
    const { supabase, user, profile } = await requireProfile();

    // Only a member of the conversation may join its call.
    const { data: membership } = await supabase
      .from("room_members")
      .select("user_id")
      .eq("room_id", roomId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return { error: "You're not a member of this room." };
    if (!(await callBelongsToRoom(callId, roomId))) {
      return { error: "That call doesn't belong to this conversation." };
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: user.id,
      name: publicDisplayName(profile),
      // Comfortably longer than any call, short enough to not linger.
      ttl: "4h",
    });
    at.addGrant({
      roomJoin: true,
      room: `call-${callId}`,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return { token: await at.toJwt(), url };
  } catch {
    return { error: "Could not join the call." };
  }
}

export type LiveCall = {
  roomId: string;
  callId: string;
  video: boolean;
  /** People in the call right now. */
  count: number;
};

/** Running calls as LiveKit reports them, shared by every caller for a few
 *  seconds: each open group chat checks for a call, and 40 of them polling
 *  must not become 40 LiveKit requests. */
let liveRoomsCache: {
  at: number;
  rooms: Promise<{ callId: string; count: number }[]>;
} | null = null;
const LIVE_ROOMS_TTL_MS = 5_000;

function listLiveRooms(httpUrl: string, apiKey: string, apiSecret: string) {
  if (liveRoomsCache && Date.now() - liveRoomsCache.at < LIVE_ROOMS_TTL_MS) {
    return liveRoomsCache.rooms;
  }
  const rooms = new RoomServiceClient(httpUrl, apiKey, apiSecret)
    .listRooms()
    .then((all) =>
      all
        .filter((r) => r.name.startsWith("call-") && r.numParticipants > 0)
        .map((r) => ({ callId: r.name.slice(5), count: r.numParticipants })),
    );
  liveRoomsCache = { at: Date.now(), rooms };
  // A failed request must not be served from the cache for the next 5 s.
  rooms.catch(() => {
    if (liveRoomsCache?.rooms === rooms) liveRoomsCache = null;
  });
  return rooms;
}

/** callId → its conversation and kind. A call never moves, so once known it
 *  is kept (bounded, in case the process lives for months). */
const callHomes = new Map<string, { roomId: string; video: boolean }>();

async function callHome(callId: string) {
  const known = callHomes.get(callId);
  if (known) return known;
  // The call's invites record which conversation it rang. Service client for
  // the same reason as callBelongsToRoom: RLS would hide rows not sent to us.
  const { data } = await createServiceClient()
    .from("call_signals")
    .select("room_id, payload")
    .eq("call_id", callId)
    .eq("kind", "invite")
    .limit(1)
    .maybeSingle<{ room_id: string; payload: { video?: boolean } | null }>();
  if (!data) return null;
  const home = { roomId: data.room_id, video: Boolean(data.payload?.video) };
  if (callHomes.size > 1000) callHomes.clear();
  callHomes.set(callId, home);
  return home;
}

/**
 * The group call running in a conversation right now, if any — what the Join
 * button in a group chat offers. Asks LiveKit itself, so a call that has
 * ended can never show as joinable. Only a member of the conversation learns
 * of its call; joining then goes through createCallToken's own checks.
 */
/** Rate limit for the warning below; module state, not an export. */
let lastLiveCallWarn = 0;

export async function getLiveCall(roomId: string): Promise<LiveCall | null> {
  if (!roomId) return null;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) return null;

  try {
    const { supabase, user } = await requireProfile();
    const { data: membership } = await supabase
      .from("room_members")
      .select("user_id")
      .eq("room_id", roomId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return null;

    const httpUrl = url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
    const rooms = await listLiveRooms(httpUrl, apiKey, apiSecret);
    let best: LiveCall | null = null;
    for (const r of rooms) {
      const home = await callHome(r.callId);
      if (home?.roomId !== roomId) continue;
      // Two calls started at once in one group: offer the busier one.
      if (!best || r.count > best.count) {
        best = { roomId, callId: r.callId, video: home.video, count: r.count };
      }
    }
    return best;
  } catch (err) {
    // Silence here hides a broken lookup forever: the Join button just never
    // appears and nothing says why. Log at most once a minute, so a lasting
    // failure shows up in `journalctl -u crm-icc` without flooding it (this
    // runs on a timer for every open group chat).
    if (Date.now() - lastLiveCallWarn > 60_000) {
      lastLiveCallWarn = Date.now();
      console.warn("[call] getLiveCall failed:", err);
    }
    return null;
  }
}

/**
 * Evict someone from an in-progress group call.
 *
 * Only LiveKit's server API can remove a participant, and that needs the API
 * secret — so this cannot live in the browser. Restricted to admins and
 * managers who are themselves in the conversation; the removed person's
 * client sees the disconnect and tears its call down on its own.
 */
export async function removeCallParticipant(
  roomId: string,
  callId: string,
  identity: string,
): Promise<{ ok?: true; error?: string }> {
  if (!roomId || !callId || !identity) return { error: "Missing call details." };

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    return { error: "Group calling is not configured on this server." };
  }

  try {
    const { supabase, user } = await requireRole(["admin", "manager"]);

    // Managing a call requires being in that conversation, not just holding
    // the role — otherwise any manager could evict people from any room.
    const { data: membership } = await supabase
      .from("room_members")
      .select("user_id")
      .eq("room_id", roomId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return { error: "You're not a member of this room." };
    if (identity === user.id) return { error: "Use Leave to drop yourself." };
    if (!(await callBelongsToRoom(callId, roomId))) {
      return { error: "That call doesn't belong to this conversation." };
    }

    // The SDK speaks HTTP(S); the browser-facing URL is a websocket one.
    const httpUrl = url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
    const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
    await svc.removeParticipant(`call-${callId}`, identity);
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (message === "Permission denied") {
      return { error: "Only admins and managers can manage participants." };
    }
    // Already gone is a success from the caller's point of view.
    if (/not found/i.test(message)) return { ok: true };
    return { error: message || "Could not remove them from the call." };
  }
}

/**
 * Force-mute someone else's microphone in a group call.
 * Same permission gate as eviction: admin/manager who is in the room.
 */
export async function muteCallParticipant(
  roomId: string,
  callId: string,
  identity: string,
): Promise<{ ok?: true; error?: string }> {
  if (!roomId || !callId || !identity) return { error: "Missing call details." };

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!apiKey || !apiSecret || !url) {
    return { error: "Group calling is not configured on this server." };
  }

  try {
    const { supabase, user } = await requireRole(["admin", "manager"]);

    const { data: membership } = await supabase
      .from("room_members")
      .select("user_id")
      .eq("room_id", roomId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) return { error: "You're not a member of this room." };
    if (identity === user.id) return { error: "Use the mute button for yourself." };
    if (!(await callBelongsToRoom(callId, roomId))) {
      return { error: "That call doesn't belong to this conversation." };
    }

    const httpUrl = url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
    const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
    const roomName = `call-${callId}`;
    const parts = await svc.listParticipants(roomName);
    const person = parts.find((p) => p.identity === identity);
    if (!person) return { error: "They're not in the call." };
    const mic = person.tracks.find((t) => {
      const source = String(t.source ?? "");
      return (
        source === "MICROPHONE" ||
        source === "SOURCE_MICROPHONE" ||
        source === "2" ||
        Number(t.source) === 2
      );
    });
    if (!mic?.sid) return { error: "No microphone published." };
    await svc.mutePublishedTrack(roomName, identity, mic.sid, true);
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (message === "Permission denied") {
      return { error: "Only admins and managers can mute other people." };
    }
    if (/not found/i.test(message)) return { error: "They're not in the call." };
    return { error: message || "Could not mute them." };
  }
}

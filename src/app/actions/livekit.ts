"use server";

import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { requireProfile, requireRole } from "@/lib/auth";

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

    const at = new AccessToken(apiKey, apiSecret, {
      identity: user.id,
      name: profile.full_name,
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

"use server";

import { AccessToken } from "livekit-server-sdk";
import { requireProfile } from "@/lib/auth";

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

"use client";

import { createClient } from "@/lib/supabase/client";
import { subscribeToPush } from "@/lib/notify";

/**
 * Subscribe this browser to Web Push (if permission is granted and a VAPID key
 * is configured) and persist the subscription so the server-side sender can
 * reach this device when the app is closed. Best-effort and idempotent — a
 * device that re-subscribes upserts its row by endpoint. Returns true when a
 * subscription is stored.
 */
export async function savePushSubscription(): Promise<boolean> {
  try {
    const sub = await subscribeToPush();
    if (!sub) return false;

    const json = sub.toJSON();
    const endpoint = json.endpoint;
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!endpoint || !p256dh || !auth) return false;

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;

    const { error } = await supabase.from("push_subscriptions").upsert(
      {
        user_id: user.id,
        endpoint,
        p256dh,
        auth,
        user_agent:
          typeof navigator !== "undefined"
            ? navigator.userAgent.slice(0, 300)
            : null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "endpoint" },
    );
    return !error;
  } catch {
    return false;
  }
}

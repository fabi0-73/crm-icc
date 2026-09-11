/**
 * Server-side Web Push sender.
 *
 * Runs ONCE inside the Next.js server process (started from instrumentation.ts,
 * nodejs runtime only). Messages and call invites are written to the database
 * directly by clients, so there is no server action to hook — instead this
 * subscribes to the same realtime INSERT streams the app already relies on and,
 * for each event, POSTs an encrypted Web Push (VAPID) to the recipients'
 * registered devices. That is what delivers a message/call alert to a fully
 * closed or backgrounded app; the in-app foreground pop-ups are separate.
 *
 * Deliberately best-effort and self-contained: any failure is logged and
 * swallowed so it can never take down the web server. Disabled (no-op) unless
 * the VAPID env is present.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import webpush from "web-push";

type MessageRow = {
  id: string;
  room_id: string | null;
  sender_id: string | null;
  kind: string;
  body: string | null;
};

type SignalRow = {
  room_id: string;
  call_id: string;
  from_user: string;
  to_user: string;
  kind: string;
  payload: {
    fromName?: string;
    group?: boolean;
    joining?: boolean;
  } | null;
};

type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
  /** Drives how the service worker presents it: a call is persistent and
   *  vibrates until dealt with, a message is a quiet one-shot. */
  type: "call" | "message";
};

let started = false;

export function startPushSender(): void {
  if (started) return;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (!url || !serviceKey || !publicKey || !privateKey) {
    console.warn(
      "[push] sender disabled — set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY",
    );
    return;
  }
  started = true;

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:support@icenterconsult.com",
    publicKey,
    privateKey,
  );

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Incoming-call invites are re-sent every ~3s (and once per invitee), so
  // dedupe by call+recipient to send exactly one ring push per person.
  const notifiedInvites = new Map<string, number>();
  const INVITE_TTL_MS = 60_000;
  const alreadyNotified = (key: string): boolean => {
    const now = Date.now();
    for (const [k, ts] of notifiedInvites) {
      if (now - ts > INVITE_TTL_MS) notifiedInvites.delete(k);
    }
    if (notifiedInvites.has(key)) return true;
    notifiedInvites.set(key, now);
    return false;
  };

  supabase
    .channel("push-sender")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      (payload) => {
        void onMessage(supabase, payload.new as MessageRow).catch((e) =>
          console.warn("[push] message handler failed:", e?.message ?? e),
        );
      },
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "call_signals" },
      (payload) => {
        void onCallSignal(supabase, payload.new as SignalRow, alreadyNotified).catch(
          (e) => console.warn("[push] call handler failed:", e?.message ?? e),
        );
      },
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        console.log("[push] sender subscribed to messages + call_signals");
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        // supabase-js retries the connection on its own; just surface it.
        console.warn("[push] realtime channel status:", status);
      }
    });
}

/** New chat message → push everyone in the room except the sender. */
async function onMessage(
  supabase: SupabaseClient,
  msg: MessageRow,
): Promise<void> {
  if (!msg?.room_id || !msg.sender_id) return;
  // Only human messages ring; system rows (call-started/ended, "group created")
  // must not push.
  if (msg.kind !== "text" && msg.kind !== "file") return;

  const { data: members } = await supabase
    .from("room_members")
    .select("user_id")
    .eq("room_id", msg.room_id);

  const recipients = (members ?? [])
    .map((m: { user_id: string }) => m.user_id)
    .filter((id: string) => id && id !== msg.sender_id);
  if (recipients.length === 0) return;

  const [{ data: sender }, { data: room }] = await Promise.all([
    supabase.from("profiles").select("full_name").eq("id", msg.sender_id).maybeSingle(),
    supabase.from("rooms").select("name, type").eq("id", msg.room_id).maybeSingle(),
  ]);

  const senderName = (sender as { full_name?: string } | null)?.full_name ?? "Someone";
  const roomType = (room as { type?: string } | null)?.type;
  const roomName = (room as { name?: string } | null)?.name;
  const isDm = roomType === "dm";

  const preview = msg.kind === "file" ? "📎 Attachment" : (msg.body ?? "");
  const title = isDm ? senderName : roomName || "New message";
  const body = (isDm ? preview : `${senderName}: ${preview}`).slice(0, 140);

  await sendToUsers(supabase, recipients, {
    title,
    body,
    url: `/rooms/${msg.room_id}`,
    tag: `room-${msg.room_id}`,
    type: "message",
  });
}

/** Incoming call invite → push the one person being rung. */
async function onCallSignal(
  supabase: SupabaseClient,
  row: SignalRow,
  alreadyNotified: (key: string) => boolean,
): Promise<void> {
  if (!row || row.kind !== "invite") return;
  const p = row.payload ?? {};
  if (p.joining) return; // a presence announcement, not a fresh ring
  if (!row.to_user || !row.call_id) return;
  if (alreadyNotified(`${row.call_id}:${row.to_user}`)) return;

  const caller = p.fromName || "Someone";
  const body = p.group ? `${caller} started a group call` : `${caller} is calling`;

  await sendToUsers(supabase, [row.to_user], {
    title: "Incoming call",
    body,
    url: `/rooms/${row.room_id}`,
    tag: "call",
    type: "call",
  });
}

/** Fan a payload out to every registered device of the given users. */
async function sendToUsers(
  supabase: SupabaseClient,
  userIds: string[],
  payload: PushPayload,
): Promise<void> {
  const { data: subs } = await supabase
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", userIds);
  if (!subs || subs.length === 0) return;

  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s: { id: string; endpoint: string; p256dh: string; auth: string }) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body,
        );
      } catch (err) {
        const code = (err as { statusCode?: number })?.statusCode;
        // 404/410 = the browser dropped this subscription; forget it.
        if (code === 404 || code === 410) {
          await supabase.from("push_subscriptions").delete().eq("id", s.id);
        } else {
          console.warn("[push] send failed:", code ?? (err as Error)?.message);
        }
      }
    }),
  );
}

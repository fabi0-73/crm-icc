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

import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from "@supabase/supabase-js";
import webpush from "web-push";
import { publicDisplayName } from "@/lib/display-name";

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
  /** Did we actually ring this person for this call? Gates the missed-call
   *  replacement so we never invent one for a call they were never rung for. */
  const wasNotified = (key: string): boolean => notifiedInvites.has(key);

  // `supabase` above stays for the database lookups and cleanup; the realtime
  // subscription gets its own disposable clients (see keepSubscribed).
  keepSubscribed({
    makeClient: () =>
      createClient(url, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    topic: "push-sender",
    onSubscribed: "sender subscribed to messages + call_signals",
    attach: (channel, live) =>
      channel
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "messages" },
          (payload) => {
            if (!live()) return;
            void onMessage(supabase, payload.new as MessageRow).catch((e) =>
              console.warn("[push] message handler failed:", e?.message ?? e),
            );
          },
        )
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "call_signals" },
          (payload) => {
            if (!live()) return;
            void onCallSignal(
              supabase,
              payload.new as SignalRow,
              alreadyNotified,
              wasNotified,
            ).catch((e) => console.warn("[push] call handler failed:", e?.message ?? e));
          },
        ),
  });
}

/**
 * Keep one realtime channel subscribed through any outage, on a fresh client
 * every time it fails.
 *
 * Why a whole new client: in realtime-js 2.110, removeChannel() only drops a
 * channel when the server acknowledges the unsubscribe — which a dead socket
 * never does — and client.channel(topic) hands back the channel already
 * registered under that topic. Retrying on the same client therefore reused
 * the dead channel forever and stacked another copy of its handlers each time
 * (so a recovery would have sent duplicate pushes). That is what left push
 * down after a realtime restart on 2026-09-18; the reboot earlier that night
 * had shown the other half — a join refused at startup is never retried.
 *
 * Every attempt gets a generation number. Statuses and events from a client
 * that has been replaced are ignored (`live()` is false), so an old socket can
 * neither schedule a retry nor deliver a second copy of an event.
 */
export function keepSubscribed(opts: {
  makeClient: () => SupabaseClient;
  topic: string;
  /** Logged (after "[push] ") each time the channel is subscribed. */
  onSubscribed: string;
  /** Add listeners to a fresh channel; handlers should check `live()`. */
  attach: (channel: RealtimeChannel, live: () => boolean) => RealtimeChannel;
}): { current: () => SupabaseClient | null; stop: () => void } {
  let client: SupabaseClient | null = null;
  let generation = 0;
  let subscribed = false;
  let attempt = 0;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  const retire = () => {
    const old = client;
    client = null;
    if (!old) return;
    // Never awaited: on a dead socket these only settle after their timeouts.
    void old.removeAllChannels().catch(() => {});
    void Promise.resolve(old.realtime.disconnect()).catch(() => {});
  };

  const scheduleReset = (why: string) => {
    if (resetTimer) return; // one reset per failure, however it's reported
    attempt += 1;
    const delay = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
    console.warn(
      `[push] realtime ${why}; reconnecting in ${delay / 1000}s (attempt ${attempt})`,
    );
    resetTimer = setTimeout(connect, delay);
  };

  function connect() {
    resetTimer = null;
    // Advance the generation BEFORE retiring the old client: removing its
    // channel reports CLOSED, which must already count as stale.
    const mine = ++generation;
    retire();
    const live = () => mine === generation;
    subscribed = false;
    const fresh = opts.makeClient();
    client = fresh;
    opts.attach(fresh.channel(opts.topic), live).subscribe((status) => {
      if (!live()) return;
      if (status === "SUBSCRIBED") {
        // The library does recover some socket drops by itself; then a
        // pending reset would only cause a needless gap.
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = null;
        subscribed = true;
        attempt = 0;
        console.log(`[push] ${opts.onSubscribed}`);
        return;
      }
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        subscribed = false;
        scheduleReset(status);
      }
    });
  }

  // Safety net for a connection that goes quiet without reporting anything.
  const watchdog = setInterval(() => {
    if (!subscribed && !resetTimer) scheduleReset("not subscribed (watchdog)");
  }, 60_000);
  watchdog.unref?.();

  connect();

  return {
    current: () => client,
    stop: () => {
      clearInterval(watchdog);
      if (resetTimer) clearTimeout(resetTimer);
      resetTimer = null;
      generation += 1;
      retire();
    },
  };
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

  const everyone = (members ?? [])
    .map((m: { user_id: string }) => m.user_id)
    .filter((id: string) => id && id !== msg.sender_id);
  if (everyone.length === 0) return;

  // Skip whoever muted this conversation or this sender (notification_mutes;
  // the in-app sound and pop-up honour the same rows). Calls are unaffected.
  const { data: mutes } = await supabase
    .from("notification_mutes")
    .select("user_id")
    .in("user_id", everyone)
    .or(`room_id.eq.${msg.room_id},muted_user_id.eq.${msg.sender_id}`);
  const muted = new Set(
    (mutes ?? []).map((m: { user_id: string }) => m.user_id),
  );
  const recipients = everyone.filter((id: string) => !muted.has(id));
  if (recipients.length === 0) return;

  const [{ data: sender }, { data: room }] = await Promise.all([
    supabase
      .from("profiles")
      .select("full_name, public_name")
      .eq("id", msg.sender_id)
      .maybeSingle(),
    supabase
      .from("rooms")
      .select("name, type, own_messages_only")
      .eq("id", msg.room_id)
      .maybeSingle(),
  ]);

  const senderProfile = sender as {
    full_name: string;
    public_name: string | null;
  } | null;
  const senderName = senderProfile ? publicDisplayName(senderProfile) : "Someone";
  const roomType = (room as { type?: string } | null)?.type;
  const roomName = (room as { name?: string } | null)?.name;
  const isDm = roomType === "dm";

  // A room where members only see their own messages: the notification
  // carries the sender's name and the first 140 characters, so pushing it to
  // the room would hand everyone exactly what the rule hides. Only the people
  // allowed to read it hear about it. This runs as the service role, so RLS
  // does not do it for us.
  let audience = recipients;
  if ((room as { own_messages_only?: boolean } | null)?.own_messages_only) {
    const { data: reviewers } = await supabase
      .from("profiles")
      .select("id")
      .in("role", ["admin", "manager"])
      .eq("is_active", true)
      .in("id", recipients);
    audience = (reviewers ?? []).map((a: { id: string }) => a.id);
    if (audience.length === 0) return;
  }

  const preview = msg.kind === "file" ? "📎 Attachment" : (msg.body ?? "");
  const title = isDm ? senderName : roomName || "New message";
  const body = (isDm ? preview : `${senderName}: ${preview}`).slice(0, 140);

  await sendToUsers(supabase, audience, {
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
  wasNotified: (key: string) => boolean,
): Promise<void> {
  if (!row || !row.to_user || !row.call_id) return;
  const p = row.payload ?? {};

  // The caller gave up or cancelled. A closed device has nothing running to
  // clear the persistent "Incoming call" alert, so replace it (same tag) with
  // a quiet "Missed call" — that both clears the ring and says what happened.
  // Only for someone we actually rang, so a normal end-of-call hangup between
  // people who already talked doesn't invent a missed call.
  if (row.kind === "hangup") {
    if (!wasNotified(`${row.call_id}:${row.to_user}`)) return;
    const caller = p.fromName || "Someone";
    await sendToUsers(supabase, [row.to_user], {
      title: "Missed call",
      body: `${caller} called`,
      url: `/rooms/${row.room_id}`,
      tag: "call",
      type: "message",
    });
    return;
  }

  if (row.kind !== "invite") return;
  if (p.joining) return; // a presence announcement, not a fresh ring
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

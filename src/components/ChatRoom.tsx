"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  ChevronLeft,
  FileText,
  Hash,
  Info,
  Paperclip,
  SendHorizontal,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  ensureRealtimeAuth,
  fetchMessagesSince,
  sendTyping,
  subscribeToRoomMessages,
  type TypingEvent,
} from "@/lib/supabase/realtime";
import { markRoomRead } from "@/app/actions/rooms";
import { CallButton } from "@/components/call/CallButton";
import { Avatar } from "@/components/Avatar";
import { PresenceDot } from "@/components/PresenceDot";
import { useIsOnline } from "@/components/presence/PresenceProvider";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/uikit/sheet";
import { buildDaySections } from "@/lib/chat/grouping";
import type { Message, Profile, RoomType } from "@/lib/types";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TYPING_THROTTLE_MS = 2000;
const TYPING_EXPIRE_MS = 4000;

function formatMsgTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatBytes(n: number | null) {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function isImage(msg: Message) {
  return msg.kind === "file" && (msg.attachment_mime ?? "").startsWith("image/");
}

type SignFn = (path: string, download?: string) => Promise<string | null>;

export function ChatRoom({
  roomId,
  roomName,
  roomType = "group",
  dmOtherUserId = null,
  currentUserId,
  members,
  initialMessages,
}: {
  roomId: string;
  roomName: string;
  roomType?: RoomType;
  dmOtherUserId?: string | null;
  currentUserId: string;
  members: Pick<Profile, "id" | "full_name" | "role">[];
  initialMessages: Message[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [typers, setTypers] = useState<Record<string, number>>({});

  const streamRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const nearBottomRef = useRef(true);
  const didInitScrollRef = useRef(false);
  const lastTypingSentRef = useRef(0);
  const lastCreatedAtRef = useRef<string | null>(
    initialMessages[initialMessages.length - 1]?.created_at ?? null,
  );

  const memberMap = useMemo(() => {
    const m = new Map<string, string>();
    members.forEach((p) => m.set(p.id, p.full_name));
    return m;
  }, [members]);

  const sections = useMemo(() => buildDaySections(messages), [messages]);
  const dmOtherOnline = useIsOnline(dmOtherUserId);

  const mergeMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      const next = [...prev, msg].sort(
        (a, b) =>
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      );
      lastCreatedAtRef.current = next[next.length - 1]?.created_at ?? null;
      return next;
    });
    // A message from someone means they stopped typing.
    if (msg.sender_id) {
      setTypers((prev) => {
        if (!(msg.sender_id! in prev)) return prev;
        const next = { ...prev };
        delete next[msg.sender_id!];
        return next;
      });
    }
  }, []);

  const onTyping = useCallback(
    (event: TypingEvent) => {
      if (event.user_id === currentUserId) return;
      setTypers((prev) => ({ ...prev, [event.user_id]: Date.now() }));
    },
    [currentUserId],
  );

  useEffect(() => {
    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    (async () => {
      await ensureRealtimeAuth(supabase);
      if (cancelled) return;
      channel = subscribeToRoomMessages(supabase, roomId, mergeMessage, onTyping);
      channelRef.current = channel;
      await markRoomRead(roomId).catch(() => {});
    })();

    const onFocus = async () => {
      try {
        const newer = await fetchMessagesSince(
          supabase,
          roomId,
          lastCreatedAtRef.current,
        );
        newer.forEach(mergeMessage);
        await markRoomRead(roomId);
      } catch {
        // ignore transient network errors
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void onFocus();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      channelRef.current = null;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [supabase, roomId, mergeMessage, onTyping]);

  // Expire stale typing entries.
  useEffect(() => {
    if (Object.keys(typers).length === 0) return;
    const t = setInterval(() => {
      const now = Date.now();
      setTypers((prev) => {
        const entries = Object.entries(prev).filter(
          ([, ts]) => now - ts < TYPING_EXPIRE_MS,
        );
        return entries.length === Object.keys(prev).length
          ? prev
          : Object.fromEntries(entries);
      });
    }, 1000);
    return () => clearInterval(t);
  }, [typers]);

  const scrollToBottom = useCallback((smooth: boolean) => {
    bottomRef.current?.scrollIntoView({
      behavior: smooth ? "smooth" : "auto",
      block: "end",
    });
  }, []);

  // First paint lands at the bottom instantly; afterwards only follow
  // new messages when the reader is already near the bottom (or the
  // message is their own) so scrollback is never yanked away.
  useEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    if (!didInitScrollRef.current) {
      didInitScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const last = messages[messages.length - 1];
    if (nearBottomRef.current || last?.sender_id === currentUserId) {
      scrollToBottom(true);
    }
  }, [messages, currentUserId, scrollToBottom]);

  const onStreamScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    nearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  }, []);

  const sign = useCallback<SignFn>(
    async (path, download) => {
      const { data } = await supabase.storage
        .from("attachments")
        .createSignedUrl(path, 3600, download ? { download } : undefined);
      return data?.signedUrl ?? null;
    },
    [supabase],
  );

  const openAttachment = useCallback(
    async (path: string, name: string) => {
      const url = await sign(path, name);
      if (!url) {
        setError("Could not open the attachment.");
        return;
      }
      window.open(url, "_blank", "noopener");
    },
    [sign],
  );

  function autoresize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(ta.scrollHeight, 128)}px`;
  }

  function noteTyping() {
    const ch = channelRef.current;
    if (!ch) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current > TYPING_THROTTLE_MS) {
      lastTypingSentRef.current = now;
      sendTyping(ch, currentUserId);
    }
  }

  async function sendText(e: React.FormEvent) {
    e.preventDefault();
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);

    const { data, error: insertError } = await supabase
      .from("messages")
      .insert({
        room_id: roomId,
        sender_id: currentUserId,
        kind: "text",
        body: text,
      })
      .select("*")
      .single();

    setSending(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setBody("");
    requestAnimationFrame(autoresize);
    if (data) mergeMessage(data as Message);
    await markRoomRead(roomId).catch(() => {});
  }

  async function sendFile(file: File) {
    if (file.size > MAX_FILE_BYTES) {
      setError("File must be under 25 MB.");
      return;
    }
    setSending(true);
    setError(null);

    const path = `${roomId}/${crypto.randomUUID()}/${file.name}`;
    const { error: uploadError } = await supabase.storage
      .from("attachments")
      .upload(path, file, { contentType: file.type, upsert: false });

    if (uploadError) {
      setSending(false);
      setError(uploadError.message);
      return;
    }

    const { data, error: insertError } = await supabase
      .from("messages")
      .insert({
        room_id: roomId,
        sender_id: currentUserId,
        kind: "file",
        body: file.name,
        attachment_path: path,
        attachment_name: file.name,
        attachment_size: file.size,
        attachment_mime: file.type || null,
      })
      .select("*")
      .single();

    setSending(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    if (data) mergeMessage(data as Message);
    await markRoomRead(roomId).catch(() => {});
  }

  const typingNames = Object.keys(typers)
    .map((id) => memberMap.get(id))
    .filter((n): n is string => Boolean(n));
  const typingLabel =
    typingNames.length > 0
      ? `${typingNames[0].split(" ")[0]}${
          typingNames.length > 1 ? ` +${typingNames.length - 1}` : ""
        } is typing…`
      : null;

  return (
    <div className="flex h-full flex-col bg-mist">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line bg-paper px-1.5 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] sm:px-3">
        <Link
          href="/rooms"
          prefetch
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink active:bg-mist sm:hidden"
          aria-label="Back to chats"
        >
          <ChevronLeft className="size-6" />
        </Link>

        {roomType === "dm" ? (
          <span className="relative ml-1 shrink-0 sm:ml-0">
            <Avatar name={roomName} size="sm" />
            <PresenceDot
              online={dmOtherOnline}
              className="absolute -bottom-0.5 -right-0.5 ring-2 ring-paper"
            />
          </span>
        ) : (
          <span className="ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700 sm:ml-0">
            <Hash className="size-[18px]" strokeWidth={2.2} />
          </span>
        )}

        <div className="ml-1 min-w-0 flex-1">
          <h1 className="truncate text-[16px] font-semibold leading-tight text-ink">
            {roomName}
          </h1>
          {typingLabel ? (
            <p className="truncate text-[12px] font-medium text-brand-600">
              {typingLabel}
            </p>
          ) : roomType === "dm" ? (
            <p className="text-[12px] text-muted">
              {dmOtherOnline ? "Online" : "Offline"}
            </p>
          ) : (
            <p className="truncate text-[12px] text-muted">
              {members.length} members
            </p>
          )}
        </div>

        <CallButton
          roomId={roomId}
          roomName={roomName}
          currentUserId={currentUserId}
          members={members}
        />
        <button
          type="button"
          onClick={() => setShowMembers(true)}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mist active:bg-mist"
          aria-label="Conversation details"
        >
          <Info className="size-5" />
        </button>
      </div>

      {/* ── Message stream ─────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={streamRef}
          onScroll={onStreamScroll}
          className="h-full overflow-y-auto overscroll-contain px-3 py-3 sm:px-6"
        >
          {sections.map((day) => (
            <div key={day.key}>
              <div className="my-3 flex justify-center">
                <span className="rounded-full border border-line bg-paper px-3 py-1 text-[11px] font-medium text-muted shadow-xs">
                  {day.label}
                </span>
              </div>
              {day.groups.map((g) => {
                if (g.kind === "system") {
                  return (
                    <div key={g.key} className="flex justify-center py-1.5">
                      <span className="rounded-full bg-line/60 px-3 py-1 text-[11px] text-muted">
                        {g.message.body}
                      </span>
                    </div>
                  );
                }
                const mine = g.senderId === currentUserId;
                const last = g.messages[g.messages.length - 1];
                if (mine) {
                  return (
                    <div key={g.key} className="mt-3 flex flex-col items-end">
                      {g.messages.map((msg, i) => (
                        <div
                          key={msg.id}
                          className="mt-[3px] max-w-[85%] sm:max-w-[70%]"
                        >
                          <Bubble
                            msg={msg}
                            mine
                            tail={i === g.messages.length - 1}
                            sign={sign}
                            onOpen={openAttachment}
                            onMediaLoad={() => {
                              if (nearBottomRef.current) scrollToBottom(false);
                            }}
                          />
                        </div>
                      ))}
                      <p className="mt-1 text-[11px] tabular-nums text-muted/80">
                        {formatMsgTime(last.created_at)}
                      </p>
                    </div>
                  );
                }
                const name = g.senderId
                  ? (memberMap.get(g.senderId) ?? "Unknown")
                  : "";
                const first = g.messages[0];
                return (
                  <div key={g.key} className="mt-3 flex gap-2">
                    <div className="w-8 shrink-0 pt-0.5">
                      <Avatar
                        name={name}
                        size="sm"
                        className="!h-8 !w-8 !text-[11px]"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-baseline gap-2 pl-0.5">
                        <span className="truncate text-[13px] font-semibold text-brand-700">
                          {name}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted">
                          {formatMsgTime(first.created_at)}
                        </span>
                      </p>
                      {g.messages.map((msg, i) => (
                        <div key={msg.id} className="mt-[3px] flex">
                          <div className="max-w-[85%] sm:max-w-[70%]">
                            <Bubble
                              msg={msg}
                              mine={false}
                              tail={i === g.messages.length - 1}
                              sign={sign}
                              onOpen={openAttachment}
                              onMediaLoad={() => {
                                if (nearBottomRef.current)
                                  scrollToBottom(false);
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          <div ref={bottomRef} className="h-px" />
        </div>
      </div>

      {/* ── Composer ───────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-line bg-paper px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-3">
        {error && (
          <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {error}
          </p>
        )}
        <form onSubmit={sendText} className="flex items-end gap-1.5">
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void sendFile(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={sending}
            onClick={() => fileRef.current?.click()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mist active:bg-mist disabled:opacity-40"
            aria-label="Attach file"
          >
            <Paperclip className="size-[21px]" />
          </button>
          <div className="flex min-h-10 flex-1 items-end rounded-3xl bg-secondary px-4 py-2">
            <textarea
              ref={taRef}
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                autoresize();
                if (e.target.value.trim()) noteTyping();
              }}
              onFocus={() => {
                // Keep the latest messages visible above the keyboard.
                setTimeout(() => {
                  if (nearBottomRef.current) scrollToBottom(false);
                }, 250);
              }}
              rows={1}
              placeholder="Message"
              className="max-h-32 w-full resize-none bg-transparent text-[16px] leading-snug text-ink outline-none placeholder:text-muted"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendText(e);
                }
              }}
            />
          </div>
          <button
            type="submit"
            disabled={sending || !body.trim()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition-opacity hover:bg-brand-700 active:bg-brand-700 disabled:opacity-40"
            aria-label="Send"
          >
            <SendHorizontal className="size-5" />
          </button>
        </form>
      </div>

      {/* ── Details sheet ──────────────────────────────────────── */}
      <Sheet open={showMembers} onOpenChange={setShowMembers}>
        <SheetContent
          side="right"
          className="w-[88%] gap-0 bg-paper sm:max-w-sm"
        >
          <SheetHeader className="border-b border-line">
            <SheetTitle>Details</SheetTitle>
            <SheetDescription>
              {roomType === "dm"
                ? "Direct message"
                : `${roomName} · ${members.length} members`}
            </SheetDescription>
          </SheetHeader>
          <ul className="flex-1 overflow-y-auto p-2">
            {members.map((m) => (
              <li
                key={m.id}
                className="flex items-center gap-3 rounded-xl px-2.5 py-2.5 hover:bg-mist"
              >
                <MemberRow member={m} self={m.id === currentUserId} />
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ── Bubbles & attachments ────────────────────────────────────── */

function Bubble({
  msg,
  mine,
  tail,
  sign,
  onOpen,
  onMediaLoad,
}: {
  msg: Message;
  mine: boolean;
  tail: boolean;
  sign: SignFn;
  onOpen: (path: string, name: string) => Promise<void>;
  onMediaLoad: () => void;
}) {
  if (isImage(msg) && msg.attachment_path) {
    return (
      <AttachmentImage
        path={msg.attachment_path}
        name={msg.attachment_name ?? "image"}
        sign={sign}
        onOpen={onOpen}
        onLoaded={onMediaLoad}
        tailSide={mine ? "right" : "left"}
        tail={tail}
      />
    );
  }

  const shape = mine
    ? `rounded-2xl ${tail ? "rounded-br-md" : ""}`
    : `rounded-2xl ${tail ? "rounded-bl-md" : ""}`;
  const surface = mine
    ? "bg-brand-600 text-white"
    : "border border-line bg-paper text-ink";

  if (msg.kind === "file" && msg.attachment_path) {
    return (
      <button
        type="button"
        onClick={() =>
          void onOpen(msg.attachment_path!, msg.attachment_name ?? "file")
        }
        className={`flex items-center gap-2.5 px-3 py-2.5 text-left ${shape} ${surface}`}
      >
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            mine ? "bg-white/20" : "bg-brand-50 text-brand-700"
          }`}
        >
          <FileText className="size-[18px]" />
        </span>
        <span className="min-w-0">
          <span className="block max-w-52 truncate text-[14px] font-medium">
            {msg.attachment_name ?? msg.body}
          </span>
          <span
            className={`block text-[11.5px] ${
              mine ? "text-white/70" : "text-muted"
            }`}
          >
            {formatBytes(msg.attachment_size) || "Attachment"}
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className={`px-3.5 py-2 ${shape} ${surface}`}>
      <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
        {msg.body}
      </p>
    </div>
  );
}

function AttachmentImage({
  path,
  name,
  sign,
  onOpen,
  onLoaded,
  tailSide,
  tail,
}: {
  path: string;
  name: string;
  sign: SignFn;
  onOpen: (path: string, name: string) => Promise<void>;
  onLoaded: () => void;
  tailSide: "left" | "right";
  tail: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void sign(path).then((signed) => {
      if (cancelled) return;
      if (signed) setUrl(signed);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [path, sign]);

  const shape = `rounded-2xl ${
    tail ? (tailSide === "right" ? "rounded-br-md" : "rounded-bl-md") : ""
  }`;

  if (failed) {
    return (
      <button
        type="button"
        onClick={() => void onOpen(path, name)}
        className={`border border-line bg-paper px-3.5 py-2 text-[14px] font-medium text-brand-700 underline underline-offset-2 ${shape}`}
      >
        {name}
      </button>
    );
  }

  if (!url) {
    return (
      <div
        className={`h-44 w-56 max-w-full animate-pulse bg-line/70 ${shape}`}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => void onOpen(path, name)}
      className={`block overflow-hidden border border-line bg-paper ${shape}`}
      aria-label={`Open image ${name}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- signed
          Supabase URLs are short-lived; next/image can't optimize them */}
      <img
        src={url}
        alt={name}
        loading="lazy"
        onLoad={onLoaded}
        onError={() => setFailed(true)}
        className="max-h-72 w-auto max-w-full object-cover"
      />
    </button>
  );
}

function MemberRow({
  member,
  self,
}: {
  member: Pick<Profile, "id" | "full_name" | "role">;
  self?: boolean;
}) {
  const online = useIsOnline(member.id);
  return (
    <>
      <span className="relative shrink-0">
        <Avatar name={member.full_name} size="sm" />
        <PresenceDot
          online={online}
          className="absolute -bottom-0.5 -right-0.5 ring-2 ring-paper"
        />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-ink">
          {member.full_name}
          {self && <span className="ml-1.5 text-[12px] text-muted">(you)</span>}
        </p>
        <p className="text-xs capitalize text-muted">{member.role}</p>
      </div>
    </>
  );
}

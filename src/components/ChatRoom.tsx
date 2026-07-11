"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  ensureRealtimeAuth,
  fetchMessagesSince,
  subscribeToRoomMessages,
} from "@/lib/supabase/realtime";
import { markRoomRead } from "@/app/actions/rooms";
import { CallButton } from "@/components/call/CallButton";
import { Avatar } from "@/components/Avatar";
import type { Message, Profile } from "@/lib/types";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

function formatMsgTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ChatRoom({
  roomId,
  roomName,
  currentUserId,
  members,
  initialMessages,
}: {
  roomId: string;
  roomName: string;
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastCreatedAtRef = useRef<string | null>(
    initialMessages[initialMessages.length - 1]?.created_at ?? null,
  );

  const memberMap = useMemo(() => {
    const m = new Map<string, string>();
    members.forEach((p) => m.set(p.id, p.full_name));
    return m;
  }, [members]);

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
  }, []);

  useEffect(() => {
    let cancelled = false;
    let channel: ReturnType<typeof subscribeToRoomMessages> | null = null;

    (async () => {
      await ensureRealtimeAuth(supabase);
      if (cancelled) return;
      channel = subscribeToRoomMessages(supabase, roomId, mergeMessage);
      await markRoomRead(roomId);
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
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [supabase, roomId, mergeMessage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

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
    if (data) mergeMessage(data as Message);
    await markRoomRead(roomId);
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
    await markRoomRead(roomId);
  }

  async function downloadAttachment(path: string, name: string) {
    const { data, error: dlError } = await supabase.storage
      .from("attachments")
      .download(path);
    if (dlError || !data) {
      setError(dlError?.message ?? "Download failed");
      return;
    }
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-center gap-2 border-b border-line bg-[#f0f2f5] px-2 py-2 sm:px-3">
        <a
          href="/rooms"
          className="sm:hidden rounded-full p-2 text-muted hover:bg-black/5"
          aria-label="Back"
        >
          ←
        </a>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[16px] font-semibold text-ink">
            {roomName}
          </h1>
          <p className="truncate text-[12px] text-muted">
            {members.length} members
          </p>
        </div>
        <CallButton
          roomId={roomId}
          roomName={roomName}
          currentUserId={currentUserId}
          members={members}
        />
        <button
          type="button"
          onClick={() => setShowMembers((v) => !v)}
          className="rounded-full px-2.5 py-2 text-[13px] font-medium text-muted hover:bg-black/5"
        >
          Info
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        <div className="chat-wallpaper h-full overflow-y-auto px-3 py-3 space-y-1.5 sm:px-6">
          {messages.map((msg) => {
            if (msg.kind === "system") {
              return (
                <div key={msg.id} className="flex justify-center py-1.5">
                  <span className="rounded-md bg-white/90 px-2.5 py-1 text-[11px] text-muted shadow-sm">
                    {msg.body}
                  </span>
                </div>
              );
            }
            const mine = msg.sender_id === currentUserId;
            const name = msg.sender_id
              ? (memberMap.get(msg.sender_id) ?? "Unknown")
              : "";
            return (
              <div
                key={msg.id}
                className={`flex ${mine ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-[14.5px] leading-snug shadow-sm ${
                    mine
                      ? "rounded-tr-none bg-[#d9fdd3] text-ink"
                      : "rounded-tl-none bg-white text-ink"
                  }`}
                >
                  {!mine && (
                    <p className="mb-0.5 text-[12px] font-semibold text-brand-700">
                      {name}
                    </p>
                  )}
                  {msg.kind === "file" && msg.attachment_path ? (
                    <button
                      type="button"
                      onClick={() =>
                        void downloadAttachment(
                          msg.attachment_path!,
                          msg.attachment_name ?? "file",
                        )
                      }
                      className="font-medium underline underline-offset-2"
                    >
                      {msg.attachment_name ?? msg.body}
                    </button>
                  ) : (
                    <p className="whitespace-pre-wrap break-words">{msg.body}</p>
                  )}
                  <p className="mt-0.5 text-right text-[10px] text-muted/80 tabular-nums">
                    {formatMsgTime(msg.created_at)}
                  </p>
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {showMembers && (
          <div className="absolute inset-y-0 right-0 z-20 w-72 max-w-[85%] border-l border-line bg-white shadow-lg overflow-y-auto">
            <div className="flex items-center justify-between border-b border-line px-3 py-3">
              <p className="text-sm font-semibold">Members</p>
              <button
                type="button"
                className="text-sm text-muted"
                onClick={() => setShowMembers(false)}
              >
                Close
              </button>
            </div>
            <ul className="p-2">
              {members.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-mist"
                >
                  <Avatar name={m.full_name} size="sm" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      {m.full_name}
                    </p>
                    <p className="text-[11px] capitalize text-muted">{m.role}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {error && (
        <p className="px-3 py-2 text-sm text-red-700 bg-red-50 border-t border-red-100">
          {error}
        </p>
      )}

      <form
        onSubmit={sendText}
        className="flex items-end gap-2 border-t border-line bg-[#f0f2f5] p-2 sm:p-3"
      >
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
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xl text-muted hover:bg-black/5"
          aria-label="Attach file"
        >
          +
        </button>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={1}
          placeholder="Type a message"
          className="flex-1 max-h-28 resize-none rounded-lg border-0 bg-white px-3 py-2.5 text-[15px] text-ink shadow-sm focus:outline-none focus:ring-1 focus:ring-brand-300"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendText(e);
            }
          }}
        />
        <button
          type="submit"
          disabled={sending || !body.trim()}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white disabled:opacity-40"
          aria-label="Send"
        >
          ➤
        </button>
      </form>
    </div>
  );
}

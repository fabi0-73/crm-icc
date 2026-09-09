"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  ChevronDown,
  ChevronLeft,
  CircleUserRound,
  FileText,
  Hash,
  Info,
  Paperclip,
  SendHorizontal,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  ensureRealtimeAuth,
  fetchMessagesBefore,
  fetchMessagesSince,
  fetchRoomMembers,
  sendTyping,
  subscribeToRoomMembers,
  subscribeToRoomMessages,
  type TypingEvent,
} from "@/lib/supabase/realtime";
import { deleteMessage, editMessage, markRoomRead } from "@/app/actions/rooms";
import { CallButton } from "@/components/call/CallButton";
import { Avatar } from "@/components/Avatar";
import { AttachmentPreview } from "@/components/AttachmentPreview";
import { MentionPopup } from "@/components/MentionPopup";
import { MessageActions } from "@/components/MessageActions";
import { PresenceDot } from "@/components/PresenceDot";
import { useIsOnline } from "@/components/presence/PresenceProvider";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/uikit/sheet";
import { GroupDetails } from "@/components/GroupDetails";
import { buildDaySections } from "@/lib/chat/grouping";
import type {
  Message,
  Role,
  RoomMemberRole,
  RoomMemberView,
  RoomType,
} from "@/lib/types";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TYPING_THROTTLE_MS = 2000;
const TYPING_EXPIRE_MS = 4000;
const PAGE_SIZE = 50;

/**
 * Supabase Storage keys accept only an S3-safe ASCII subset, so a file
 * named "Relazione città.pdf" fails to upload. The real name is kept in
 * attachment_name; the key only has to be unique and legal.
 */
function safeKeyName(name: string) {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-80);
  return cleaned.length > 0 ? cleaned : "file";
}

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

type SignFn = (path: string) => Promise<string | null>;

export function ChatRoom({
  roomId,
  roomName,
  roomType = "group",
  roomAvatarUrl = null,
  dmOtherUserId = null,
  currentUserId,
  currentUserRole = "assistant",
  myRoomRole = "member",
  members: initialMembers,
  initialMessages,
  hasOlder = false,
  leading = "back",
}: {
  roomId: string;
  roomName: string;
  roomType?: RoomType;
  roomAvatarUrl?: string | null;
  dmOtherUserId?: string | null;
  currentUserId: string;
  currentUserRole?: Role;
  myRoomRole?: RoomMemberRole;
  members: RoomMemberView[];
  initialMessages: Message[];
  /** More history exists above the first loaded message. */
  hasOlder?: boolean;
  /** Agents have no sidebar or tab bar — their only way out is here. */
  leading?: "back" | "account";
}) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [members, setMembers] = useState<RoomMemberView[]>(initialMembers);
  const [myRole, setMyRole] = useState<RoomMemberRole>(myRoomRole);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [typers, setTypers] = useState<Record<string, number>>({});
  const [older, setOlder] = useState({ has: hasOlder, loading: false });

  // #2 attachment staging — a picked-but-unsent file plus its preview URL.
  const [staged, setStaged] = useState<File | null>(null);
  const stagedUrlRef = useRef<string | null>(null);
  // #6 mentions — the active "@…" token (if any) and the ids we've inserted.
  const [mention, setMention] = useState<{ query: string; start: number } | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const recordedMentionsRef = useRef<Map<string, string>>(new Map());
  // #7 reply/edit — the message being replied to and the id being edited.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  // #8 jump-to-latest visibility, derived from scroll position.
  const [showJump, setShowJump] = useState(false);

  const streamRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const nearBottomRef = useRef(true);
  const didInitScrollRef = useRef(false);
  const lastTypingSentRef = useRef(0);
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCreatedAtRef = useRef<string | null>(
    initialMessages[initialMessages.length - 1]?.created_at ?? null,
  );

  useEffect(() => {
    setMembers(initialMembers);
  }, [initialMembers]);
  useEffect(() => {
    setMyRole(myRoomRole);
  }, [myRoomRole]);

  // Live roster: any room_members change for this room re-reads the
  // authoritative membership. If it no longer includes me (removed or I
  // left elsewhere), leave the room — staying would 404 on reload.
  const refreshMembers = useCallback(async () => {
    try {
      const roster = await fetchRoomMembers(supabase, roomId);
      setMembers(roster);
      const me = roster.find((m) => m.id === currentUserId);
      if (!me) {
        if (roomType !== "dm") router.push("/rooms");
        return;
      }
      setMyRole(me.room_role);
    } catch {
      // transient; the next event or a reload reconciles
    }
  }, [supabase, roomId, currentUserId, roomType, router]);

  useEffect(() => {
    if (roomType === "dm") return; // dm membership is fixed
    let channel: ReturnType<typeof subscribeToRoomMembers> | null = null;
    let cancelled = false;
    (async () => {
      await ensureRealtimeAuth(supabase);
      if (cancelled) return;
      channel = subscribeToRoomMembers(supabase, roomId, () => {
        void refreshMembers();
      });
    })();
    return () => {
      cancelled = true;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [supabase, roomId, roomType, refreshMembers]);

  const memberMap = useMemo(() => {
    const m = new Map<string, string>();
    members.forEach((p) => m.set(p.id, p.full_name));
    return m;
  }, [members]);

  const sections = useMemo(() => buildDaySections(messages), [messages]);
  const msgById = useMemo(() => {
    const m = new Map<string, Message>();
    messages.forEach((msg) => m.set(msg.id, msg));
    return m;
  }, [messages]);
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

  // Edits and soft-deletes arrive as UPDATEs: replace the row in place by
  // id. If the id isn't loaded yet (rare — an edit racing the insert), fall
  // back to appending so nothing is lost.
  const upsertMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === msg.id);
      if (idx === -1) {
        const next = [...prev, msg].sort(
          (a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
        lastCreatedAtRef.current = next[next.length - 1]?.created_at ?? null;
        return next;
      }
      const next = prev.slice();
      next[idx] = msg;
      return next;
    });
  }, []);

  const onTyping = useCallback(
    (event: TypingEvent) => {
      if (event.user_id === currentUserId) return;
      setTypers((prev) => ({ ...prev, [event.user_id]: Date.now() }));
    },
    [currentUserId],
  );

  // Messages that arrive while the room is open are read the moment they
  // land — otherwise the unread badge for THIS room grows behind your back
  // and reappears the next time the list is refetched.
  const scheduleMarkRead = useCallback(() => {
    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    markReadTimerRef.current = setTimeout(() => {
      void markRoomRead(roomId).catch(() => {});
    }, 800);
  }, [roomId]);

  // The server snapshot can be stale twice over: the client router keeps
  // a visited room's payload for 30s (next.config staleTimes), and even a
  // fresh one predates the subscription by a network round-trip. Anything
  // inserted in between exists in the badge count but not in this list.
  // So the list never trusts the snapshot alone: every time the channel
  // (re)joins, it pulls what it may have missed before marking the room
  // read. The same routine self-heals a tab whose socket dropped.
  const reconcile = useCallback(async () => {
    try {
      // Page forward until caught up: a snapshot from a long-idle tab can
      // be more than one fetch behind.
      for (let page = 0; page < 5; page++) {
        const newer = await fetchMessagesSince(
          supabase,
          roomId,
          lastCreatedAtRef.current,
        );
        newer.forEach(mergeMessage);
        if (newer.length < 100) break;
      }
      await markRoomRead(roomId);
    } catch {
      // ignore transient network errors
    }
  }, [supabase, roomId, mergeMessage]);

  // A re-render with a newer snapshot (revalidatePath after a membership
  // change) merges rather than replaces, so live messages survive.
  useEffect(() => {
    initialMessages.forEach(mergeMessage);
  }, [initialMessages, mergeMessage]);

  useEffect(() => {
    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    (async () => {
      await ensureRealtimeAuth(supabase);
      if (cancelled) return;
      channel = subscribeToRoomMessages(
        supabase,
        roomId,
        (msg) => {
          mergeMessage(msg);
          if (
            msg.sender_id !== currentUserId &&
            document.visibilityState === "visible"
          ) {
            scheduleMarkRead();
          }
        },
        onTyping,
        () => {
          if (!cancelled) void reconcile();
        },
        upsertMessage,
      );
      channelRef.current = channel;
    })();

    const onFocus = () => void reconcile();

    const onVisibility = () => {
      if (document.visibilityState === "visible") void onFocus();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      channelRef.current = null;
      if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [
    supabase,
    roomId,
    mergeMessage,
    upsertMessage,
    onTyping,
    currentUserId,
    scheduleMarkRead,
    reconcile,
  ]);

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
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = distFromBottom < 140;
    setShowJump(distFromBottom > 200);
  }, []);

  /** Scroll the stream to a specific message (used by reply quotes). */
  const jumpToMessage = useCallback((id: string) => {
    const el = streamRef.current?.querySelector(`[data-mid="${id}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const sign = useCallback<SignFn>(
    async (path) => {
      const { data } = await supabase.storage
        .from("attachments")
        .createSignedUrl(path, 3600);
      return data?.signedUrl ?? null;
    },
    [supabase],
  );

  /** Prepend one page of history, holding the reader's scroll position. */
  const loadOlder = useCallback(async () => {
    const el = streamRef.current;
    const first = messages[0];
    if (!el || !first || older.loading) return;
    setOlder((o) => ({ ...o, loading: true }));
    const prevHeight = el.scrollHeight;
    try {
      const page = await fetchMessagesBefore(
        supabase,
        roomId,
        first.created_at,
        PAGE_SIZE,
      );
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...page.filter((m) => !seen.has(m.id)), ...prev];
      });
      setOlder({ has: page.length === PAGE_SIZE, loading: false });
      requestAnimationFrame(() => {
        el.scrollTop += el.scrollHeight - prevHeight;
      });
    } catch {
      setOlder((o) => ({ ...o, loading: false }));
    }
  }, [messages, older.loading, supabase, roomId]);

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

  // ── #6 mentions ─────────────────────────────────────────────
  // Match an active "@token" ending at the caret: the "@" must open the
  // word (line start or after whitespace) and hold no whitespace after it.
  function detectMention(value: string, caret: number) {
    const upto = value.slice(0, caret);
    const m = upto.match(/(?:^|\s)@([^\s@]*)$/);
    if (!m) return null;
    const query = m[1];
    return { query, start: caret - query.length - 1 };
  }

  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return members
      .filter((m) => m.id !== currentUserId)
      .filter((m) => m.full_name.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mention, members, currentUserId]);

  useEffect(() => {
    setMentionIndex(0);
  }, [mention?.query]);

  function insertMention(member: RoomMemberView) {
    if (!mention) return;
    const before = body.slice(0, mention.start);
    const after = body.slice(mention.start + 1 + mention.query.length);
    const token = `@${member.full_name} `;
    const next = before + token + after;
    recordedMentionsRef.current.set(member.id, member.full_name);
    setBody(next);
    setMention(null);
    const caret = (before + token).length;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(caret, caret);
        autoresize();
      }
    });
  }

  // Only report ids whose "@Name" text still survives at send time — a
  // recorded mention whose text was deleted before sending is dropped.
  function collectMentions(text: string): string[] {
    const ids: string[] = [];
    recordedMentionsRef.current.forEach((name, id) => {
      if (text.includes(`@${name}`)) ids.push(id);
    });
    return Array.from(new Set(ids));
  }

  // ── #2 attachment staging ───────────────────────────────────
  function stageFile(file: File) {
    if (file.size > MAX_FILE_BYTES) {
      setError("File must be under 25 MB.");
      return;
    }
    setError(null);
    if (stagedUrlRef.current) {
      URL.revokeObjectURL(stagedUrlRef.current);
      stagedUrlRef.current = null;
    }
    if (file.type.startsWith("image/")) {
      stagedUrlRef.current = URL.createObjectURL(file);
    }
    setStaged(file);
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function cancelStaged() {
    if (stagedUrlRef.current) {
      URL.revokeObjectURL(stagedUrlRef.current);
      stagedUrlRef.current = null;
    }
    setStaged(null);
  }

  // Revoke any dangling preview URL when the room unmounts.
  useEffect(
    () => () => {
      if (stagedUrlRef.current) URL.revokeObjectURL(stagedUrlRef.current);
    },
    [],
  );

  // ── send (text / staged file share the composer) ────────────
  function submit(e: React.FormEvent | React.KeyboardEvent) {
    e.preventDefault();
    if (sending) return;
    if (staged) void sendStagedFile();
    else void sendText();
  }

  async function sendText() {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);

    const mentions = collectMentions(text);
    const payload: Record<string, unknown> = {
      room_id: roomId,
      sender_id: currentUserId,
      kind: "text",
      body: text,
    };
    if (replyTo) payload.reply_to = replyTo.id;
    if (mentions.length) payload.metadata = { mentions };

    const { data, error: insertError } = await supabase
      .from("messages")
      .insert(payload)
      .select("*")
      .single();

    setSending(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setBody("");
    setReplyTo(null);
    setMention(null);
    recordedMentionsRef.current.clear();
    requestAnimationFrame(autoresize);
    if (data) mergeMessage(data as Message);
    await markRoomRead(roomId).catch(() => {});
  }

  async function sendStagedFile() {
    if (!staged) return;
    await sendFile(staged, body.trim());
  }

  async function sendFile(file: File, caption?: string) {
    if (file.size > MAX_FILE_BYTES) {
      setError("File must be under 25 MB.");
      return;
    }
    setSending(true);
    setError(null);

    const path = `${roomId}/${crypto.randomUUID()}/${safeKeyName(file.name)}`;
    const { error: uploadError } = await supabase.storage
      .from("attachments")
      .upload(path, file, { contentType: file.type, upsert: false });

    if (uploadError) {
      setSending(false);
      setError(uploadError.message);
      return;
    }

    const payload: Record<string, unknown> = {
      room_id: roomId,
      sender_id: currentUserId,
      kind: "file",
      body: caption && caption.length > 0 ? caption : file.name,
      attachment_path: path,
      attachment_name: file.name,
      attachment_size: file.size,
      attachment_mime: file.type || null,
    };
    if (replyTo) payload.reply_to = replyTo.id;

    const { data, error: insertError } = await supabase
      .from("messages")
      .insert(payload)
      .select("*")
      .single();

    setSending(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    cancelStaged();
    setBody("");
    setReplyTo(null);
    requestAnimationFrame(autoresize);
    if (data) mergeMessage(data as Message);
    await markRoomRead(roomId).catch(() => {});
  }

  // ── #7 edit / delete ────────────────────────────────────────
  async function saveEdit(msg: Message, nextBody: string) {
    const text = nextBody.trim();
    if (!text || actionBusy) return;
    setActionBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("message_id", msg.id);
    fd.set("room_id", roomId);
    fd.set("body", text);
    const res = await editMessage({}, fd);
    setActionBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    // Optimistic; the realtime UPDATE confirms the same row shortly after.
    upsertMessage({ ...msg, body: text, edited_at: new Date().toISOString() });
    setEditing(null);
  }

  async function removeMessage(msg: Message) {
    if (actionBusy) return;
    setActionBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("message_id", msg.id);
    fd.set("room_id", roomId);
    const res = await deleteMessage({}, fd);
    setActionBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    upsertMessage({ ...msg, deleted_at: new Date().toISOString() });
    if (editing === msg.id) setEditing(null);
    if (replyTo?.id === msg.id) setReplyTo(null);
  }

  const canDeleteMessage = useCallback(
    (msg: Message) =>
      !msg.deleted_at &&
      msg.kind !== "system" &&
      (msg.sender_id === currentUserId ||
        currentUserRole === "admin" ||
        currentUserRole === "manager" ||
        myRole === "admin"),
    [currentUserId, currentUserRole, myRole],
  );

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
    <div className="flex h-full flex-col bg-stream">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line/80 bg-paper/90 px-1.5 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] backdrop-blur-md sm:px-3">
        {leading === "account" ? (
          <Link
            href="/account"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink active:bg-mist"
            aria-label="Your account"
          >
            <CircleUserRound className="size-6" />
          </Link>
        ) : (
          <Link
            href="/rooms"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-ink active:bg-mist sm:hidden"
            aria-label="Back to chats"
          >
            <ChevronLeft className="size-6" />
          </Link>
        )}

        {roomType === "dm" ? (
          <span className="relative ml-1 shrink-0 sm:ml-0">
            <Avatar name={roomName} size="sm" />
            <PresenceDot
              online={dmOtherOnline}
              className="absolute -bottom-0.5 -right-0.5 ring-2 ring-paper"
            />
          </span>
        ) : roomAvatarUrl ? (
          <span className="ml-1 shrink-0 sm:ml-0">
            <Avatar name={roomName} size="sm" src={roomAvatarUrl} />
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
          // Deactivated accounts can't answer — never offer them.
          members={members.filter((m) => m.is_active !== false)}
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
          <div className="mx-auto w-full max-w-3xl">
          {older.has && (
            <div className="flex justify-center py-3">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={older.loading}
                className="rounded-full border border-line/70 bg-white/80 px-3.5 py-1.5 text-[12px] font-medium text-muted shadow-xs backdrop-blur active:bg-mist disabled:opacity-50"
              >
                {older.loading ? "Loading…" : "Load earlier messages"}
              </button>
            </div>
          )}
          {sections.map((day) => (
            <div key={day.key}>
              <div className="my-3 flex justify-center">
                <span
                  suppressHydrationWarning
                  className="rounded-full border border-line/70 bg-white/75 px-3 py-1 text-[11px] font-medium text-muted shadow-xs backdrop-blur"
                >
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
                          data-mid={msg.id}
                          className="group mt-[3px] flex max-w-[85%] flex-row-reverse items-center gap-1 sm:max-w-[70%]"
                        >
                          <div className="min-w-0">
                            {editing === msg.id ? (
                              <EditBox
                                initial={msg.body}
                                busy={actionBusy}
                                onCancel={() => setEditing(null)}
                                onSave={(v) => void saveEdit(msg, v)}
                              />
                            ) : (
                              <Bubble
                                msg={msg}
                                mine
                                tail={i === g.messages.length - 1}
                                sign={sign}
                                repliedMsg={
                                  msg.reply_to
                                    ? (msgById.get(msg.reply_to) ?? null)
                                    : null
                                }
                                repliedName={repliedName(msg, msgById, memberMap)}
                                mentionsMe={mentionsUser(msg, currentUserId)}
                                memberMap={memberMap}
                                onJumpToReply={
                                  msg.reply_to
                                    ? () => jumpToMessage(msg.reply_to!)
                                    : undefined
                                }
                                onMediaLoad={() => {
                                  if (nearBottomRef.current)
                                    scrollToBottom(false);
                                }}
                              />
                            )}
                          </div>
                          {!msg.deleted_at && editing !== msg.id && (
                            <MessageActions
                              align="right"
                              canReply
                              canEdit={msg.kind === "text"}
                              canDelete={canDeleteMessage(msg)}
                              onReply={() => setReplyTo(msg)}
                              onEdit={() => setEditing(msg.id)}
                              onDelete={() => void removeMessage(msg)}
                            />
                          )}
                        </div>
                      ))}
                      <p
                        suppressHydrationWarning
                        className="mt-1 text-[11px] tabular-nums text-muted/80"
                      >
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
                        <span
                          suppressHydrationWarning
                          className="shrink-0 text-[11px] tabular-nums text-muted"
                        >
                          {formatMsgTime(first.created_at)}
                        </span>
                      </p>
                      {g.messages.map((msg, i) => (
                        <div
                          key={msg.id}
                          data-mid={msg.id}
                          className="group mt-[3px] flex max-w-[85%] items-center gap-1 sm:max-w-[70%]"
                        >
                          <div className="min-w-0">
                            <Bubble
                              msg={msg}
                              mine={false}
                              tail={i === g.messages.length - 1}
                              sign={sign}
                              repliedMsg={
                                msg.reply_to
                                  ? (msgById.get(msg.reply_to) ?? null)
                                  : null
                              }
                              repliedName={repliedName(msg, msgById, memberMap)}
                              mentionsMe={mentionsUser(msg, currentUserId)}
                              memberMap={memberMap}
                              onJumpToReply={
                                msg.reply_to
                                  ? () => jumpToMessage(msg.reply_to!)
                                  : undefined
                              }
                              onMediaLoad={() => {
                                if (nearBottomRef.current)
                                  scrollToBottom(false);
                              }}
                            />
                          </div>
                          {!msg.deleted_at && (
                            <MessageActions
                              align="left"
                              canReply
                              canEdit={false}
                              canDelete={canDeleteMessage(msg)}
                              onReply={() => setReplyTo(msg)}
                              onEdit={() => {}}
                              onDelete={() => void removeMessage(msg)}
                            />
                          )}
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
        {showJump && (
          <button
            type="button"
            onClick={() => scrollToBottom(true)}
            aria-label="Jump to latest messages"
            className="absolute bottom-4 right-4 z-10 flex h-10 w-10 items-center justify-center rounded-full border border-line/70 bg-paper text-ink shadow-md backdrop-blur transition hover:bg-mist active:scale-95"
          >
            <ChevronDown className="size-5" />
          </button>
        )}
      </div>

      {/* ── Composer ───────────────────────────────────────────── */}
      <div className="shrink-0 border-t border-line/80 bg-paper/95 px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-3">
        {error && (
          <p className="mx-auto mb-2 w-full max-w-3xl rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {error}
          </p>
        )}
        {replyTo && (
          <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-xl border-l-2 border-brand-500 bg-secondary px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-brand-700">
                Replying to{" "}
                {replyTo.sender_id
                  ? (memberMap.get(replyTo.sender_id) ?? "Unknown")
                  : "System"}
              </p>
              <p className="truncate text-[13px] text-muted">
                {messageSnippet(replyTo)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setReplyTo(null)}
              aria-label="Cancel reply"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mist active:bg-mist"
            >
              <X className="size-[18px]" />
            </button>
          </div>
        )}
        {staged && (
          <AttachmentPreview
            file={staged}
            previewUrl={stagedUrlRef.current}
            onCancel={cancelStaged}
          />
        )}
        <form
          onSubmit={submit}
          className="mx-auto flex w-full max-w-3xl items-end gap-1.5"
        >
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) stageFile(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={sending || !!staged}
            onClick={() => fileRef.current?.click()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mist active:bg-mist disabled:opacity-40"
            aria-label="Attach file"
          >
            <Paperclip className="size-[21px]" />
          </button>
          <div className="relative flex min-h-10 flex-1 items-end rounded-3xl bg-secondary px-4 py-2">
            <MentionPopup
              matches={mentionMatches}
              activeIndex={mentionIndex}
              onSelect={insertMention}
              onHover={setMentionIndex}
            />
            <textarea
              ref={taRef}
              value={body}
              onChange={(e) => {
                const val = e.target.value;
                setBody(val);
                autoresize();
                if (val.trim()) noteTyping();
                const caret = e.target.selectionStart ?? val.length;
                setMention(detectMention(val, caret));
              }}
              onFocus={() => {
                // Keep the latest messages visible above the keyboard.
                setTimeout(() => {
                  if (nearBottomRef.current) scrollToBottom(false);
                }, 250);
              }}
              rows={1}
              placeholder={staged ? "Add a caption…" : "Message"}
              className="max-h-32 w-full resize-none bg-transparent text-[16px] leading-snug text-ink outline-none placeholder:text-muted"
              onKeyDown={(e) => {
                if (mention && mentionMatches.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMentionIndex((i) => (i + 1) % mentionMatches.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionIndex(
                      (i) =>
                        (i - 1 + mentionMatches.length) % mentionMatches.length,
                    );
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    const pick = mentionMatches[mentionIndex] ?? mentionMatches[0];
                    if (pick) insertMention(pick);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMention(null);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(e);
                }
              }}
            />
          </div>
          <button
            type="submit"
            disabled={sending || (!staged && !body.trim())}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-grad text-white shadow-brand transition-[opacity,transform] hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:shadow-none"
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
          {roomType === "dm" ? (
            <>
              <SheetHeader className="border-b border-line">
                <SheetTitle>Details</SheetTitle>
                <SheetDescription>Direct message</SheetDescription>
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
            </>
          ) : (
            <GroupDetails
              roomId={roomId}
              roomName={roomName}
              roomType={roomType}
              roomAvatarUrl={roomAvatarUrl}
              members={members}
              currentUserId={currentUserId}
              currentUserRole={currentUserRole}
              myRoomRole={myRole}
              onRosterChanged={refreshMembers}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/* ── Bubbles & attachments ────────────────────────────────────── */

/**
 * Signs the object as soon as the bubble renders. Attachments are opened
 * through a plain <a>: signing inside the click handler leaves the user
 * gesture behind, and mobile Safari then blocks the window silently.
 */
function useSignedUrl(path: string | null, sign: SignFn) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setFailed(false);
    void sign(path)
      .then((signed) => {
        if (cancelled) return;
        if (signed) setUrl(signed);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, sign]);

  return { url, failed, setFailed };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `userId` is listed in the message's metadata.mentions. */
function mentionsUser(msg: Message, userId: string): boolean {
  const ids = (msg.metadata as { mentions?: unknown } | null)?.mentions;
  return Array.isArray(ids) && ids.includes(userId);
}

/** Display name of the author of the message `msg` replies to. */
function repliedName(
  msg: Message,
  byId: Map<string, Message>,
  names: Map<string, string>,
): string {
  if (!msg.reply_to) return "Message";
  const target = byId.get(msg.reply_to);
  if (!target) return "Message";
  if (!target.sender_id) return "System";
  return names.get(target.sender_id) ?? "Unknown";
}

/** One-line preview used in reply bars and reply quotes. */
function messageSnippet(msg: Message): string {
  if (msg.deleted_at) return "Deleted message";
  if (msg.kind === "file") return msg.attachment_name ?? "Attachment";
  const text = msg.body ?? "";
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}

/**
 * Render a message body with any @mentions highlighted. Mentions are the
 * literal "@Full Name" strings whose ids are in metadata.mentions; longest
 * names match first so "@Anna Maria" wins over "@Anna".
 */
function renderMentions(
  body: string,
  msg: Message,
  memberMap: Map<string, string> | undefined,
  mine: boolean,
): React.ReactNode {
  const ids = (msg.metadata as { mentions?: unknown } | null)?.mentions;
  if (!memberMap || !Array.isArray(ids) || ids.length === 0) return body;
  const names = ids
    .map((id) => (typeof id === "string" ? memberMap.get(id) : undefined))
    .filter((n): n is string => Boolean(n));
  if (names.length === 0) return body;
  const unique = Array.from(new Set(names)).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(${unique.map((n) => `@${escapeRegExp(n)}`).join("|")})`, "g");
  return body.split(re).map((part, i) =>
    i % 2 === 1 ? (
      <span
        key={i}
        className={
          mine
            ? "font-semibold underline decoration-white/40 underline-offset-2"
            : "font-semibold text-brand-700"
        }
      >
        {part}
      </span>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/** Inline editor swapped in for a bubble while a message is being edited. */
function EditBox({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: string;
  busy: boolean;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = ref.current;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.style.height = "0px";
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    }
  }, []);

  return (
    <div className="w-72 max-w-full rounded-2xl border border-brand-200 bg-paper px-3 py-2 shadow-xs">
      <textarea
        ref={ref}
        value={value}
        rows={1}
        onChange={(e) => {
          setValue(e.target.value);
          const ta = e.target;
          ta.style.height = "0px";
          ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSave(value);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="max-h-40 w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink outline-none"
      />
      <div className="mt-1 flex justify-end gap-2 text-[13px]">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-2.5 py-1 text-muted hover:bg-mist"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={() => onSave(value)}
          className="rounded-lg bg-brand-grad px-3 py-1 font-medium text-white disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function Bubble({
  msg,
  mine,
  tail,
  sign,
  onMediaLoad,
  repliedMsg = null,
  repliedName: repliedAuthor = "Message",
  mentionsMe = false,
  memberMap,
  onJumpToReply,
}: {
  msg: Message;
  mine: boolean;
  tail: boolean;
  sign: SignFn;
  onMediaLoad: () => void;
  repliedMsg?: Message | null;
  repliedName?: string;
  mentionsMe?: boolean;
  memberMap?: Map<string, string>;
  onJumpToReply?: () => void;
}) {
  // Soft-deleted messages collapse to a muted tombstone — no body,
  // attachment, or actions (actions are suppressed by the caller).
  if (msg.deleted_at) {
    return (
      <div className="rounded-2xl border border-line/60 px-3.5 py-2 text-[13px] italic text-muted">
        This message was deleted
      </div>
    );
  }

  const accent = mentionsMe ? "border-l-2 border-brand-500 pl-2" : undefined;

  const replyQuote = msg.reply_to ? (
    <button
      type="button"
      onClick={onJumpToReply}
      className={`mb-1 block w-full truncate rounded-lg border-l-2 px-2 py-1 text-left text-[12px] ${
        mine
          ? "border-white/50 bg-white/10 text-white/85"
          : "border-brand-400 bg-brand-50/70 text-muted"
      }`}
    >
      <span className="font-semibold">{repliedAuthor}</span>
      {" — "}
      {repliedMsg ? messageSnippet(repliedMsg) : "Message"}
    </button>
  ) : null;

  const edited = msg.edited_at ? (
    <span
      className={`ml-1.5 align-baseline text-[10.5px] ${
        mine ? "text-white/70" : "text-muted"
      }`}
    >
      (edited)
    </span>
  ) : null;

  const shape = mine
    ? `rounded-2xl ${tail ? "rounded-br-md" : ""}`
    : `rounded-2xl ${tail ? "rounded-bl-md" : ""}`;
  const surface = mine
    ? "bg-brand-grad text-white shadow-bubble"
    : "border border-line/70 bg-paper text-ink shadow-xs";

  // A caption lives in body; show it only when it differs from the
  // filename (a captionless file send stores the filename in body).
  const caption =
    msg.kind === "file" && msg.body && msg.body !== msg.attachment_name
      ? msg.body
      : null;

  if (isImage(msg) && msg.attachment_path) {
    return (
      <div className={accent}>
        {replyQuote}
        <AttachmentImage
          path={msg.attachment_path}
          name={msg.attachment_name ?? "image"}
          sign={sign}
          onLoaded={onMediaLoad}
          tailSide={mine ? "right" : "left"}
          tail={tail}
        />
        {caption ? (
          <p className="mt-1 whitespace-pre-wrap break-words px-1 text-[14px] text-ink">
            {renderMentions(caption, msg, memberMap, false)}
            {edited}
          </p>
        ) : (
          edited && <div className="mt-0.5 px-1">{edited}</div>
        )}
      </div>
    );
  }

  if (msg.kind === "file" && msg.attachment_path) {
    return (
      <div className={accent}>
        {replyQuote}
        <AttachmentFile
          msg={msg}
          mine={mine}
          sign={sign}
          className={`${shape} ${surface}`}
        />
        {caption ? (
          <p className="mt-1 whitespace-pre-wrap break-words px-1 text-[14px] text-ink">
            {renderMentions(caption, msg, memberMap, false)}
            {edited}
          </p>
        ) : (
          edited && <div className="mt-0.5 px-1">{edited}</div>
        )}
      </div>
    );
  }

  return (
    <div className={accent}>
      {replyQuote}
      <div className={`px-3.5 py-2 ${shape} ${surface}`}>
        <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
          {renderMentions(msg.body, msg, memberMap, mine)}
          {edited}
        </p>
      </div>
    </div>
  );
}

function AttachmentFile({
  msg,
  mine,
  sign,
  className,
}: {
  msg: Message;
  mine: boolean;
  sign: SignFn;
  className: string;
}) {
  const { url, failed } = useSignedUrl(msg.attachment_path, sign);
  const name = msg.attachment_name ?? msg.body;

  const inner = (
    <>
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
          mine ? "bg-white/20" : "bg-brand-50 text-brand-700"
        }`}
      >
        <FileText className="size-[18px]" />
      </span>
      <span className="min-w-0">
        <span className="block max-w-52 truncate text-[14px] font-medium">
          {name}
        </span>
        <span
          className={`block text-[11.5px] ${
            mine ? "text-white/70" : "text-muted"
          }`}
        >
          {failed
            ? "Unavailable"
            : formatBytes(msg.attachment_size) || "Attachment"}
        </span>
      </span>
    </>
  );

  const shell = `flex items-center gap-2.5 px-3 py-2.5 text-left ${className}`;

  if (!url) {
    return (
      <div className={`${shell} ${failed ? "" : "opacity-70"}`}>{inner}</div>
    );
  }

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={shell}>
      {inner}
    </a>
  );
}

function AttachmentImage({
  path,
  name,
  sign,
  onLoaded,
  tailSide,
  tail,
}: {
  path: string;
  name: string;
  sign: SignFn;
  onLoaded: () => void;
  tailSide: "left" | "right";
  tail: boolean;
}) {
  const { url, failed, setFailed } = useSignedUrl(path, sign);

  const shape = `rounded-2xl ${
    tail ? (tailSide === "right" ? "rounded-br-md" : "rounded-bl-md") : ""
  }`;

  if (failed) {
    return (
      <div
        className={`border border-line bg-paper px-3.5 py-2 text-[14px] font-medium text-muted ${shape}`}
      >
        {name} · unavailable
      </div>
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
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
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
    </a>
  );
}

function MemberRow({
  member,
  self,
}: {
  member: Pick<RoomMemberView, "id" | "full_name" | "role">;
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  Bold,
  ChevronDown,
  ChevronLeft,
  CircleUserRound,
  FileText,
  Hash,
  Info,
  Italic,
  List,
  ListOrdered,
  Paperclip,
  SendHorizontal,
  Underline,
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
import { MentionPopup } from "@/components/MentionPopup";
import { MessageActions } from "@/components/MessageActions";
import { MessageStatus, type DeliveryStatus } from "@/components/MessageStatus";
import { MuteToggle } from "@/components/MuteToggle";
import {
  StagedAttachments,
  type StagedItem,
} from "@/components/StagedAttachments";
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
import { MediaHistory } from "@/components/MediaHistory";
import { ImageLightbox } from "@/components/ImageLightbox";
import {
  messageAttachments,
  type MessageAttachment,
} from "@/lib/media/attachments";
import { renderRichText } from "@/lib/chat/rich-text";
import { buildDaySections } from "@/lib/chat/grouping";
import type {
  Message,
  Role,
  RoomMemberRole,
  RoomMemberView,
  RoomType,
} from "@/lib/types";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Messages are chat, not documents — anything longer belongs in a file. */
const MAX_MESSAGE_CHARS = 1000;
/** Show the counter only when the limit is actually in sight. */
const COUNTER_VISIBLE_FROM = 800;

/**
 * Attachments are restricted to formats a team actually shares. This is an
 * ALLOWLIST rather than a blocklist of ".exe"-style extensions: a blocklist
 * is impossible to keep complete (.exe .msi .bat .cmd .scr .js .jar .ps1 …),
 * and anything unexpected should be refused rather than waved through.
 */
const ALLOWED_FILE_EXT = new Set([
  // documents
  "pdf", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx",
  "txt", "rtf", "odt", "ods", "odp",
  // images
  "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "svg", "avif",
  // audio / video
  "mp3", "wav", "m4a", "ogg", "mp4", "mov", "webm", "avi", "mkv",
  // archives
  "zip", "rar", "7z",
]);

function fileExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** null when allowed, otherwise the reason to show the user. */
function rejectFile(file: File): string | null {
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is larger than 25 MB.`;
  }
  const ext = fileExt(file.name);
  if (!ext) return `${file.name} has no file extension, so it can't be sent.`;
  if (!ALLOWED_FILE_EXT.has(ext)) {
    return `.${ext} files can't be sent for security reasons. Allowed: documents, images, audio, video and zip archives.`;
  }
  return null;
}
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

type SignFn = (path: string) => Promise<string | null>;

export function ChatRoom({
  roomId,
  roomName,
  roomType = "group",
  roomAvatarUrl = null,
  roomCreatedBy = null,
  dmOtherUserId = null,
  currentUserId,
  currentUserRole = "assistant",
  myRoomRole = "member",
  members: initialMembers,
  initialMessages,
  hasOlder = false,
  leading = "back",
  readOnly = false,
}: {
  roomId: string;
  roomName: string;
  roomType?: RoomType;
  roomAvatarUrl?: string | null;
  /** Who created the room — used to gate group deletion (creator or admin). */
  roomCreatedBy?: string | null;
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
  /**
   * A non-member admin previewing history: read the conversation but no
   * composer, no reply/edit affordances, no marking the room read.
   */
  readOnly?: boolean;
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
  /** Which pane of the details sheet is showing (roster vs shared media). */
  const [detailsTab, setDetailsTab] = useState<"members" | "media">("members");
  const [typers, setTypers] = useState<Record<string, number>>({});
  const [older, setOlder] = useState({ has: hasOlder, loading: false });

  // #8 attachment staging — one OR MORE picked-but-unsent files, each with
  // its own preview object URL. A mirror ref lets unmount revoke them all.
  const [staged, setStaged] = useState<StagedItem[]>([]);
  const stagedRef = useRef<StagedItem[]>([]);
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
  /** Messages that arrived while the reader was scrolled away from the
   *  bottom, so the jump button can say how many they haven't seen. */
  const [unseenBelow, setUnseenBelow] = useState(0);

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
  // #10 guard so an unknown-sender roster refresh fires once (debounced),
  // never in a loop even if the sender genuinely isn't in the room.
  const senderRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const requestedSenderRefreshRef = useRef<Set<string>>(new Set());

  // Keep a mirror of staged files so the unmount cleanup can revoke every
  // preview URL without re-subscribing on each change.
  useEffect(() => {
    stagedRef.current = staged;
  }, [staged]);

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
        // A read-only admin is intentionally not a member — don't evict them.
        if (roomType !== "dm" && !readOnly) router.push("/rooms");
        return;
      }
      setMyRole(me.room_role);
    } catch {
      // transient; the next event or a reload reconciles
    }
  }, [supabase, roomId, currentUserId, roomType, router, readOnly]);

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

  // #10 A message can arrive from someone who joined after this roster was
  // loaded — their name would read as a placeholder until reload. When we
  // meet an unknown, non-null sender, pull the roster once (debounced, and
  // guarded per id so a sender who truly isn't a member can't loop).
  const ensureSenderKnown = useCallback(
    (senderId: string | null) => {
      if (!senderId || memberMap.has(senderId)) return;
      if (requestedSenderRefreshRef.current.has(senderId)) return;
      requestedSenderRefreshRef.current.add(senderId);
      if (senderRefreshTimerRef.current) {
        clearTimeout(senderRefreshTimerRef.current);
      }
      senderRefreshTimerRef.current = setTimeout(() => {
        void refreshMembers();
      }, 400);
    },
    [memberMap, refreshMembers],
  );

  useEffect(() => {
    for (const msg of messages) {
      if (msg.sender_id && !memberMap.has(msg.sender_id)) {
        ensureSenderKnown(msg.sender_id);
      }
    }
  }, [messages, memberMap, ensureSenderKnown]);

  useEffect(
    () => () => {
      if (senderRefreshTimerRef.current) {
        clearTimeout(senderRefreshTimerRef.current);
      }
    },
    [],
  );

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
    // Arrived while scrolled up? Surface it on the jump button instead of
    // letting it slip in unnoticed above the fold.
    if (!nearBottomRef.current && msg.sender_id !== currentUserId) {
      setUnseenBelow((n) => n + 1);
    }
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
    if (readOnly) return; // a non-member admin has no read state to update
    if (markReadTimerRef.current) clearTimeout(markReadTimerRef.current);
    markReadTimerRef.current = setTimeout(() => {
      void markRoomRead(roomId).catch(() => {});
    }, 800);
  }, [roomId, readOnly]);

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
      if (!readOnly) await markRoomRead(roomId);
    } catch {
      // ignore transient network errors
    }
  }, [supabase, roomId, mergeMessage, readOnly]);

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
    setUnseenBelow(0);
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
    if (distFromBottom < 140) setUnseenBelow(0);
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

  /**
   * Apply formatting to the composer selection. Wraps the selected text in a
   * delimiter, or prefixes each selected line for lists — so the toolbar is
   * just a shortcut for syntax people can also type by hand.
   */
  function applyFormat(kind: "bold" | "italic" | "underline" | "bullet" | "number") {
    const ta = taRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? 0;
    const end = ta.selectionEnd ?? 0;
    const selected = body.slice(start, end);

    let replacement: string;
    if (kind === "bullet" || kind === "number") {
      const lines = (selected || "").split(/\r?\n/);
      replacement = lines
        .map((line, i) => (kind === "bullet" ? `- ${line}` : `${i + 1}. ${line}`))
        .join("\n");
    } else {
      const mark = kind === "bold" ? "**" : kind === "underline" ? "__" : "*";
      replacement = `${mark}${selected}${mark}`;
    }

    const next = body.slice(0, start) + replacement + body.slice(end);
    if (next.length > MAX_MESSAGE_CHARS) return;
    setBody(next);
    requestAnimationFrame(() => {
      ta.focus();
      // Put the caret inside the marks when nothing was selected, so typing
      // continues in the new style.
      const caret = selected
        ? start + replacement.length
        : start + (kind === "bullet" ? 2 : kind === "number" ? 3 : replacement.length / 2);
      ta.setSelectionRange(caret, caret);
      autoresize();
    });
  }

  // ── #8 attachment staging (multiple) ────────────────────────
  function stageFiles(files: File[]) {
    if (files.length === 0) return;
    const additions: StagedItem[] = [];
    let rejection: string | null = null;
    for (const file of files) {
      const reason = rejectFile(file);
      if (reason) {
        rejection = rejection ?? reason;
        continue;
      }
      additions.push({
        id: crypto.randomUUID(),
        file,
        url: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      });
    }
    setError(rejection);
    if (additions.length === 0) return;
    setStaged((prev) => [...prev, ...additions]);
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function removeStaged(id: string) {
    setStaged((prev) => {
      const item = prev.find((s) => s.id === id);
      if (item?.url) URL.revokeObjectURL(item.url);
      return prev.filter((s) => s.id !== id);
    });
  }

  function cancelStaged() {
    setStaged((prev) => {
      prev.forEach((s) => {
        if (s.url) URL.revokeObjectURL(s.url);
      });
      return [];
    });
  }

  // Revoke any dangling preview URLs when the room unmounts.
  useEffect(
    () => () => {
      stagedRef.current.forEach((s) => {
        if (s.url) URL.revokeObjectURL(s.url);
      });
    },
    [],
  );

  // ── send (text / staged file share the composer) ────────────
  function submit(e: React.FormEvent | React.KeyboardEvent) {
    e.preventDefault();
    if (sending) return;
    if (staged.length > 0) void sendStaged();
    else void sendText();
  }

  async function sendText() {
    const text = body.trim();
    if (!text || sending) return;
    if (text.length > MAX_MESSAGE_CHARS) {
      setError(
        `Messages are limited to ${MAX_MESSAGE_CHARS} characters (yours is ${text.length}).`,
      );
      return;
    }
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

  async function sendStaged() {
    if (staged.length === 0 || sending) return;
    setSending(true);
    setError(null);

    const caption = body.trim();
    // Upload every file first; the message row only points at them.
    const uploaded: {
      path: string;
      name: string;
      size: number;
      mime: string | null;
    }[] = [];
    for (const item of staged) {
      const file = item.file;
      const path = `${roomId}/${crypto.randomUUID()}/${safeKeyName(file.name)}`;
      const { error: uploadError } = await supabase.storage
        .from("attachments")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) {
        setSending(false);
        setError(uploadError.message);
        return;
      }
      uploaded.push({
        path,
        name: file.name,
        size: file.size,
        mime: file.type || null,
      });
    }

    // The schema has single attachment_* columns: the first file fills
    // them; any extras ride along in metadata.attachments as an array.
    const [head, ...rest] = uploaded;
    const payload: Record<string, unknown> = {
      room_id: roomId,
      sender_id: currentUserId,
      kind: "file",
      body: caption.length > 0 ? caption : head.name,
      attachment_path: head.path,
      attachment_name: head.name,
      attachment_size: head.size,
      attachment_mime: head.mime,
    };
    if (rest.length > 0) payload.metadata = { attachments: rest };
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
          roomType={roomType}
          currentUserId={currentUserId}
          currentUserRole={currentUserRole}
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
                              canReply={!readOnly}
                              canEdit={!readOnly && msg.kind === "text"}
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
                        className="mt-1 flex items-center gap-1 text-[11px] tabular-nums text-muted/80"
                      >
                        {formatMsgTime(last.created_at)}
                        {!last.deleted_at && (
                          <MessageStatus
                            status={deliveryStatus(
                              last,
                              members,
                              currentUserId,
                            )}
                          />
                        )}
                      </p>
                    </div>
                  );
                }
                const name = g.senderId
                  ? (memberMap.get(g.senderId) ?? "Member")
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
                              canReply={!readOnly}
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
            aria-label={
              unseenBelow > 0
                ? `${unseenBelow} new message${unseenBelow === 1 ? "" : "s"} — jump to latest`
                : "Jump to latest messages"
            }
            className={`absolute bottom-4 right-4 z-10 flex items-center justify-center gap-1.5 rounded-full border shadow-md backdrop-blur transition active:scale-95 ${
              unseenBelow > 0
                ? "border-transparent bg-brand-600 px-3.5 h-10 text-[13px] font-semibold text-white hover:bg-brand-700"
                : "h-10 w-10 border-line/70 bg-paper text-ink hover:bg-mist"
            }`}
          >
            {unseenBelow > 0 && (
              <span className="tabular-nums">
                {unseenBelow > 99 ? "99+" : unseenBelow} new
              </span>
            )}
            <ChevronDown className="size-5" />
          </button>
        )}
      </div>

      {/* ── Composer (hidden for a read-only admin preview) ────── */}
      {!readOnly && (
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
                  ? (memberMap.get(replyTo.sender_id) ?? "Member")
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
        <StagedAttachments items={staged} onRemove={removeStaged} />
        <div className="flex items-center gap-0.5 px-1 pb-1">
          {(
            [
              { kind: "bold", label: "Bold", Icon: Bold },
              { kind: "italic", label: "Italic", Icon: Italic },
              { kind: "underline", label: "Underline", Icon: Underline },
              { kind: "bullet", label: "Bulleted list", Icon: List },
              { kind: "number", label: "Numbered list", Icon: ListOrdered },
            ] as const
          ).map(({ kind, label, Icon }) => (
            <button
              key={kind}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyFormat(kind)}
              aria-label={label}
              title={label}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-mist hover:text-ink"
            >
              <Icon className="size-4" />
            </button>
          ))}
        </div>
        <form
          onSubmit={submit}
          className="mx-auto flex w-full max-w-3xl items-end gap-1.5"
        >
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files ? Array.from(e.target.files) : [];
              if (files.length) stageFiles(files);
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
              maxLength={MAX_MESSAGE_CHARS}
              placeholder={staged.length > 0 ? "Add a caption…" : "Message"}
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
            disabled={sending || (staged.length === 0 && !body.trim())}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-grad text-white shadow-brand transition-[opacity,transform] hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:shadow-none"
            aria-label="Send"
          >
            <SendHorizontal className="size-5" />
          </button>
        </form>
        {/* Only appears as the limit comes into view, so it never nags. */}
        {body.length >= COUNTER_VISIBLE_FROM && (
          <p
            className={`px-4 pb-1 text-right text-[11px] tabular-nums ${
              body.length >= MAX_MESSAGE_CHARS
                ? "font-semibold text-red-600"
                : "text-muted"
            }`}
          >
            {body.length} / {MAX_MESSAGE_CHARS}
          </p>
        )}
      </div>
      )}

      {/* ── Details sheet ──────────────────────────────────────── */}
      <Sheet
        open={showMembers}
        onOpenChange={(open) => {
          setShowMembers(open);
          if (!open) setDetailsTab("members");
        }}
      >
        <SheetContent
          side="right"
          className="w-[88%] gap-0 bg-paper sm:max-w-sm"
        >
          {detailsTab === "media" ? (
            <>
              <SheetHeader className="border-b border-line">
                <SheetTitle>Details</SheetTitle>
                <SheetDescription>Shared files and links</SheetDescription>
              </SheetHeader>
              <DetailsTabs value={detailsTab} onChange={setDetailsTab} />
              <MediaHistory
                roomId={roomId}
                members={members}
                liveMessages={messages}
              />
            </>
          ) : roomType === "dm" ? (
            <>
              <SheetHeader className="border-b border-line">
                <SheetTitle>Details</SheetTitle>
                <SheetDescription>Direct message</SheetDescription>
              </SheetHeader>
              <DetailsTabs value={detailsTab} onChange={setDetailsTab} />
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
              <div className="border-t border-line p-2">
                <MuteToggle roomId={roomId} />
              </div>
            </>
          ) : (
            <GroupDetails
              roomId={roomId}
              roomName={roomName}
              roomType={roomType}
              roomAvatarUrl={roomAvatarUrl}
              roomCreatedBy={roomCreatedBy}
              members={members}
              currentUserId={currentUserId}
              currentUserRole={currentUserRole}
              myRoomRole={myRole}
              onRosterChanged={refreshMembers}
              tabs={<DetailsTabs value={detailsTab} onChange={setDetailsTab} />}
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


/** True when `userId` is listed in the message's metadata.mentions. */
function mentionsUser(msg: Message, userId: string): boolean {
  const ids = (msg.metadata as { mentions?: unknown } | null)?.mentions;
  return Array.isArray(ids) && ids.includes(userId);
}

/**
 * #9 delivery state for one of the current user's own messages, derived
 * from the live roster. No other member → "sent"; otherwise "seen" once
 * everyone else has read past it (their last_read_at ≥ created_at), else
 * "delivered".
 */
function deliveryStatus(
  msg: Message,
  members: RoomMemberView[],
  currentUserId: string,
): DeliveryStatus {
  const others = members.filter((m) => m.id !== currentUserId);
  if (others.length === 0) return "sent";
  const created = new Date(msg.created_at).getTime();
  const allSeen = others.every(
    (m) => m.last_read_at != null && new Date(m.last_read_at).getTime() >= created,
  );
  return allSeen ? "seen" : "delivered";
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
  return names.get(target.sender_id) ?? "Member";
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
/**
 * Message body → React nodes: light formatting (**bold**, *italic*,
 * __underline__, bullet and numbered lists), @mention highlighting and
 * clickable links. The parsing lives in lib/chat/rich-text so this component
 * stays about the chat UI; nothing renders raw HTML.
 */
function renderBody(
  body: string,
  msg: Message,
  memberMap: Map<string, string> | undefined,
  mine: boolean,
): React.ReactNode {
  const ids = (msg.metadata as { mentions?: unknown } | null)?.mentions;
  const mentionNames =
    memberMap && Array.isArray(ids)
      ? ids
          .map((id) => (typeof id === "string" ? memberMap.get(id) : undefined))
          .filter((n): n is string => Boolean(n))
      : [];
  return renderRichText(body, { mentionNames, mine });
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

  const attachments = messageAttachments(msg);
  if (attachments.length > 0) {
    const captionBlock = caption ? (
      <p className="mt-1 whitespace-pre-wrap break-words px-1 text-[14px] text-ink">
        {renderBody(caption, msg, memberMap, false)}
        {edited}
      </p>
    ) : (
      edited && <div className="mt-0.5 px-1">{edited}</div>
    );
    return (
      <div className={accent}>
        {replyQuote}
        <div
          className={
            attachments.length > 1 ? "flex flex-col gap-1" : undefined
          }
        >
          {attachments.map((a, i) => {
            const isLast = i === attachments.length - 1;
            if ((a.mime ?? "").startsWith("image/")) {
              return (
                <AttachmentImage
                  key={a.path}
                  path={a.path}
                  name={a.name}
                  sign={sign}
                  onLoaded={onMediaLoad}
                  tailSide={mine ? "right" : "left"}
                  tail={tail && isLast}
                />
              );
            }
            return (
              <AttachmentFile
                key={a.path}
                path={a.path}
                name={a.name}
                size={a.size}
                mine={mine}
                sign={sign}
                className={`${
                  mine
                    ? `rounded-2xl ${tail && isLast ? "rounded-br-md" : ""}`
                    : `rounded-2xl ${tail && isLast ? "rounded-bl-md" : ""}`
                } ${surface}`}
              />
            );
          })}
        </div>
        {captionBlock}
      </div>
    );
  }

  return (
    <div className={accent}>
      {replyQuote}
      <div className={`px-3.5 py-2 ${shape} ${surface}`}>
        <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
          {renderBody(msg.body, msg, memberMap, mine)}
          {edited}
        </p>
      </div>
    </div>
  );
}

function AttachmentFile({
  path,
  name,
  size,
  mine,
  sign,
  className,
}: {
  path: string | null;
  name: string;
  size: number | null;
  mine: boolean;
  sign: SignFn;
  className: string;
}) {
  const { url, failed } = useSignedUrl(path, sign);

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
          {failed ? "Unavailable" : formatBytes(size) || "Attachment"}
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
  const [zoomed, setZoomed] = useState(false);

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
    <>
      {/* Opens an in-app viewer. It used to be an <a href> to the signed
          URL, which navigated the tab away from the conversation. */}
      <button
        type="button"
        onClick={() => setZoomed(true)}
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
      {zoomed && (
        <ImageLightbox src={url} name={name} onClose={() => setZoomed(false)} />
      )}
    </>
  );
}

/** Segmented switch at the top of the details sheet: roster vs shared media.
 *  Rendered for DMs and groups alike so both reach media history the same way. */
function DetailsTabs({
  value,
  onChange,
}: {
  value: "members" | "media";
  onChange: (v: "members" | "media") => void;
}) {
  const tabs: { key: "members" | "media"; label: string }[] = [
    { key: "members", label: "Members" },
    { key: "media", label: "Media" },
  ];
  return (
    <div className="flex shrink-0 gap-1 border-b border-line bg-mist/40 p-2">
      {tabs.map((t) => {
        const active = value === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            aria-pressed={active}
            className={`h-8 flex-1 rounded-lg text-[13px] font-semibold transition-colors ${
              active
                ? "bg-paper text-ink shadow-xs"
                : "text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
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

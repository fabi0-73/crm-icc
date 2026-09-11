/**
 * Media history is a PROJECTION of the messages table, not a second store.
 *
 * Attachments already live in the attachment_* columns (plus extras in
 * metadata.attachments) and links live inside message bodies, so deriving
 * on read means: no migration, no backfill, all pre-existing history is
 * covered, and — most importantly — permissions are inherited exactly from
 * the messages_select RLS policy (membership, each member's
 * can_view_history_from cutoff, and the admin override). No permission
 * logic is duplicated here.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message } from "@/lib/types";
import { messageAttachments } from "@/lib/media/attachments";
import { extractLinks } from "@/lib/media/links";

export type MediaCategory = "image" | "document" | "link" | "other";

export type MediaItem = {
  /** Stable React key: message id + slot within that message. */
  key: string;
  messageId: string;
  kind: "file" | "link";
  /** File name, or the URL itself for links. */
  name: string;
  mime: string | null;
  size: number | null;
  /** Storage object path (files only). */
  path?: string;
  /** Absolute URL (links only). */
  url?: string;
  senderId: string | null;
  createdAt: string;
};

const DOC_EXT = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "csv",
  "ppt", "pptx", "txt", "rtf", "odt", "ods",
]);

export function mediaCategory(item: MediaItem): MediaCategory {
  if (item.kind === "link") return "link";
  const mime = item.mime ?? "";
  if (mime.startsWith("image/")) return "image";
  const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
  if (DOC_EXT.has(ext)) return "document";
  if (
    mime === "application/pdf" ||
    mime.includes("spreadsheet") ||
    mime.includes("word") ||
    mime.includes("presentation") ||
    mime.startsWith("text/")
  ) {
    return "document";
  }
  return "other";
}

/** Flatten message rows into one item per attachment and per link. */
export function messagesToMediaItems(messages: Message[]): MediaItem[] {
  const out: MediaItem[] = [];
  for (const m of messages) {
    if (m.deleted_at) continue;
    messageAttachments(m).forEach((a, i) => {
      out.push({
        key: `${m.id}:f${i}`,
        messageId: m.id,
        kind: "file",
        name: a.name || "file",
        mime: a.mime,
        size: a.size,
        path: a.path,
        senderId: m.sender_id,
        createdAt: m.created_at,
      });
    });
    // System rows carry call/group notices, never user-shared links.
    if (m.kind !== "system") {
      extractLinks(m.body).forEach((u, i) => {
        out.push({
          key: `${m.id}:l${i}`,
          messageId: m.id,
          kind: "link",
          name: u,
          mime: null,
          size: null,
          url: u,
          senderId: m.sender_id,
          createdAt: m.created_at,
        });
      });
    }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

const MEDIA_COLUMNS =
  "id, room_id, sender_id, kind, body, attachment_path, attachment_name, attachment_size, attachment_mime, metadata, created_at, deleted_at, reply_to, edited_at";

/**
 * Messages in this room that carry an attachment or contain a URL, newest
 * first. The `*` is PostgREST's ilike wildcard; it is a cheap prefilter and
 * exact extraction happens in extractLinks. The room filter rides the
 * existing messages_by_room (room_id, created_at desc) index.
 */
export async function fetchRoomMedia(
  supabase: SupabaseClient,
  roomId: string,
  opts: { before?: string | null; limit?: number } = {},
): Promise<Message[]> {
  const limit = opts.limit ?? 200;
  let q = supabase
    .from("messages")
    .select(MEDIA_COLUMNS)
    .eq("room_id", roomId)
    .is("deleted_at", null)
    .or("attachment_path.not.is.null,body.ilike.*http*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (opts.before) q = q.lt("created_at", opts.before);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Message[];
}

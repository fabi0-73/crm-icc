/**
 * Media history: everything shared in a conversation, derived from the
 * message rows themselves. Attachments live on the message (columns for
 * the first file, metadata.attachments for the rest) and links are read
 * back out of the body, so the history is exactly as durable as the
 * chat — nothing to keep in sync, and old conversations already have it.
 */

import { fileExtension } from "@/lib/attachments";
import { extractUrls } from "@/lib/chat/rich-text";
import type { Message } from "@/lib/types";

/** One attachment of a message: the columns, or a metadata entry. */
export type PackedAttachment = {
  path: string;
  name: string;
  size: number | null;
  mime: string | null;
};

export function isImageFile(mime: string | null, name: string) {
  return (mime ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name);
}

export function packedAttachments(msg: Message): PackedAttachment[] {
  const extras = Array.isArray(msg.metadata?.attachments)
    ? (msg.metadata.attachments as PackedAttachment[]).filter(
        (a) => a && typeof a.path === "string",
      )
    : [];
  const primary =
    msg.attachment_path
      ? [
          {
            path: msg.attachment_path,
            name: msg.attachment_name ?? msg.body,
            size: msg.attachment_size,
            mime: msg.attachment_mime,
          },
        ]
      : [];
  return [...primary, ...extras];
}

export function formatBytes(n: number | null) {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export type MediaCategory =
  | "image"
  | "pdf"
  | "excel"
  | "document"
  | "media"
  | "archive"
  | "other"
  | "link";

export const CATEGORY_LABEL: Record<MediaCategory, string> = {
  image: "Image",
  pdf: "PDF",
  excel: "Spreadsheet",
  document: "Document",
  media: "Audio / video",
  archive: "Archive",
  other: "File",
  link: "Link",
};

const EXCEL_EXT = new Set(["xls", "xlsx", "xlsm", "csv", "ods"]);
const DOC_EXT = new Set([
  "doc", "docx", "odt", "rtf", "txt", "md", "json", "xml",
  "ppt", "pptx", "odp",
]);
const AV_EXT = new Set([
  "mp3", "wav", "m4a", "ogg", "opus", "aac", "mp4", "mov", "webm", "mkv", "avi",
]);
const ARCHIVE_EXT = new Set(["zip", "7z", "rar", "tar", "gz"]);

export function fileCategory(name: string, mime: string | null): MediaCategory {
  if (isImageFile(mime, name)) return "image";
  const ext = fileExtension(name);
  const m = (mime ?? "").toLowerCase();
  if (ext === "pdf" || m === "application/pdf") return "pdf";
  if (EXCEL_EXT.has(ext) || m.includes("spreadsheet") || m.includes("excel")) {
    return "excel";
  }
  if (
    DOC_EXT.has(ext) ||
    m.startsWith("text/") ||
    m.includes("word") ||
    m.includes("presentation") ||
    m.includes("document")
  ) {
    return "document";
  }
  if (AV_EXT.has(ext) || m.startsWith("audio/") || m.startsWith("video/")) {
    return "media";
  }
  if (ARCHIVE_EXT.has(ext) || m.includes("zip") || m.includes("compressed")) {
    return "archive";
  }
  return "other";
}

export type MediaItem = {
  /** Stable across refetches: message id + attachment path or link slot. */
  id: string;
  kind: "file" | "link";
  category: MediaCategory;
  /** File name, or the link's host. */
  name: string;
  /** Absolute URL — links only. */
  url: string | null;
  /** Storage object key — files only. */
  path: string | null;
  size: number | null;
  mime: string | null;
  messageId: string;
  senderId: string | null;
  createdAt: string;
  /** Text sent alongside the item; the link card's snippet. */
  context: string;
};

export function linkHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

/** The part of a link worth showing under its host, if any. */
export function linkDetail(url: string) {
  try {
    const parsed = new URL(url);
    const tail = `${parsed.pathname}${parsed.search}`;
    return tail === "/" ? "" : tail;
  } catch {
    return "";
  }
}

function itemsFromMessage(msg: Message): MediaItem[] {
  if (msg.kind === "system") return [];

  const files = packedAttachments(msg);
  // File sends fall back to the first file's name as the body, which is
  // not a caption — don't show it as one.
  const caption = msg.body === files[0]?.name ? "" : msg.body;
  const items: MediaItem[] = files.map((file) => ({
    id: `${msg.id}:${file.path}`,
    kind: "file",
    category: fileCategory(file.name, file.mime),
    name: file.name,
    url: null,
    path: file.path,
    size: file.size,
    mime: file.mime,
    messageId: msg.id,
    senderId: msg.sender_id,
    createdAt: msg.created_at,
    context: caption,
  }));

  const seen = new Set<string>();
  extractUrls(caption).forEach((raw, i) => {
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (seen.has(url)) return;
    seen.add(url);
    items.push({
      id: `${msg.id}:link:${i}`,
      kind: "link",
      category: "link",
      name: linkHost(url),
      url,
      path: null,
      size: null,
      mime: null,
      messageId: msg.id,
      senderId: msg.sender_id,
      createdAt: msg.created_at,
      context: caption,
    });
  });

  return items;
}

/** Every shared file and link, newest first, deduped by message. */
export function mediaItemsFrom(messages: Message[]): MediaItem[] {
  const byId = new Map<string, Message>();
  for (const msg of messages) byId.set(msg.id, msg);
  return [...byId.values()]
    .flatMap(itemsFromMessage)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
}

export type MediaFilter =
  | "all"
  | "image"
  | "pdf"
  | "excel"
  | "document"
  | "other"
  | "link";

export const MEDIA_FILTERS: { id: MediaFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "pdf", label: "PDFs" },
  { id: "excel", label: "Excel" },
  { id: "document", label: "Documents" },
  { id: "other", label: "Other files" },
  { id: "link", label: "Links" },
];

export function matchesFilter(item: MediaItem, filter: MediaFilter) {
  if (filter === "all") return true;
  if (filter === "other") {
    return (
      item.category === "other" ||
      item.category === "media" ||
      item.category === "archive"
    );
  }
  return item.category === filter;
}

/** Name, type, link target, sender and caption all answer the search. */
export function matchesQuery(item: MediaItem, senderName: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    item.name,
    item.url ?? "",
    item.mime ?? "",
    CATEGORY_LABEL[item.category],
    senderName,
    item.context,
  ].some((field) => field.toLowerCase().includes(needle));
}

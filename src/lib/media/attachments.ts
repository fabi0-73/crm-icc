import type { Message } from "@/lib/types";

export type MessageAttachment = {
  path: string;
  name: string;
  size: number | null;
  mime: string | null;
};

/**
 * Every attachment a file message carries: the first lives in the
 * attachment_* columns, any extras in metadata.attachments. A plain
 * single-file message yields exactly one entry, so its bubble is
 * unchanged.
 *
 * Shared by the chat bubble and the media-history panel so both agree on
 * what "the attachments of a message" means.
 */
export function messageAttachments(msg: Message): MessageAttachment[] {
  if (msg.kind !== "file") return [];
  const out: MessageAttachment[] = [];
  if (msg.attachment_path) {
    out.push({
      path: msg.attachment_path,
      name: msg.attachment_name ?? msg.body,
      size: msg.attachment_size,
      mime: msg.attachment_mime,
    });
  }
  const extra = (msg.metadata as { attachments?: unknown } | null)?.attachments;
  if (Array.isArray(extra)) {
    for (const a of extra) {
      if (
        a &&
        typeof a === "object" &&
        typeof (a as { path?: unknown }).path === "string"
      ) {
        const rec = a as {
          path: string;
          name?: unknown;
          size?: unknown;
          mime?: unknown;
        };
        out.push({
          path: rec.path,
          name: typeof rec.name === "string" ? rec.name : "file",
          size: typeof rec.size === "number" ? rec.size : null,
          mime: typeof rec.mime === "string" ? rec.mime : null,
        });
      }
    }
  }
  return out;
}

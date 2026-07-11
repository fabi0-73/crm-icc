import type { Message } from "@/lib/types";

/** Consecutive same-sender messages within this window collapse
 *  under one name/avatar header (Slack-style). */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type MessageGroup =
  | { kind: "system"; key: string; message: Message }
  | { kind: "chat"; key: string; senderId: string | null; messages: Message[] };

export type DaySection = { key: string; label: string; groups: MessageGroup[] };

export function dayLabel(d: Date, now: Date): string {
  if (d.toDateString() === now.toDateString()) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** Pure render-time projection — the message array itself stays the
 *  single source of truth for realtime merging. */
export function buildDaySections(
  messages: Message[],
  now = new Date(),
): DaySection[] {
  const sections: DaySection[] = [];
  let day: DaySection | null = null;
  let group: Extract<MessageGroup, { kind: "chat" }> | null = null;

  for (const msg of messages) {
    const d = new Date(msg.created_at);
    const dayKey = d.toDateString();
    if (!day || day.key !== dayKey) {
      day = { key: dayKey, label: dayLabel(d, now), groups: [] };
      sections.push(day);
      group = null; // day boundary breaks groups
    }
    if (msg.kind === "system") {
      day.groups.push({ kind: "system", key: msg.id, message: msg });
      group = null; // system messages break groups
      continue;
    }
    const last = group?.messages[group.messages.length - 1];
    const sameRun =
      group !== null &&
      group.senderId === msg.sender_id &&
      last !== undefined &&
      d.getTime() - new Date(last.created_at).getTime() <= GROUP_WINDOW_MS;
    if (sameRun) {
      group!.messages.push(msg);
    } else {
      group = { kind: "chat", key: msg.id, senderId: msg.sender_id, messages: [msg] };
      day.groups.push(group);
    }
  }
  return sections;
}

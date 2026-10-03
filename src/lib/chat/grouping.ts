import type { Message } from "@/lib/types";

/** Consecutive same-sender messages within this window collapse
 *  under one name/avatar header (Slack-style). */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export type MessageGroup =
  | { kind: "system"; key: string; message: Message }
  | { kind: "chat"; key: string; senderId: string | null; messages: Message[] };

export type DaySection = { key: string; label: string; groups: MessageGroup[] };

/**
 * The zone the server draws the first paint in, and the browser hydrates
 * with before switching to its own. The team's PCs run on US time (they
 * call US clients) while the server runs on Tirane time: grouping by each
 * machine's own clock split days differently between the two, so the page
 * React found was not the page the server sent (hydration error #418).
 */
export const HYDRATION_TIME_ZONE = "Europe/Tirane";

/** YYYY-MM-DD of `d` in `timeZone` (undefined = this machine's zone). */
function dayKey(d: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function dayLabel(d: Date, now: Date, timeZone?: string): string {
  const key = dayKey(d, timeZone);
  if (key === dayKey(now, timeZone)) return "Today";
  if (key === dayKey(new Date(now.getTime() - 86_400_000), timeZone)) return "Yesterday";
  return d.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone,
  });
}

/** Pure render-time projection — the message array itself stays the
 *  single source of truth for realtime merging. */
export function buildDaySections(
  messages: Message[],
  now = new Date(),
  timeZone?: string,
): DaySection[] {
  const sections: DaySection[] = [];
  let day: DaySection | null = null;
  let group: Extract<MessageGroup, { kind: "chat" }> | null = null;

  for (const msg of messages) {
    const d = new Date(msg.created_at);
    const key = dayKey(d, timeZone);
    if (!day || day.key !== key) {
      day = { key, label: dayLabel(d, now, timeZone), groups: [] };
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

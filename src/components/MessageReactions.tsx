"use client";

import type { Message } from "@/lib/types";

/** The reactions on offer, in picker order. toggle_reaction (0027, 0030) accepts
 *  exactly these strings. */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "✅", "🌶️"] as const;

/**
 * The chips under a message: each emoji with its count. Tapping one adds
 * or takes back your own; hovering shows who reacted.
 */
export function MessageReactions({
  msg,
  mine,
  currentUserId,
  names,
  disabled = false,
  onToggle,
}: {
  msg: Message;
  mine: boolean;
  currentUserId: string;
  /** user id → display name. */
  names: Map<string, string>;
  disabled?: boolean;
  onToggle: (emoji: string) => void;
}) {
  const entries = Object.entries(msg.reactions ?? {}).filter(([, ids]) => ids.length > 0);
  if (msg.deleted_at || entries.length === 0) return null;
  // Picker order, so chips don't jump around as people react.
  entries.sort(
    (a, b) =>
      REACTIONS.indexOf(a[0] as (typeof REACTIONS)[number]) -
      REACTIONS.indexOf(b[0] as (typeof REACTIONS)[number]),
  );
  return (
    <div className={`mt-0.5 flex flex-wrap gap-1 px-1 ${mine ? "justify-end" : ""}`}>
      {entries.map(([emoji, ids]) => {
        const reacted = ids.includes(currentUserId);
        const who = ids
          .map((id) => (id === currentUserId ? "You" : (names.get(id) ?? "Someone")))
          .join(", ");
        return (
          <button
            key={emoji}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(emoji)}
            title={who}
            aria-label={`${emoji} ${ids.length}: ${who}${reacted ? " (tap to remove yours)" : ""}`}
            aria-pressed={reacted}
            className={`relative z-[1] flex h-6 items-center gap-1 rounded-full border px-1.5 text-[12px] leading-none shadow-xs transition-colors disabled:cursor-default ${
              reacted
                ? "border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-700 dark:bg-brand-950 dark:text-brand-300"
                : "border-line bg-paper text-ink hover:bg-mist"
            }`}
          >
            <span className="text-[14px]">{emoji}</span>
            {ids.length > 1 && <span className="tabular-nums font-semibold">{ids.length}</span>}
          </button>
        );
      })}
    </div>
  );
}

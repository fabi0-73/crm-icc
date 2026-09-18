"use client";

import { Avatar } from "@/components/Avatar";
import { publicDisplayName } from "@/lib/display-name";
import type { RoomMemberView } from "@/lib/types";

/**
 * The little list that appears while the composer holds an active
 * "@…" token. Purely presentational: ChatRoom owns the caret math,
 * the filtered matches, and which entry is active.
 */
export function MentionPopup({
  matches,
  activeIndex,
  onSelect,
  onHover,
}: {
  matches: RoomMemberView[];
  activeIndex: number;
  onSelect: (member: RoomMemberView) => void;
  onHover: (index: number) => void;
}) {
  if (matches.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 z-20 mb-2 max-h-60 w-64 overflow-y-auto rounded-2xl border border-line/80 bg-paper p-1 shadow-lg">
      {matches.map((m, i) => (
        <button
          key={m.id}
          type="button"
          // onMouseDown, not onClick: a click would first blur the
          // textarea and drop the caret we need to splice into.
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(m);
          }}
          onMouseEnter={() => onHover(i)}
          className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left ${
            i === activeIndex ? "bg-mist" : ""
          }`}
        >
          <Avatar
            name={publicDisplayName(m)}
            size="sm"
            userId={m.id}
            className="!h-7 !w-7 !text-[10px]"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium text-ink">
              {publicDisplayName(m)}
            </span>
            <span className="block text-[11px] capitalize text-muted">
              {m.role}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

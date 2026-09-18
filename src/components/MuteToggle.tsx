"use client";

import { Bell, BellOff } from "lucide-react";
import { setRoomMuted, setUserMuted, useRoomMuted, useUserMuted } from "@/lib/mutes";

/**
 * Per-conversation "Mute notifications" switch. The mute is stored on the
 * server (lib/mutes), so it silences this chat on every device and stops
 * its push notifications too. Calls still ring.
 */
export function MuteToggle({ roomId }: { roomId: string }) {
  const muted = useRoomMuted(roomId);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={muted}
      onClick={() => void setRoomMuted(roomId, !muted)}
      className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left hover:bg-mist"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted">
        {muted ? <BellOff className="size-[18px]" /> : <Bell className="size-[18px]" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">
          Mute notifications
        </span>
        <span className="block text-[12px] text-muted">
          {muted
            ? "Muted on all your devices · calls still ring"
            : "You'll be notified"}
        </span>
      </span>
      <span
        aria-hidden
        className={`relative h-6 w-10 shrink-0 rounded-full transition-colors ${
          muted ? "bg-brand-500" : "bg-line"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-xs transition-transform ${
            muted ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}

/**
 * Mute one person everywhere — their messages in every group and DM stop
 * making a sound or sending a notification. They are not told.
 */
export function PersonMuteButton({
  userId,
  name,
  className = "",
}: {
  userId: string;
  name: string;
  className?: string;
}) {
  const muted = useUserMuted(userId);
  const label = muted
    ? `Unmute notifications from ${name}`
    : `Mute notifications from ${name}`;
  return (
    <button
      type="button"
      onClick={() => void setUserMuted(userId, !muted)}
      aria-pressed={muted}
      aria-label={label}
      title={label}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-mist ${
        muted ? "text-brand-600 dark:text-brand-300" : "text-muted hover:text-ink"
      } ${className}`}
    >
      {muted ? <BellOff className="size-4" /> : <Bell className="size-4" />}
    </button>
  );
}

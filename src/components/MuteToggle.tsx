"use client";

import { Bell, BellOff } from "lucide-react";
import { setRoomMuted, useRoomMuted } from "@/lib/notify-prefs";

/**
 * Per-conversation "Mute notifications" switch. Reads and writes the
 * device-local mute set in @/lib/notify-prefs; the message/sound layer
 * consults that same set, so flipping this silences just this room.
 */
export function MuteToggle({ roomId }: { roomId: string }) {
  const muted = useRoomMuted(roomId);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={muted}
      onClick={() => setRoomMuted(roomId, !muted)}
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
          {muted ? "Muted on this device" : "You'll be notified"}
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

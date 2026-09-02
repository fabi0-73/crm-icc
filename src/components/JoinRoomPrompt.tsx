"use client";

import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { joinRoom } from "@/app/actions/rooms";
import { Button } from "@/components/ui/Button";

/**
 * Admins and managers can see every room, but reading and posting need a
 * membership row. Without this they got an empty chat whose composer
 * failed with a raw row-level-security error.
 */
export function JoinRoomPrompt({
  roomId,
  roomName,
}: {
  roomId: string;
  roomName: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-stream px-6 text-center">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-paper p-6 shadow-soft">
        <p className="text-[16px] font-semibold text-ink">{roomName}</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">
          You&rsquo;re not in this conversation yet. Join to read it and post —
          everyone in the room will see that you joined.
        </p>
        <div className="mt-4">
          <ActionForm action={joinRoom} className="space-y-3">
            <input type="hidden" name="room_id" value={roomId} />
            <Button type="submit" className="w-full">
              Join conversation
            </Button>
          </ActionForm>
        </div>
        <Link
          href="/rooms"
          className="mt-3 inline-block text-[13px] font-medium text-brand-600 hover:underline"
        >
          Back to chats
        </Link>
      </div>
    </div>
  );
}

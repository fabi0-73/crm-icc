"use client";

import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Modal } from "@/components/Modal";
import { useCall } from "@/components/call/CallProvider";
import { PhoneIcon, VideoIcon } from "@/components/icons";

type CallMember = { id: string; full_name: string };

/** Chat-header call button + member picker. Dialing hands off to the
 *  app-level CallProvider, so the call outlives this room's UI. */
export function CallButton({
  roomId,
  roomName,
  roomType = "dm",
  currentUserId,
  currentUserRole = "assistant",
  members,
}: {
  roomId: string;
  roomName: string;
  roomType?: "agent_workspace" | "group" | "dm";
  currentUserId: string;
  currentUserRole?: string;
  members: CallMember[];
}) {
  const { dial, phase, signalReady } = useCall();
  const [pickerOpen, setPickerOpen] = useState(false);

  const others = members.filter((m) => m.id !== currentUserId);
  const canStart =
    roomType !== "group" ||
    currentUserRole === "admin" ||
    currentUserRole === "manager";
  const secure =
    typeof window === "undefined" ||
    window.isSecureContext ||
    location.hostname === "localhost";
  const busy = phase !== "idle";

  async function start(peer: CallMember, video: boolean) {
    setPickerOpen(false);
    await dial(roomId, roomName, peer, video);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (!canStart) return;
          setPickerOpen(true);
        }}
        disabled={busy || !canStart}
        className="rounded-full p-2 text-muted hover:bg-mist disabled:opacity-40"
        aria-label="Call"
        title={
          !canStart
            ? "Only admins and managers can start a group call"
            : busy
              ? "Already on a call"
              : signalReady
                ? "Call"
                : "Connecting…"
        }
      >
        <PhoneIcon />
      </button>

      <Modal title="Call" open={pickerOpen} onClose={() => setPickerOpen(false)}>
        {!secure && (
          <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
            Calls need HTTPS — mic and camera are blocked on this address.
          </p>
        )}
        <p className="text-xs text-muted">
          {roomType === "group"
            ? "Only members of this group can be included."
            : "They'll ring wherever they are in the app."}
        </p>
        <ul className="-mx-2 mt-2 max-h-[60vh] overflow-y-auto">
          {others.map((m) => (
            <li
              key={m.id}
              className="flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-mist"
            >
              <Avatar name={m.full_name} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                {m.full_name}
              </span>
              <button
                type="button"
                disabled={!signalReady || !secure}
                onClick={() => void start(m, false)}
                className="rounded-full bg-brand-600 p-2.5 text-white hover:bg-brand-700 disabled:opacity-40"
                aria-label={`Voice call ${m.full_name}`}
                title="Voice"
              >
                <PhoneIcon size={16} />
              </button>
              <button
                type="button"
                disabled={!signalReady || !secure}
                onClick={() => void start(m, true)}
                className="rounded-full bg-ink-soft p-2.5 text-white hover:bg-ink disabled:opacity-40"
                aria-label={`Video call ${m.full_name}`}
                title="Video"
              >
                <VideoIcon size={16} />
              </button>
            </li>
          ))}
          {others.length === 0 && (
            <li className="px-2 py-8 text-center text-sm text-muted">
              No one else in this room
            </li>
          )}
        </ul>
      </Modal>
    </>
  );
}

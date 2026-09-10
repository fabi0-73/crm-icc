"use client";

import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Modal } from "@/components/Modal";
import { useCall } from "@/components/call/CallProvider";
import { PhoneIcon, VideoIcon } from "@/components/icons";
import type { Role, RoomType } from "@/lib/types";

type CallMember = { id: string; full_name: string };

/** Chat-header call button + member picker. Dialing hands off to the
 *  app-level CallProvider, so the call outlives this room's UI. */
export function CallButton({
  roomId,
  roomName,
  currentUserId,
  members,
  roomType,
  currentUserRole,
}: {
  roomId: string;
  roomName: string;
  currentUserId: string;
  members: CallMember[];
  /** Room kind. When omitted, no group restriction is applied (behaves
   *  as before). Only "group"/"agent_workspace" are ever gated. */
  roomType?: RoomType;
  /** The current user's app-wide role, used to gate starting group calls.
   *  When omitted, no restriction is applied. */
  currentUserRole?: Role;
}) {
  const { dial, startGroupCall, phase, signalReady } = useCall();
  const [pickerOpen, setPickerOpen] = useState(false);

  const others = members.filter((m) => m.id !== currentUserId);
  // A non-DM room (group / agent workspace) can start a full-mesh group call.
  const isGroupRoom = roomType !== undefined && roomType !== "dm";
  const secure =
    typeof window === "undefined" ||
    window.isSecureContext ||
    location.hostname === "localhost";
  const busy = phase !== "idle";

  // #9/#10: in a NON-dm room only admins/managers may START a call. We only
  // restrict when we positively know the room is a group/workspace AND the
  // role is assistant/agent — an undefined roomType or role preserves the
  // previous unrestricted behavior so nothing breaks if the props are absent.
  const restricted =
    roomType !== undefined &&
    roomType !== "dm" &&
    (currentUserRole === "assistant" || currentUserRole === "agent");
  const restrictionTitle = "Only admins and managers can start group calls";

  async function start(peer: CallMember, video: boolean) {
    if (restricted) return;
    setPickerOpen(false);
    await dial(roomId, roomName, peer, video);
  }

  async function startGroup(video: boolean) {
    if (restricted) return;
    setPickerOpen(false);
    await startGroupCall(
      roomId,
      roomName,
      others.map((m) => m.id),
      video,
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        disabled={busy || restricted}
        className="rounded-full p-2 text-muted hover:bg-mist disabled:opacity-40"
        aria-label="Call"
        title={
          restricted
            ? restrictionTitle
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
        {isGroupRoom && others.length > 0 && (
          <div className="mb-3 rounded-lg bg-mist/60 p-3">
            <p className="text-sm font-semibold text-ink">Start group call</p>
            <p className="mt-0.5 text-xs text-muted">
              Rings everyone in {roomName}. People join as they answer.
            </p>
            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                disabled={!signalReady || !secure}
                onClick={() => void startGroup(false)}
                className="flex flex-1 items-center justify-center gap-2 rounded-full bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
              >
                <PhoneIcon size={16} /> Voice
              </button>
              <button
                type="button"
                disabled={!signalReady || !secure}
                onClick={() => void startGroup(true)}
                className="flex flex-1 items-center justify-center gap-2 rounded-full bg-ink-soft px-3 py-2 text-sm font-medium text-white hover:bg-ink disabled:opacity-40"
              >
                <VideoIcon size={16} /> Video
              </button>
            </div>
          </div>
        )}
        <p className="text-xs text-muted">
          {isGroupRoom
            ? "Or call one person — they'll ring wherever they are."
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

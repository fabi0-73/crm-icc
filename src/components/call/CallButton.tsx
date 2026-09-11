"use client";

import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { Modal } from "@/components/Modal";
import { MAX_CALL_PARTICIPANTS, useCall } from "@/components/call/CallProvider";
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
  const [selected, setSelected] = useState<string[]>([]);

  const others = members.filter((m) => m.id !== currentUserId);
  const canStart =
    roomType !== "group" ||
    currentUserRole === "admin" ||
    currentUserRole === "manager";
  // Everyone else in the room can be pulled into a group call at once.
  const multi = roomType !== "dm" && others.length > 1;
  const secure =
    typeof window === "undefined" ||
    window.isSecureContext ||
    location.hostname === "localhost";
  const busy = phase !== "idle";
  const atCapacity = selected.length + 1 >= MAX_CALL_PARTICIPANTS;

  async function start(peers: CallMember[], video: boolean) {
    if (peers.length === 0) return;
    setPickerOpen(false);
    setSelected([]);
    await dial(
      roomId,
      roomName,
      peers.map((p) => ({ id: p.id, name: p.full_name })),
      video,
    );
  }

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : prev.length + 1 >= MAX_CALL_PARTICIPANTS
          ? prev
          : [...prev, id],
    );
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

      <Modal
        title="Call"
        open={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          setSelected([]);
        }}
      >
        {!secure && (
          <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
            Calls need HTTPS — mic and camera are blocked on this address.
          </p>
        )}
        <p className="text-xs text-muted">
          {roomType === "group"
            ? `Only members of this group can be included (up to ${MAX_CALL_PARTICIPANTS}).`
            : "They'll ring wherever they are in the app."}
        </p>

        {multi && (
          <div className="mt-3 flex items-center gap-2 rounded-lg bg-secondary px-3 py-2">
            <span className="flex-1 text-[13px] text-ink">
              {selected.length === 0
                ? "Select people for a group call, or call one directly."
                : `${selected.length + 1} in this call`}
            </span>
            <button
              type="button"
              disabled={selected.length === 0 || !signalReady || !secure}
              onClick={() =>
                void start(
                  others.filter((m) => selected.includes(m.id)),
                  false,
                )
              }
              className="rounded-full bg-brand-600 p-2 text-white hover:bg-brand-700 disabled:opacity-40"
              aria-label="Start group voice call"
              title="Group voice call"
            >
              <PhoneIcon size={16} />
            </button>
            <button
              type="button"
              disabled={selected.length === 0 || !signalReady || !secure}
              onClick={() =>
                void start(
                  others.filter((m) => selected.includes(m.id)),
                  true,
                )
              }
              className="rounded-full bg-ink-soft p-2 text-white hover:bg-ink disabled:opacity-40"
              aria-label="Start group video call"
              title="Group video call"
            >
              <VideoIcon size={16} />
            </button>
          </div>
        )}

        <ul className="-mx-2 mt-2 max-h-[60vh] overflow-y-auto">
          {others.map((m) => {
            const picked = selected.includes(m.id);
            return (
              <li
                key={m.id}
                className="flex items-center gap-3 rounded-md px-2 py-2.5 hover:bg-mist"
              >
                {multi && (
                  <input
                    type="checkbox"
                    checked={picked}
                    disabled={!picked && atCapacity}
                    onChange={() => toggle(m.id)}
                    aria-label={`Include ${m.full_name}`}
                  />
                )}
                <Avatar name={m.full_name} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                  {m.full_name}
                </span>
                <button
                  type="button"
                  disabled={!signalReady || !secure}
                  onClick={() => void start([m], false)}
                  className="rounded-full bg-brand-600 p-2.5 text-white hover:bg-brand-700 disabled:opacity-40"
                  aria-label={`Voice call ${m.full_name}`}
                  title="Voice"
                >
                  <PhoneIcon size={16} />
                </button>
                <button
                  type="button"
                  disabled={!signalReady || !secure}
                  onClick={() => void start([m], true)}
                  className="rounded-full bg-ink-soft p-2.5 text-white hover:bg-ink disabled:opacity-40"
                  aria-label={`Video call ${m.full_name}`}
                  title="Video"
                >
                  <VideoIcon size={16} />
                </button>
              </li>
            );
          })}
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

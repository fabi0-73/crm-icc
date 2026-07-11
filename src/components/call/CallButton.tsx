"use client";

import { useState } from "react";
import { Avatar } from "@/components/Avatar";
import { useCall } from "@/components/call/CallProvider";

type CallMember = { id: string; full_name: string };

/** Chat-header call button + member picker. Dialing hands off to the
 *  app-level CallProvider, so the call outlives this room's UI. */
export function CallButton({
  roomId,
  roomName,
  currentUserId,
  members,
}: {
  roomId: string;
  roomName: string;
  currentUserId: string;
  members: CallMember[];
}) {
  const { dial, phase, signalReady } = useCall();
  const [pickerOpen, setPickerOpen] = useState(false);

  const others = members.filter((m) => m.id !== currentUserId);
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
        onClick={() => setPickerOpen(true)}
        disabled={busy}
        className="rounded-full p-2 text-muted hover:bg-black/5 disabled:opacity-40"
        aria-label="Call"
        title={busy ? "Already on a call" : signalReady ? "Call" : "Connecting…"}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1L6.6 10.8z" />
        </svg>
      </button>

      {pickerOpen && (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close"
            onClick={() => setPickerOpen(false)}
          />
          <div className="relative z-10 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-[16px] font-semibold text-ink">Call</h2>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="text-sm text-muted"
              >
                Close
              </button>
            </div>
            {!secure && (
              <p className="mx-4 mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
                Calls need HTTPS — mic and camera are blocked on this address.
              </p>
            )}
            <p className="px-4 pt-3 text-[12px] text-muted">
              They&apos;ll ring wherever they are in the app.
            </p>
            <ul className="max-h-[60vh] overflow-y-auto py-1">
              {others.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-mist"
                >
                  <Avatar name={m.full_name} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">
                    {m.full_name}
                  </span>
                  <button
                    type="button"
                    disabled={!signalReady || !secure}
                    onClick={() => void start(m, false)}
                    className="rounded-full bg-brand-600 p-2.5 text-white disabled:opacity-40"
                    aria-label={`Voice call ${m.full_name}`}
                    title="Voice"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1L6.6 10.8z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    disabled={!signalReady || !secure}
                    onClick={() => void start(m, true)}
                    className="rounded-full bg-ink-soft p-2.5 text-white disabled:opacity-40"
                    aria-label={`Video call ${m.full_name}`}
                    title="Video"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17 10.5V7c0-.6-.4-1-1-1H4c-.6 0-1 .4-1 1v10c0 .6.4 1 1 1h12c.6 0 1-.4 1-1v-3.5l4 4v-11l-4 4z" />
                    </svg>
                  </button>
                </li>
              ))}
              {others.length === 0 && (
                <li className="px-4 py-8 text-center text-sm text-muted">
                  No one else in this room
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}

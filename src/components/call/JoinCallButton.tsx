"use client";

import { useEffect, useState } from "react";
import { getLiveCall, type LiveCall } from "@/app/actions/livekit";
import { useCall } from "@/components/call/CallProvider";

const CHECK_EVERY_MS = 20_000;
/** getLiveCall shares LiveKit's answer for 5 s; a second look after a call
 *  starts or ends gets the fresh one. */
const RECHECK_AFTER_MS = 6_000;

/**
 * Group chat header: a Join button while a call is running in this
 * conversation, so anyone in the group can walk in without being rung — after
 * missing or declining the ring, reloading, or opening the chat late.
 */
export function JoinCallButton({
  roomId,
  roomName,
  refreshKey,
}: {
  roomId: string;
  roomName: string;
  /** Changes when a call starts or ends in this chat — check again then. */
  refreshKey?: string | null;
}) {
  const { call, phase, lobby, incoming, joinGroupCall, openIncomingLobby } = useCall();
  const [live, setLive] = useState<LiveCall | null>(null);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const next = await getLiveCall(roomId).catch(() => null);
      if (!stopped) setLive(next);
    };
    void check();
    const again = setTimeout(check, RECHECK_AFTER_MS);
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", check);
    return () => {
      stopped = true;
      clearTimeout(again);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
    // phase: leaving or joining a call changes what should show.
  }, [roomId, refreshKey, phase]);

  if (!live || live.roomId !== roomId) return null;
  if (call?.callId === live.callId) return null; // already in it
  const ringingForIt = phase === "ringing" && incoming?.callId === live.callId;
  const busy = (phase !== "idle" && !ringingForIt) || Boolean(lobby);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        // Being rung for this very call: Join is simply answering it.
        if (ringingForIt) openIncomingLobby();
        else void joinGroupCall({ callId: live.callId, roomId, roomName, video: live.video });
      }}
      title={
        busy
          ? "Already on a call"
          : `${live.count} ${live.count === 1 ? "person" : "people"} in the call`
      }
      aria-label="Join the call in progress"
      className="flex h-9 shrink-0 items-center gap-2 rounded-full bg-emerald-600 pl-3 pr-3.5 text-[13px] font-semibold text-white shadow-sm hover:bg-emerald-700 active:bg-emerald-700 disabled:opacity-40"
    >
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-white/70" />
        <span className="relative inline-flex size-2 rounded-full bg-white" />
      </span>
      Join
    </button>
  );
}

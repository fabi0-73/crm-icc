"use client";

import { useEffect, useRef } from "react";
import { Avatar } from "@/components/Avatar";
import { useCall } from "@/components/call/CallProvider";
import { useDuration } from "@/components/call/useDuration";
import { CamIcon, CamOffIcon, MicIcon, MicOffIcon } from "@/components/call/FullScreenCall";

/**
 * Minimized in-call tile. Floats over every page so the chat stays
 * usable during a call; tapping the video (or expand) goes full screen.
 */
export function FloatingCallTile() {
  const {
    call,
    phase,
    statusText,
    muted,
    camOff,
    localStream,
    remoteStream,
    connectedAt,
    hangup,
    toggleMic,
    toggleCam,
    setView,
  } = useCall();
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const duration = useDuration(connectedAt);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
      void remoteVideoRef.current.play().catch(() => undefined);
    }
  }, [remoteStream]);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
      void localVideoRef.current.play().catch(() => undefined);
    }
  }, [localStream]);

  if (!call) return null;
  const subtitle =
    phase === "in-call" && duration ? duration : statusText || "Ringing…";

  return (
    <div className="fixed bottom-4 right-4 z-[115] w-60 overflow-hidden rounded-2xl bg-ink text-white shadow-2xl ring-1 ring-brand-400/40 sm:w-64">
      <button
        type="button"
        onClick={() => setView("full")}
        className="relative block h-36 w-full bg-ink-soft text-left"
        aria-label="Expand call to full screen"
        title="Expand"
      >
        {call.video ? (
          <>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="h-full w-full object-cover"
            />
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={`absolute bottom-2 right-2 h-16 w-12 rounded-lg border border-white/25 object-cover ${camOff ? "opacity-30" : ""}`}
            />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <div className="relative">
              {phase !== "in-call" && (
                <span className="absolute -inset-1.5 animate-ping rounded-full bg-brand-400/30 motion-reduce:hidden" />
              )}
              <Avatar name={call.peerName} size="md" className="relative" />
            </div>
          </div>
        )}
        <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/40">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M9 3H3v6M15 21h6v-6M3 3l8 8M21 21l-8-8" />
          </svg>
        </span>
      </button>

      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold leading-tight">
            {call.peerName}
          </p>
          <p className="text-[11px] text-white/50 tabular-nums">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={toggleMic}
          className={`flex h-9 w-9 items-center justify-center rounded-full ${
            muted ? "bg-white text-ink" : "bg-white/15 hover:bg-white/25"
          }`}
          aria-label={muted ? "Unmute" : "Mute"}
          aria-pressed={muted}
        >
          <span className="scale-75">{muted ? <MicOffIcon /> : <MicIcon />}</span>
        </button>
        {call.video && (
          <button
            type="button"
            onClick={toggleCam}
            className={`flex h-9 w-9 items-center justify-center rounded-full ${
              camOff ? "bg-white text-ink" : "bg-white/15 hover:bg-white/25"
            }`}
            aria-label={camOff ? "Camera on" : "Camera off"}
            aria-pressed={camOff}
          >
            <span className="scale-75">{camOff ? <CamOffIcon /> : <CamIcon />}</span>
          </button>
        )}
        <button
          type="button"
          onClick={hangup}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500 hover:bg-red-600"
          aria-label="Hang up"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="rotate-[135deg]">
            <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1L6.6 10.8z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

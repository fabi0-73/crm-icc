"use client";

import { useEffect, useRef } from "react";
import { Avatar } from "@/components/Avatar";
import { useCall } from "@/components/call/CallProvider";
import { useDuration } from "@/components/call/useDuration";
import {
  CamIcon,
  CamOffIcon,
  ExpandIcon,
  HangUpIcon,
  MicIcon,
  MicOffIcon,
  ScreenShareIcon,
} from "@/components/icons";

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
    sharing,
    localStream,
    remoteStream,
    remoteHasVideo,
    connectedAt,
    groupPeers,
    hangup,
    toggleMic,
    toggleCam,
    toggleScreenShare,
    setView,
  } = useCall();
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const groupVideoRef = useRef<HTMLVideoElement>(null);
  const duration = useDuration(connectedAt);
  const isGroup = Boolean(call?.group);
  // Group mini tile shows the first remote participant + a total-count badge.
  const groupFirst = groupPeers[0] ?? null;

  useEffect(() => {
    const el = groupVideoRef.current;
    if (el && groupFirst?.stream) {
      el.srcObject = groupFirst.stream;
      void el.play().catch(() => undefined);
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [groupFirst?.stream]);

  // remoteHasVideo comes from the provider (recomputed from remote track
  // live/mute events, FIX C) so the tile drops back to the avatar instead
  // of freezing on the last shared frame.
  const showVideo = Boolean(call?.video || remoteHasVideo || sharing);
  // #5: fit the REMOTE element to the REMOTE content — camera fills
  // (object-cover), a shared screen is never cropped (object-contain). On a
  // voice call remote video only appears via a screen share, so that's the cue.
  const remoteIsScreen = !call?.video && remoteHasVideo;
  const fitClass = remoteIsScreen ? "object-contain" : "object-cover";

  useEffect(() => {
    const el = remoteVideoRef.current;
    if (el && remoteStream) {
      el.srcObject = remoteStream;
      void el.play().catch(() => undefined);
    }
    // FIX C: clear srcObject on cleanup so a stopped stream can't leave a
    // frozen last frame.
    return () => {
      if (el) el.srcObject = null;
    };
  }, [remoteStream]);

  useEffect(() => {
    const el = localVideoRef.current;
    if (el && localStream) {
      el.srcObject = localStream;
      void el.play().catch(() => undefined);
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [localStream]);

  if (!call) return null;
  const subtitle =
    phase === "in-call" && duration ? duration : statusText || "Ringing…";

  // Mobile: sit above the chat composer/keyboard, not on top of it.
  return (
    <div className="fixed right-3 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-[115] w-60 overflow-hidden rounded-xl bg-ink text-white shadow-lg ring-1 ring-brand-400/40 sm:right-4 sm:bottom-4 sm:w-64">
      <button
        type="button"
        onClick={() => setView("full")}
        className="relative block h-36 w-full bg-ink-soft text-left"
        aria-label="Expand call to full screen"
        title="Expand"
      >
        {isGroup ? (
          <>
            {/* Muted: audio plays through the provider's per-peer sinks. */}
            <video
              ref={groupVideoRef}
              autoPlay
              playsInline
              muted
              className={`h-full w-full bg-ink object-cover ${
                groupFirst?.hasVideo ? "" : "opacity-0"
              }`}
            />
            {(!groupFirst || !groupFirst.hasVideo) && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Avatar name={groupFirst?.name ?? call.peerName} size="md" className="relative" />
              </div>
            )}
            <span className="absolute bottom-2 left-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-semibold text-white">
              {groupPeers.length + 1} in call
            </span>
          </>
        ) : showVideo ? (
          <>
            {/* Muted: audio comes from the provider's <audio> sink only. */}
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              muted
              className={`h-full w-full bg-ink ${fitClass}`}
            />
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              // Mirror the self-view camera (never a shared screen).
              className={`absolute bottom-2 right-2 h-16 w-12 rounded-lg border border-white/25 ${
                sharing ? "object-contain bg-ink" : "object-cover -scale-x-100"
              } ${camOff && !sharing ? "opacity-30" : ""}`}
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
          <ExpandIcon />
        </span>
        {sharing && (
          <span className="absolute left-2 top-2 rounded bg-brand-500/90 px-1.5 py-0.5 text-[10px] font-medium">
            Sharing
          </span>
        )}
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
        {phase === "in-call" && (
          <button
            type="button"
            onClick={() => void toggleScreenShare()}
            className={`flex h-9 w-9 items-center justify-center rounded-full ${
              sharing ? "bg-white text-ink" : "bg-white/15 hover:bg-white/25"
            }`}
            aria-label={sharing ? "Stop sharing" : "Share screen"}
            aria-pressed={sharing}
          >
            <span className="scale-75">
              <ScreenShareIcon />
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={hangup}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500 hover:bg-red-600"
          aria-label="Hang up"
        >
          <HangUpIcon size={16} />
        </button>
      </div>
    </div>
  );
}

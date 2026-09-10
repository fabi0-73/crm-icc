"use client";

import { useEffect, useRef } from "react";
import { Avatar } from "@/components/Avatar";
import { useCall } from "@/components/call/CallProvider";
import { useDuration } from "@/components/call/useDuration";
import {
  CamIcon,
  CamOffIcon,
  HangUpIcon,
  MicIcon,
  MicOffIcon,
  MinimizeIcon,
  NoiseIcon,
  ScreenShareIcon,
} from "@/components/icons";

export function FullScreenCall() {
  const {
    call,
    phase,
    statusText,
    muted,
    camOff,
    noiseOff,
    sharing,
    localStream,
    remoteStream,
    remoteHasVideo,
    connectedAt,
    hangup,
    toggleMic,
    toggleCam,
    toggleNoise,
    toggleScreenShare,
    setView,
  } = useCall();
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const duration = useDuration(connectedAt);

  // remoteHasVideo now comes from the provider, which recomputes it from
  // the remote track's live/mute events (FIX C) so the frame doesn't freeze
  // after the peer stops sharing.
  const showVideo = Boolean(call?.video || remoteHasVideo || sharing);
  const fitClass =
    sharing || remoteHasVideo ? "object-contain" : "object-cover";

  useEffect(() => {
    const el = remoteVideoRef.current;
    if (el && remoteStream) {
      el.srcObject = remoteStream;
      void el.play().catch(() => undefined);
    }
    // FIX C: drop the stream on cleanup so a stopped stream's last frame
    // can't persist.
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
  const modeLabel = sharing
    ? "Screen"
    : call.video
      ? "Video"
      : remoteHasVideo
        ? "Screen"
        : "Voice";

  return (
    <div className="fixed inset-0 z-[115] flex flex-col bg-ink text-white">
      {/* The page draws under the notch (viewport-fit=cover), so the
          minimize button needs the inset or it sits under the status bar. */}
      <div className="flex items-center gap-3 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={() => setView("mini")}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
          aria-label="Minimize call"
          title="Minimize — chat stays open"
        >
          <MinimizeIcon />
        </button>
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold">{call.peerName}</p>
          <p className="text-xs text-white/50 tabular-nums">
            {modeLabel} · {subtitle}
          </p>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 bg-ink-soft">
        {showVideo ? (
          <>
            {/* Muted on purpose: the provider's persistent <audio> element
                is the single audio sink. Without this the same remote
                track plays twice on video calls. */}
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
              // Mirror your own camera preview, the way every video app
              // does, so it reads like a mirror instead of "reversed". A
              // shared screen must never be flipped (its text would go
              // backwards), so only the camera is mirrored.
              className={`absolute bottom-4 right-4 h-36 w-28 rounded-xl border border-white/20 ${
                sharing ? "object-contain bg-ink" : "object-cover -scale-x-100"
              } ${camOff && !sharing ? "opacity-30" : ""}`}
            />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <div className="relative">
              {phase !== "in-call" && (
                <span className="absolute -inset-2 animate-ping rounded-full bg-brand-400/30 motion-reduce:hidden" />
              )}
              <Avatar name={call.peerName} size="lg" className="!h-24 !w-24 !text-2xl relative" />
            </div>
            <p className="text-white/70 tabular-nums">{subtitle}</p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-4 px-4 pt-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <CallControlButton
          onClick={toggleMic}
          active={muted}
          label={muted ? "Unmute" : "Mute"}
        >
          {muted ? <MicOffIcon /> : <MicIcon />}
        </CallControlButton>
        {call.video && (
          <CallControlButton
            onClick={toggleCam}
            active={camOff}
            label={camOff ? "Camera on" : "Camera off"}
          >
            {camOff ? <CamOffIcon /> : <CamIcon />}
          </CallControlButton>
        )}
        {phase === "in-call" && (
          <CallControlButton
            onClick={() => void toggleScreenShare()}
            active={sharing}
            label={sharing ? "Stop share" : "Share"}
          >
            <ScreenShareIcon />
          </CallControlButton>
        )}
        <CallControlButton
          onClick={toggleNoise}
          active={noiseOff}
          label={noiseOff ? "Noise filter off" : "Noise filter on"}
        >
          <NoiseIcon />
        </CallControlButton>
        <div className="flex flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={hangup}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
            aria-label="Hang up"
          >
            <HangUpIcon />
          </button>
          <span className="text-[11px] text-white/50">End</span>
        </div>
      </div>
    </div>
  );
}

function CallControlButton({
  onClick,
  active,
  label,
  children,
}: {
  onClick: () => void;
  active: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={onClick}
        className={`flex h-14 w-14 items-center justify-center rounded-full transition-colors ${
          active ? "bg-white text-ink" : "bg-white/15 text-white hover:bg-white/25"
        }`}
        aria-label={label}
        aria-pressed={active}
      >
        {children}
      </button>
      <span className="text-[11px] text-white/50">{label}</span>
    </div>
  );
}

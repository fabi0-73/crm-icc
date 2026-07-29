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
    connectedAt,
    hangup,
    toggleMic,
    toggleCam,
    toggleNoise,
    toggleScreenShare,
    setView,
  } = useCall();
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const duration = useDuration(connectedAt);

  const remoteHasVideo = Boolean(remoteStream?.getVideoTracks().some((t) => t.readyState === "live"));
  const showVideo = Boolean(call?.video || remoteHasVideo || sharing);
  const fitClass =
    sharing || (!call?.video && remoteHasVideo) ? "object-contain" : "object-cover";

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
  const modeLabel = sharing
    ? "Screen"
    : call.video
      ? "Video"
      : remoteHasVideo
        ? "Screen"
        : "Voice";

  return (
    <div className="fixed inset-0 z-[115] flex flex-col bg-ink text-white">
      <div className="flex items-center gap-3 px-4 py-4">
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
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className={`h-full w-full bg-ink ${fitClass}`}
            />
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className={`absolute bottom-4 right-4 h-36 w-28 rounded-xl border border-white/20 ${
                sharing ? "object-contain bg-ink" : "object-cover"
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

      <div className="flex items-center justify-center gap-4 px-4 py-6">
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

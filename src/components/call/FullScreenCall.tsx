"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { useCall } from "@/components/call/CallProvider";
import { CallGrid } from "@/components/call/CallGrid";
import { CallParticipants } from "@/components/call/CallParticipants";
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
import { Users } from "lucide-react";

export function FullScreenCall() {
  const [showPeople, setShowPeople] = useState(false);
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
    groupPeers,
    hangup,
    toggleMic,
    toggleCam,
    toggleNoise,
    toggleScreenShare,
    setView,
  } = useCall();
  const isGroup = Boolean(call?.group);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const duration = useDuration(connectedAt);

  // remoteHasVideo now comes from the provider, which recomputes it from
  // the remote track's live/mute events (FIX C) so the frame doesn't freeze
  // after the peer stops sharing.
  const showVideo = Boolean(call?.video || remoteHasVideo || sharing);
  // #5: the REMOTE element fit is about the REMOTE content, not our local
  // Nothing is cropped any more. object-cover filled the frame by zooming
  // into the middle of the camera image, which is what read as "too zoomed
  // in"; letterboxing shows the whole picture instead. A shared screen must
  // never be cropped either, so both cases agree.
  const fitClass = "object-contain";

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
  const modeLabel = isGroup
    ? `Group · ${groupPeers.length + 1}`
    : sharing
      ? "Screen"
      : call.video
        ? "Video"
        : remoteHasVideo
          ? "Screen"
          : "Voice";

  return (
    <div className="fixed inset-0 z-[115] flex flex-col bg-ink text-white">
      {showPeople && call.group && (
        <CallParticipants onClose={() => setShowPeople(false)} />
      )}
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
        {isGroup ? (
          <CallGrid />
        ) : showVideo ? (
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
              className={`absolute bottom-4 right-4 h-24 w-40 rounded-xl border border-white/20 bg-ink object-contain ${
                sharing ? "" : "-scale-x-100"
              } ${camOff && !sharing ? "opacity-30" : ""}`}
            />
            {muted && (
              <span
                className="absolute bottom-4 left-4 flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-white"
                title="Muted"
                aria-label="Muted"
              >
                <MicOffIcon />
              </span>
            )}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <div className="relative">
              {phase !== "in-call" && (
                <span className="absolute -inset-2 animate-ping rounded-full bg-brand-400/30 motion-reduce:hidden" />
              )}
              <Avatar
                name={call.peerName}
                size="lg"
                userId={call.peerId}
                className="!h-24 !w-24 !text-2xl relative"
              />
            </div>
            <p className="text-white/70 tabular-nums">{subtitle}</p>
            {muted && (
              <span
                className="mt-2 flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-white"
                title="Muted"
                aria-label="Muted"
              >
                <MicOffIcon />
              </span>
            )}
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
        {phase === "in-call" && call.group && (
          <CallControlButton
            onClick={() => setShowPeople((v) => !v)}
            active={showPeople}
            label="Participants"
          >
            <Users className="size-[22px]" />
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
        {/* Suppression is ON by default (noiseOff starts false), so the control
            shows as engaged whenever the filter is on.
            Hidden in a group call: LiveKit owns microphone capture there, so
            toggleNoise is a deliberate no-op — showing a control that flips
            its own state but changes nothing is worse than not offering it. */}
        {!call.group && (
          <CallControlButton
            onClick={toggleNoise}
            active={!noiseOff}
            label={noiseOff ? "Noise filter off" : "Noise filter on"}
          >
            <NoiseIcon />
          </CallControlButton>
        )}
        <div className="flex flex-col items-center gap-1.5">
          <button
            type="button"
            onClick={hangup}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 text-white transition-transform hover:scale-105 active:scale-95"
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

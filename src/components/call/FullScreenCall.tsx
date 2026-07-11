"use client";

import { useEffect, useRef } from "react";
import { Avatar } from "@/components/Avatar";
import { useCall } from "@/components/call/CallProvider";
import { useDuration } from "@/components/call/useDuration";

export function FullScreenCall() {
  const {
    call,
    phase,
    statusText,
    muted,
    camOff,
    noiseOff,
    localStream,
    remoteStream,
    connectedAt,
    hangup,
    toggleMic,
    toggleCam,
    toggleNoise,
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
    <div className="fixed inset-0 z-[115] flex flex-col bg-ink text-white">
      <div className="flex items-center gap-3 px-4 py-4">
        <button
          type="button"
          onClick={() => setView("mini")}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 hover:bg-white/20"
          aria-label="Minimize call"
          title="Minimize — chat stays open"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold">{call.peerName}</p>
          <p className="text-[12px] text-white/50 tabular-nums">
            {call.video ? "Video" : "Voice"} · {subtitle}
          </p>
        </div>
      </div>

      <div className="relative flex-1 min-h-0 bg-ink-soft">
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
              className={`absolute bottom-4 right-4 h-36 w-28 rounded-xl border border-white/20 object-cover ${camOff ? "opacity-30" : ""}`}
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
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="rotate-[135deg]">
              <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1L6.6 10.8z" />
            </svg>
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

export function MicIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
    </svg>
  );
}

export function MicOffIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 11h-2a5 5 0 0 1-.18 1.32l1.56 1.56A6.96 6.96 0 0 0 19 11zm-4.02.16L9 5.18V5a3 3 0 0 1 6 0v6c0 .05 0 .11-.02.16zM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.24 2.73l1.46 1.46A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
    </svg>
  );
}

export function CamIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 10.5V7c0-.6-.4-1-1-1H4c-.6 0-1 .4-1 1v10c0 .6.4 1 1 1h12c.6 0 1-.4 1-1v-3.5l4 4v-11l-4 4z" />
    </svg>
  );
}

export function CamOffIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 6.5l-4 4V7c0-.6-.4-1-1-1H9.82L21 17.18V6.5zM3.27 2 2 3.27 4.73 6H4c-.6 0-1 .4-1 1v10c0 .6.4 1 1 1h12c.21 0 .39-.08.55-.18L20.73 22 22 20.73 3.27 2z" />
    </svg>
  );
}

export function NoiseIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 12h2l2-6 3 12 3-9 2 4.5L16.5 12H21" />
    </svg>
  );
}

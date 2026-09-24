"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/Avatar";
import { useCall } from "@/components/call/CallProvider";
import {
  CamIcon,
  CamOffIcon,
  HangUpIcon,
  MicIcon,
  MicOffIcon,
} from "@/components/icons";

/**
 * Preview before a group video call joins LiveKit. Mic/camera choices are
 * handed to confirmLobby so the SFU publish matches what the user picked.
 */
export function CallLobby() {
  const { lobby, incoming, selfId, confirmLobby, cancelLobby } = useCall();
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [preview, setPreview] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!lobby) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    void (async () => {
      if (!window.isSecureContext && location.hostname !== "localhost") {
        setError("Calls need HTTPS — mic and camera are blocked on this address.");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("This browser cannot access mic/camera.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        setPreview(stream);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "NotAllowedError") {
          setError("Microphone or camera permission was blocked.");
          return;
        }
        setError(err instanceof Error ? err.message : "Could not start preview.");
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      setPreview(null);
    };
  }, [lobby]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = preview;
    if (preview) void el.play().catch(() => undefined);
    return () => {
      if (el) el.srcObject = null;
    };
  }, [preview]);

  useEffect(() => {
    preview?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    preview?.getVideoTracks().forEach((t) => {
      t.enabled = !camOff;
    });
  }, [preview, muted, camOff]);

  if (!lobby) return null;

  const title =
    lobby.intent === "incoming"
      ? incoming?.peerName ?? lobby.roomName
      : lobby.roomName;
  const subtitle =
    lobby.intent === "incoming"
      ? "Joining group video"
      : lobby.intent === "join"
        ? "Joining the call in progress"
        : "Ready to start group video";

  async function join() {
    if (joining) return;
    setJoining(true);
    preview?.getTracks().forEach((t) => t.stop());
    setPreview(null);
    try {
      await confirmLobby({ muted, camOff });
    } catch {
      setJoining(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-ink/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-ink-soft text-white shadow-lift">
        <div className="relative aspect-video bg-ink">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`h-full w-full object-cover -scale-x-100 ${
              camOff || !preview ? "opacity-0" : ""
            }`}
          />
          {(camOff || !preview) && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Avatar name={title} size="lg" userId={selfId} className="!h-20 !w-20 !text-2xl" />
            </div>
          )}
          {muted && (
            <span className="absolute bottom-3 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/70">
              <span className="scale-75">
                <MicOffIcon />
              </span>
            </span>
          )}
        </div>
        <div className="px-5 pb-6 pt-4 text-center">
          <p className="truncate text-lg font-semibold">{title}</p>
          <p className="mt-0.5 text-[13px] text-white/60">{subtitle}</p>
          {error && (
            <p className="mt-2 rounded-md bg-amber-500/20 px-3 py-2 text-[12px] text-amber-100">
              {error}
            </p>
          )}
          <div className="mt-5 flex items-center justify-center gap-4">
            <LobbyToggle
              active={muted}
              label={muted ? "Mic off" : "Mic on"}
              onClick={() => setMuted((v) => !v)}
            >
              {muted ? <MicOffIcon /> : <MicIcon />}
            </LobbyToggle>
            <LobbyToggle
              active={camOff}
              label={camOff ? "Camera off" : "Camera on"}
              onClick={() => setCamOff((v) => !v)}
            >
              {camOff ? <CamOffIcon /> : <CamIcon />}
            </LobbyToggle>
          </div>
          <div className="mt-6 flex items-center justify-center gap-10">
            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={cancelLobby}
                disabled={joining}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 text-white transition-transform hover:scale-105 active:scale-95 disabled:opacity-40"
                aria-label="Cancel"
              >
                <HangUpIcon />
              </button>
              <span className="text-[11px] text-white/50">Cancel</span>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                onClick={() => void join()}
                disabled={joining}
                className="flex h-14 min-w-14 items-center justify-center rounded-full bg-brand-600 px-5 text-[15px] font-semibold text-white transition-transform hover:scale-105 active:scale-95 disabled:opacity-40"
              >
                {joining ? "Joining…" : "Join"}
              </button>
              <span className="text-[11px] text-white/50">Join call</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function LobbyToggle({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={onClick}
        className={`flex h-12 w-12 items-center justify-center rounded-full ${
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

"use client";

import { useEffect, useRef, useState } from "react";
import { LayoutGrid } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { useCall, type Participant } from "@/components/call/CallProvider";
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
    participants,
    connectedAt,
    hangup,
    toggleMic,
    toggleCam,
    toggleNoise,
    toggleScreenShare,
    muteParticipant,
    isHost,
    setView,
  } = useCall();
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const duration = useDuration(connectedAt);
  const [focusId, setFocusId] = useState<string | null>(null);
  const selfFocus = "__self__";

  // remoteHasVideo now comes from the provider, which recomputes it from
  // the remote track's live/mute events (FIX C) so the frame doesn't freeze
  // after the peer stops sharing.
  const showVideo = Boolean(call?.video || remoteHasVideo || sharing);
  // More than one remote peer means a grid; a 1:1 keeps the big stage.
  const group = participants.length > 1;
  const columns = Math.min(
    5,
    Math.max(1, Math.ceil(Math.sqrt(participants.length + 1))),
  );
  const focusedPeer =
    focusId && focusId !== selfFocus
      ? (participants.find((p) => p.id === focusId) ?? null)
      : null;
  const focusingSelf = focusId === selfFocus;

  useEffect(() => {
    if (!focusId) return;
    if (focusId === selfFocus) {
      if (!sharing && (camOff || !call?.video)) setFocusId(null);
      return;
    }
    const peer = participants.find((p) => p.id === focusId);
    if (!peer || !peer.hasVideo) setFocusId(null);
  }, [focusId, participants, sharing, camOff, call?.video, selfFocus]);

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

      <div className="relative flex-1 min-h-0 overflow-hidden bg-ink">
        {group ? (
          focusId && (focusingSelf || focusedPeer) ? (
            <div className="flex h-full min-h-0 flex-col gap-2 p-1">
              <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-ink-soft">
                {focusingSelf ? (
                  <SelfPreview
                    stream={localStream}
                    camOff={camOff}
                    sharing={sharing}
                    muted={muted}
                  />
                ) : focusedPeer ? (
                  <ParticipantTile
                    participant={focusedPeer}
                    isHost={isHost}
                    onHostMute={muteParticipant}
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() => setFocusId(null)}
                  className="absolute left-2 top-2 z-10 flex items-center gap-1.5 rounded-full bg-black/65 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-black/80"
                  aria-label="Back to grid view"
                  title="Grid view"
                >
                  <LayoutGrid className="size-3.5" />
                  Grid
                </button>
              </div>
              <div className="flex h-[5.5rem] shrink-0 gap-2 overflow-x-auto">
                {participants.map((p) => (
                  <div key={p.id} className="h-full w-28 shrink-0">
                    <ParticipantTile
                      participant={p}
                      isHost={isHost}
                      onHostMute={muteParticipant}
                      compact
                      selected={p.id === focusId}
                      onSelect={() => setFocusId(p.id)}
                    />
                  </div>
                ))}
                <div className="h-full w-28 shrink-0">
                  <SelfPreview
                    stream={localStream}
                    camOff={camOff}
                    sharing={sharing}
                    muted={muted}
                    compact
                    selected={focusingSelf}
                    onSelect={() => setFocusId(selfFocus)}
                  />
                </div>
              </div>
            </div>
          ) : (
          <div
            className="grid h-full w-full auto-rows-fr gap-1 p-1"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {participants.map((p) => (
              <ParticipantTile
                key={p.id}
                participant={p}
                isHost={isHost}
                onHostMute={muteParticipant}
                onSelect={p.sharing ? () => setFocusId(p.id) : undefined}
              />
            ))}
            <SelfPreview
              stream={localStream}
              camOff={camOff}
              sharing={sharing}
              muted={muted}
              onSelect={sharing ? () => setFocusId(selfFocus) : undefined}
            />
          </div>
          )
        ) : showVideo ? (
          <>
            {/* Muted on purpose: the provider's per-participant <audio>
                elements are the audio sink. Without this the same remote
                track plays twice on video calls. */}
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              muted
              className={`absolute inset-0 h-full w-full bg-ink ${
                sharing ? "object-contain" : "object-cover"
              }`}
            />
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              // Mirror your own camera preview, the way every video app
              // does, so it reads like a mirror instead of "reversed". A
              // shared screen must never be flipped (its text would go
              // backwards), so only the camera is mirrored. The tile is
              // 16:9 to match the capture, so nothing is cropped away.
              className={`absolute bottom-4 right-4 h-24 w-40 rounded-xl border border-white/20 ${
                sharing ? "object-contain bg-ink" : "object-cover -scale-x-100"
              } ${camOff && !sharing ? "opacity-30" : ""}`}
            />
            {muted && (
              <div className="absolute bottom-28 right-5">
                <MuteBadge />
              </div>
            )}
            {participants[0]?.muted && (
              <div className="absolute left-4 top-4">
                <MuteBadge />
              </div>
            )}
            {isHost && participants[0] && !participants[0].muted && (
              <button
                type="button"
                onClick={() => muteParticipant(participants[0].id)}
                className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/80"
                aria-label={`Mute ${participants[0].name}`}
                title={`Mute ${participants[0].name}`}
              >
                <span className="scale-75">
                  <MicOffIcon />
                </span>
              </button>
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
              {participants[0]?.muted && (
                <div className="absolute -bottom-1 -right-1">
                  <MuteBadge />
                </div>
              )}
            </div>
            {isHost && participants[0] && !participants[0].muted && (
              <button
                type="button"
                onClick={() => muteParticipant(participants[0].id)}
                className="mt-2 flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[12px] text-white hover:bg-white/25"
              >
                <span className="scale-75">
                  <MicOffIcon />
                </span>
                Mute {participants[0].name.split(" ")[0]}
              </button>
            )}
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

function videoPreviewStream(stream: MediaStream | null) {
  if (!stream) return null;
  const live = stream
    .getVideoTracks()
    .filter((t) => t.readyState === "live");
  const track = live[live.length - 1] ?? stream.getVideoTracks().at(-1);
  return track ? new MediaStream([track]) : stream;
}

function MuteBadge() {
  return (
    <span
      className="flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white"
      title="Muted"
      aria-label="Muted"
    >
      <span className="scale-75">
        <MicOffIcon />
      </span>
    </span>
  );
}

function SharingBadge() {
  return (
    <span className="absolute left-1 top-1 rounded bg-brand-500/90 px-1.5 py-0.5 text-[10px] font-medium">
      Sharing
    </span>
  );
}

function activateTile(e: React.MouseEvent, onSelect?: () => void) {
  if (!onSelect) return;
  if ((e.target as HTMLElement).closest("button")) return;
  onSelect();
}

function SelfPreview({
  stream,
  camOff,
  sharing,
  muted,
  compact,
  selected,
  onSelect,
}: {
  stream: MediaStream | null;
  camOff: boolean;
  sharing: boolean;
  muted: boolean;
  compact?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const { selfId } = useCall();
  const videoRef = useRef<HTMLVideoElement>(null);
  const showVideo = Boolean(stream && ((!camOff && stream.getVideoTracks().length) || sharing));

  useEffect(() => {
    const el = videoRef.current;
    if (el && stream) {
      el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [stream]);

  return (
    <div
      className={`relative h-full overflow-hidden rounded-lg bg-ink-soft ${
        onSelect ? "cursor-pointer" : ""
      } ${selected ? "ring-2 ring-brand-400" : ""}`}
      onClick={(e) => activateTile(e, onSelect)}
      title={sharing && onSelect && !compact ? "Expand screen share" : undefined}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`h-full w-full object-contain bg-ink ${
          sharing ? "" : "-scale-x-100"
        } ${camOff && !sharing ? "opacity-30" : ""}`}
      />
      {(!showVideo || (camOff && !sharing)) && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Avatar name="You" size={compact ? "sm" : "lg"} userId={selfId} />
        </div>
      )}
      <span className="absolute bottom-1 left-1 rounded bg-black/50 px-1.5 py-0.5 text-[11px] text-white">
        You
      </span>
      {muted && (
        <div className="absolute bottom-1 right-1">
          <MuteBadge />
        </div>
      )}
      {sharing && <SharingBadge />}
    </div>
  );
}

function ParticipantTile({
  participant,
  isHost,
  onHostMute,
  compact,
  selected,
  onSelect,
}: {
  participant: Participant;
  isHost: boolean;
  onHostMute: (peerId: string) => void;
  compact?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = videoPreviewStream(participant.stream);
    if (participant.stream) void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [participant.stream]);

  return (
    <div
      className={`relative h-full overflow-hidden rounded-lg bg-ink-soft ${
        onSelect ? "cursor-pointer" : ""
      } ${selected ? "ring-2 ring-brand-400" : ""}`}
      onClick={(e) => activateTile(e, onSelect)}
      title={
        participant.sharing && onSelect && !compact
          ? "Expand screen share"
          : undefined
      }
    >
      {/* Always mounted so a screen-share track can decode even while
          browsers report it muted until the first frame. Avatar sits on
          top until hasVideo is true. Audio plays through the provider. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`h-full w-full object-contain bg-ink ${
          participant.hasVideo ? "opacity-100" : "opacity-0"
        }`}
      />
      {!participant.hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Avatar
            name={participant.name}
            size={compact ? "sm" : "lg"}
            userId={participant.id}
          />
        </div>
      )}
      <span className="absolute bottom-1 left-1 max-w-[70%] truncate rounded bg-black/50 px-1.5 py-0.5 text-[11px] text-white">
        {participant.name}
        {!participant.connected && " · connecting…"}
      </span>
      {participant.sharing && <SharingBadge />}
      {participant.muted && (
        <div className="absolute bottom-1 right-1">
          <MuteBadge />
        </div>
      )}
      {isHost && !participant.muted && !compact && (
        <button
          type="button"
          onClick={() => onHostMute(participant.id)}
          className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/80"
          aria-label={`Mute ${participant.name}`}
          title={`Mute ${participant.name}`}
        >
          <span className="scale-75">
            <MicOffIcon />
          </span>
        </button>
      )}
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

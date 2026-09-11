"use client";

import { useEffect, useRef } from "react";
import { Avatar } from "@/components/Avatar";
import { useCall, type GroupParticipant } from "@/components/call/CallProvider";

/**
 * GROUP CALLS: a responsive grid of remote participant tiles plus the local
 * self-view. One <video> per remote stream (unmuted — this is where each
 * peer's audio plays, since the group path has no single audio sink), with an
 * Avatar fallback when their camera/screen is off. Kept deliberately simple:
 * a CSS grid that reflows from 1 to 6+ tiles.
 */
export function CallGrid() {
  const { groupPeers, localStream, camOff, sharing, call } = useCall();

  const total = groupPeers.length + 1; // + self
  // Square-ish layout: 2 cols for a pair, 3 for six, 4 for twelve, and so on.
  // The old fixed 3 columns turned a 20-person call into 7 rows of slivers.
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(total))));
  // Past a roomful, tiles get a floor and the grid scrolls instead of
  // shrinking every tile into nothing.
  const dense = total > 12;
  // Never crop a shared screen. Cameras are letterboxed rather than
  // cropped — filling the tile zooms into the middle of the frame.
  const remoteFit = "object-contain";

  return (
    <div
      className={`grid h-full w-full gap-2 p-2 sm:gap-3 sm:p-3 ${
        dense ? "content-start overflow-y-auto" : "content-center"
      }`}
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridAutoRows: dense ? "minmax(120px, 1fr)" : undefined,
      }}
    >
      {groupPeers.map((peer) => (
        <RemoteTile key={peer.id} peer={peer} fitClass={remoteFit} />
      ))}
      <SelfTile
        stream={localStream}
        camOff={camOff}
        sharing={sharing}
        video={Boolean(call?.video)}
      />
    </div>
  );
}

/**
 * GROUP CALLS: persistent, always-mounted audio sinks — one per remote peer.
 * Rendered by the provider (never inside FullScreenCall/FloatingCallTile) so
 * call audio keeps playing across minimize/expand and page navigation, exactly
 * like the 1:1 hidden <audio>. The grid's own <video> tiles are muted.
 */
export function PeerAudioSinks() {
  const { groupPeers } = useCall();
  return (
    <>
      {groupPeers.map((p) => (
        <PeerAudio key={p.id} stream={p.stream} />
      ))}
    </>
  );
}

function PeerAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [stream]);
  return <audio ref={ref} autoPlay className="hidden" />;
}

function RemoteTile({
  peer,
  fitClass,
}: {
  peer: GroupParticipant;
  fitClass: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el && peer.stream) {
      el.srcObject = peer.stream;
      void el.play().catch(() => undefined);
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [peer.stream]);

  return (
    <div className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-xl bg-ink-soft">
      {/* Muted: audio for each peer plays through the persistent PeerAudioSinks
          in the provider, so it survives minimize (the grid unmounts when the
          call is minimized). This mirrors the 1:1 single-audio-sink design. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`h-full w-full bg-ink ${fitClass} ${peer.hasVideo ? "" : "opacity-0"}`}
      />
      {!peer.hasVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Avatar name={peer.name} size="lg" />
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 max-w-[85%] truncate rounded bg-black/50 px-1.5 py-0.5 text-[11px] font-medium text-white">
        {peer.name}
      </span>
    </div>
  );
}

function SelfTile({
  stream,
  camOff,
  sharing,
  video,
}: {
  stream: MediaStream | null;
  camOff: boolean;
  sharing: boolean;
  video: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const showVideo = (video && !camOff) || sharing;

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
    <div className="relative flex min-h-0 items-center justify-center overflow-hidden rounded-xl bg-ink-soft ring-1 ring-white/15">
      {/* Muted: never play our own audio back to us. Mirror the camera the way
          every video app does, but never a shared screen (its text would flip). */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`h-full w-full bg-ink object-contain ${
          sharing ? "" : "-scale-x-100"
        } ${showVideo ? "" : "opacity-0"}`}
      />
      {!showVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Avatar name="You" size="lg" />
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 rounded bg-black/50 px-1.5 py-0.5 text-[11px] font-medium text-white">
        You
      </span>
    </div>
  );
}

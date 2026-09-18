"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGrid } from "lucide-react";
import { Avatar } from "@/components/Avatar";
import { useCall, type GroupParticipant } from "@/components/call/CallProvider";
import { MicOffIcon } from "@/components/icons";

const SELF_FOCUS = "__self__";

/**
 * GROUP CALLS: a responsive grid of remote participant tiles plus the local
 * self-view. A screen share someone starts opens in a large focus stage by
 * itself (text is unreadable in a grid tile); a filmstrip + Grid control
 * switch views without stopping the share.
 */
export function CallGrid() {
  const { groupPeers, localStream, camOff, sharing, call, muted, setGroupLayout } =
    useCall();
  const [focusId, setFocusId] = useState<string | null>(null);

  // Open a share as soon as it starts — once per share, so choosing "Grid"
  // sticks, and never over a share the viewer is already watching.
  const sharingSeen = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(groupPeers.filter((p) => p.sharing).map((p) => p.id));
    const started = [...now].find((id) => !sharingSeen.current.has(id));
    sharingSeen.current = now;
    if (started) setFocusId((current) => current ?? started);
  }, [groupPeers]);

  // Tiles scrolled out of view (a 40-person grid, the filmstrip) fetch no
  // video at all. Unknown counts as visible, so nothing blinks out on mount.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const reportVisibility = useCallback((id: string, visible: boolean) => {
    setHidden((prev) => {
      if (prev.has(id) === !visible) return prev;
      const next = new Set(prev);
      if (visible) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Every video is fetched at the size it is shown (see planGroupVideo).
  useEffect(() => {
    const hiddenIds = [...hidden];
    setGroupLayout(
      focusId
        ? {
            layout: "focus",
            focusId: focusId === SELF_FOCUS ? null : focusId,
            hidden: hiddenIds,
          }
        : { layout: "grid", hidden: hiddenIds },
    );
  }, [focusId, hidden, setGroupLayout]);

  const focusedPeer =
    focusId && focusId !== SELF_FOCUS
      ? (groupPeers.find((p) => p.id === focusId) ?? null)
      : null;
  const focusingSelf = focusId === SELF_FOCUS;

  // The focus stage is for screen shares: back to the grid when it ends.
  useEffect(() => {
    if (!focusId) return;
    if (focusId === SELF_FOCUS) {
      if (!sharing) setFocusId(null);
      return;
    }
    const peer = groupPeers.find((p) => p.id === focusId);
    if (!peer || !peer.hasVideo || !peer.sharing) setFocusId(null);
  }, [focusId, groupPeers, sharing]);

  const total = groupPeers.length + 1;
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(total))));
  const dense = total > 12;
  const remoteFit = "object-contain";

  if (focusId && (focusingSelf || focusedPeer)) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-2 sm:p-3">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl bg-ink">
          {focusingSelf ? (
            <SelfTile
              stream={localStream}
              camOff={camOff}
              sharing={sharing}
              video={Boolean(call?.video)}
              muted={muted}
            />
          ) : focusedPeer ? (
            <RemoteTile peer={focusedPeer} fitClass={remoteFit} />
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
        <div className="flex h-[5.5rem] shrink-0 gap-2 overflow-x-auto pb-0.5">
          {groupPeers.map((peer) => (
            <div key={peer.id} className="h-full w-28 shrink-0">
              <RemoteTile
                peer={peer}
                fitClass={remoteFit}
                compact
                selected={peer.id === focusId}
                onSelect={() => setFocusId(peer.id)}
                onVisibility={reportVisibility}
              />
            </div>
          ))}
          <div className="h-full w-28 shrink-0">
            <SelfTile
              stream={localStream}
              camOff={camOff}
              sharing={sharing}
              video={Boolean(call?.video)}
              muted={muted}
              compact
              selected={focusingSelf}
              onSelect={() => setFocusId(SELF_FOCUS)}
            />
          </div>
        </div>
      </div>
    );
  }

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
        <RemoteTile
          key={peer.id}
          peer={peer}
          fitClass={remoteFit}
          onSelect={peer.sharing ? () => setFocusId(peer.id) : undefined}
          onVisibility={reportVisibility}
        />
      ))}
      <SelfTile
        stream={localStream}
        camOff={camOff}
        sharing={sharing}
        video={Boolean(call?.video)}
        muted={muted}
        onSelect={sharing ? () => setFocusId(SELF_FOCUS) : undefined}
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

function activateTile(e: React.MouseEvent, onSelect?: () => void) {
  if (!onSelect) return;
  if ((e.target as HTMLElement).closest("button")) return;
  onSelect();
}

function RemoteTile({
  peer,
  fitClass,
  compact,
  selected,
  onSelect,
  onVisibility,
}: {
  peer: GroupParticipant;
  fitClass: string;
  compact?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  /** Report whether this tile is on screen (it may be scrolled away). */
  onVisibility?: (id: string, visible: boolean) => void;
}) {
  const { canManageCall, muteParticipant } = useCall();
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);

  const peerId = peer.id;
  useEffect(() => {
    const el = tileRef.current;
    if (!el || !onVisibility || typeof IntersectionObserver === "undefined") return;
    // A small margin fetches a tile just before it scrolls into view.
    const io = new IntersectionObserver(
      ([entry]) => onVisibility(peerId, entry.isIntersecting),
      { rootMargin: "120px" },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      onVisibility(peerId, true); // forget it; a remounted tile reports again
    };
  }, [peerId, onVisibility]);

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
    <div
      ref={tileRef}
      className={`relative flex h-full min-h-0 items-center justify-center overflow-hidden rounded-xl bg-ink-soft ${
        onSelect ? "cursor-pointer" : ""
      } ${selected ? "ring-2 ring-brand-400" : ""}`}
      onClick={(e) => activateTile(e, onSelect)}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
      title={
        peer.sharing && onSelect && !compact
          ? "Expand screen share"
          : undefined
      }
    >
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
          <Avatar name={peer.name} size={compact ? "sm" : "lg"} userId={peer.id} />
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 max-w-[70%] truncate rounded bg-black/50 px-1.5 py-0.5 text-[11px] font-medium text-white">
        {peer.name}
      </span>
      {peer.sharing && (
        <span className="absolute left-1.5 top-1.5 rounded bg-brand-500/90 px-1.5 py-0.5 text-[10px] font-medium">
          Sharing
        </span>
      )}
      {peer.muted && (
        <div className="absolute bottom-1.5 right-1.5">
          <MuteBadge />
        </div>
      )}
      {canManageCall && !peer.muted && !compact && (
        <button
          type="button"
          onClick={() => void muteParticipant(peer.id)}
          className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/80"
          aria-label={`Mute ${peer.name}`}
          title={`Mute ${peer.name}`}
        >
          <span className="scale-75">
            <MicOffIcon />
          </span>
        </button>
      )}
    </div>
  );
}

function SelfTile({
  stream,
  camOff,
  sharing,
  video,
  muted,
  compact,
  selected,
  onSelect,
}: {
  stream: MediaStream | null;
  camOff: boolean;
  sharing: boolean;
  video: boolean;
  muted: boolean;
  compact?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const { selfId } = useCall();
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
    <div
      className={`relative flex h-full min-h-0 items-center justify-center overflow-hidden rounded-xl bg-ink-soft ring-1 ring-white/15 ${
        onSelect ? "cursor-pointer" : ""
      } ${selected ? "ring-2 ring-brand-400" : ""}`}
      onClick={(e) => activateTile(e, onSelect)}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect();
              }
            }
          : undefined
      }
      title={sharing && onSelect && !compact ? "Expand screen share" : undefined}
    >
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
          <Avatar name="You" size={compact ? "sm" : "lg"} userId={selfId} />
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 rounded bg-black/50 px-1.5 py-0.5 text-[11px] font-medium text-white">
        You
      </span>
      {sharing && (
        <span className="absolute left-1.5 top-1.5 rounded bg-brand-500/90 px-1.5 py-0.5 text-[10px] font-medium">
          Sharing
        </span>
      )}
      {muted && (
        <div className="absolute bottom-1.5 right-1.5">
          <MuteBadge />
        </div>
      )}
    </div>
  );
}

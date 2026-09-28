"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LayoutGrid, MonitorUp } from "lucide-react";
import { shareDecodeBudget } from "@/lib/call/screen-share";
import { Avatar } from "@/components/Avatar";
import { useCall, type GroupParticipant } from "@/components/call/CallProvider";
import { MicOffIcon } from "@/components/icons";

const SELF_FOCUS = "__self__";
/** Focus value for the wall of every shared screen. */
const SCREENS = "__screens__";

/**
 * GROUP CALLS: a responsive grid of remote participant tiles plus the local
 * self-view. Any number of people may share their screens at once:
 * - the first share opens in a large focus stage by itself (text is
 *   unreadable in a grid tile) — later ones never pull the viewer away;
 * - with two or more, "All screens" puts them side by side;
 * - clicking any shared screen enlarges it; a filmstrip + Grid control switch
 *   views without stopping anyone's share;
 * - an enlarged screen fills the whole call window, and its view buttons and
 *   filmstrip float over it only while the call controls show (`chrome`);
 * - a device plays only as many screens at once as it can decode
 *   (shareDecodeBudget); the rest show who is sharing until clicked.
 */
export function CallGrid({
  chrome = true,
  onStageChange,
}: {
  /** Whether the call's controls are showing right now. */
  chrome?: boolean;
  /** Reports whether a screen fills the stage, so FullScreenCall can float
   *  its bars over it. */
  onStageChange?: (onStage: boolean) => void;
} = {}) {
  const { groupPeers, localStream, camOff, sharing, call, muted, setGroupLayout } =
    useCall();
  const [focusId, setFocusId] = useState<string | null>(null);

  // Shared screens first — in the grid and the filmstrip — so a share is
  // never scrolled out of sight; otherwise the call's own order.
  const ordered = useMemo(
    () => [
      ...groupPeers.filter((p) => p.sharing),
      ...groupPeers.filter((p) => !p.sharing),
    ],
    [groupPeers],
  );
  const sharers = useMemo(() => ordered.filter((p) => p.sharing), [ordered]);

  // Open a share by itself only when screen sharing BEGINS (none was on).
  // With concurrent shares, a viewer who is watching one share — or chose
  // the grid — is not pulled away each time someone else starts.
  const sharingSeen = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(sharers.map((p) => p.id));
    const hadAny = sharingSeen.current.size > 0;
    const started = [...now].find((id) => !sharingSeen.current.has(id));
    sharingSeen.current = now;
    if (started && !hadAny) setFocusId((current) => current ?? started);
  }, [sharers]);

  // Tiles scrolled out of view (a 40-person grid, the filmstrip, a big screen
  // wall) fetch no video at all. Unknown counts as visible, so nothing blinks
  // out on mount.
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

  // Screens this device can decode at once; any more wait for a click.
  const [maxLive, setMaxLive] = useState(2);
  useEffect(() => {
    let live = true;
    void shareDecodeBudget().then((n) => live && setMaxLive(n));
    return () => {
      live = false;
    };
  }, []);
  // Grid and wall only: on the stage nothing else plays (planGroupVideo).
  const paused = useMemo(() => {
    const out = new Set<string>();
    if (focusId && focusId !== SCREENS) return out;
    let playing = 0;
    for (const peer of sharers) {
      if (hidden.has(peer.id)) continue;
      if (playing < maxLive) playing++;
      else out.add(peer.id);
    }
    return out;
  }, [focusId, sharers, hidden, maxLive]);

  // Every video is fetched at the size it is shown (see planGroupVideo).
  useEffect(() => {
    const hiddenIds = [...hidden, ...paused];
    setGroupLayout(
      focusId === SCREENS
        ? { layout: "screens", hidden: hiddenIds }
        : focusId
          ? {
              layout: "focus",
              focusId: focusId === SELF_FOCUS ? null : focusId,
              hidden: hiddenIds,
            }
          : { layout: "grid", hidden: hiddenIds },
    );
  }, [focusId, hidden, paused, setGroupLayout]);

  // Views exist for shares: when the one on screen ends, move to another
  // share that is still running, else back to the grid.
  useEffect(() => {
    if (!focusId) return;
    if (focusId === SCREENS) {
      if (sharers.length < 2) setFocusId(sharers[0]?.id ?? null);
      return;
    }
    if (focusId === SELF_FOCUS) {
      if (!sharing) setFocusId(sharers[0]?.id ?? null);
      return;
    }
    const peer = groupPeers.find((p) => p.id === focusId);
    if (!peer || !peer.hasVideo || !peer.sharing) {
      setFocusId(sharers.find((p) => p.id !== focusId)?.id ?? null);
    }
  }, [focusId, groupPeers, sharers, sharing]);

  const focusedPeer =
    focusId && focusId !== SELF_FOCUS && focusId !== SCREENS
      ? (groupPeers.find((p) => p.id === focusId) ?? null)
      : null;
  const focusingSelf = focusId === SELF_FOCUS;
  const onStage = Boolean(focusId && (focusingSelf || focusedPeer));
  useEffect(() => {
    onStageChange?.(onStage);
  }, [onStage, onStageChange]);
  useEffect(() => () => onStageChange?.(false), [onStageChange]);
  const remoteFit = "object-contain";
  const allScreens =
    sharers.length >= 2 ? (
      <ViewButton
        onClick={() => setFocusId(SCREENS)}
        label={`All screens (${sharers.length})`}
        icon={<MonitorUp className="size-3.5" />}
      />
    ) : null;

  // ── Every shared screen side by side ────────────────────────────────
  if (focusId === SCREENS && sharers.length >= 2) {
    const n = sharers.length;
    const wallCols = Math.min(4, Math.ceil(Math.sqrt(n)));
    const wallRows = Math.ceil(n / wallCols);
    const wallDense = n > 12;
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-2 sm:p-3">
        <div className="flex shrink-0 items-center gap-2">
          <ViewButton
            onClick={() => setFocusId(null)}
            label="Grid"
            icon={<LayoutGrid className="size-3.5" />}
          />
          <span className="text-[12px] text-white/60">
            {n} screens shared · click one to enlarge it
          </span>
        </div>
        <div
          className={`grid min-h-0 flex-1 gap-2 ${
            wallDense ? "content-start overflow-y-auto" : ""
          }`}
          style={{
            gridTemplateColumns: `repeat(${wallCols}, minmax(0, 1fr))`,
            ...(wallDense
              ? { gridAutoRows: "minmax(160px, 1fr)" }
              : { gridTemplateRows: `repeat(${wallRows}, minmax(0, 1fr))` }),
          }}
        >
          {sharers.map((peer) => (
            <RemoteTile
              key={peer.id}
              peer={peer}
              fitClass={remoteFit}
              paused={paused.has(peer.id)}
              onSelect={() => setFocusId(peer.id)}
              onVisibility={reportVisibility}
            />
          ))}
        </div>
      </div>
    );
  }

  // ── One share (or your own) large, everyone in a filmstrip ─────────
  // The screen takes the whole call window; the view buttons and the
  // filmstrip float over it and fade out with the call controls.
  if (onStage) {
    const fade = `transition-opacity duration-300 ${
      chrome ? "opacity-100" : "pointer-events-none opacity-0"
    }`;
    return (
      <div className="relative h-full min-h-0 bg-ink">
        {focusingSelf ? (
          <SelfTile
            stream={localStream}
            camOff={camOff}
            sharing={sharing}
            video={Boolean(call?.video)}
            muted={muted}
            stage
          />
        ) : focusedPeer ? (
          <RemoteTile peer={focusedPeer} fitClass={remoteFit} stage />
        ) : null}
        <div
          className={`absolute left-3 top-[calc(max(1rem,env(safe-area-inset-top))+3.75rem)] z-10 flex gap-2 ${fade}`}
        >
          <ViewButton
            onClick={() => setFocusId(null)}
            label="Grid"
            icon={<LayoutGrid className="size-3.5" />}
          />
          {allScreens}
          <span className="flex items-center rounded-full bg-black/65 px-3 py-1.5 text-[12px] font-medium text-white">
            {focusingSelf ? "Your screen" : `Screen · ${focusedPeer?.name ?? ""}`}
          </span>
        </div>
        <div
          className={`absolute inset-x-0 bottom-[calc(max(1.5rem,env(safe-area-inset-bottom))+6.75rem)] z-10 flex h-[5.5rem] gap-2 overflow-x-auto px-3 pb-0.5 ${fade}`}
        >
          {ordered.map((peer) => (
            <div key={peer.id} className="h-full w-28 shrink-0">
              <RemoteTile
                peer={peer}
                fitClass={remoteFit}
                compact
                // The stage already shows the selected screen; any other
                // screen is paused here (planGroupVideo), so say so.
                paused={peer.sharing && peer.id !== focusId}
                selected={peer.id === focusId}
                onSelect={peer.sharing ? () => setFocusId(peer.id) : undefined}
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
              onSelect={sharing ? () => setFocusId(SELF_FOCUS) : undefined}
            />
          </div>
        </div>
      </div>
    );
  }

  // ── Everyone ───────────────────────────────────────────────────────
  const total = groupPeers.length + 1;
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(total))));
  const dense = total > 12;
  return (
    <div className="relative h-full w-full">
      {allScreens && (
        <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2">
          {allScreens}
        </div>
      )}
      <div
        className={`grid h-full w-full gap-2 p-2 sm:gap-3 sm:p-3 ${
          dense ? "content-start overflow-y-auto" : "content-center"
        } ${allScreens ? "pt-12 sm:pt-12" : ""}`}
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridAutoRows: dense ? "minmax(120px, 1fr)" : undefined,
        }}
      >
        {ordered.map((peer) => (
          <RemoteTile
            key={peer.id}
            peer={peer}
            fitClass={remoteFit}
            paused={paused.has(peer.id)}
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
    </div>
  );
}

/** The dark pill buttons that switch call views. */
function ViewButton({
  onClick,
  label,
  icon,
}: {
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-full bg-black/65 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-black/80"
    >
      {icon}
      {label}
    </button>
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
  stage,
  paused,
  selected,
  onSelect,
  onVisibility,
}: {
  peer: GroupParticipant;
  fitClass: string;
  compact?: boolean;
  /** A screen this viewer is not fetching: show who is sharing instead. */
  paused?: boolean;
  /** The big focus stage: the view buttons sit where the badge would. */
  stage?: boolean;
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

  const showVideo = peer.hasVideo && !paused;
  return (
    <div
      ref={tileRef}
      className={`relative flex h-full min-h-0 items-center justify-center overflow-hidden bg-ink-soft ${
        stage ? "" : "rounded-xl"
      } ${
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
        className={`h-full w-full bg-ink ${fitClass} ${showVideo ? "" : "opacity-0"}`}
      />
      {!showVideo && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <Avatar name={peer.name} size={compact ? "sm" : "lg"} userId={peer.id} />
          {paused && !compact && (
            <span className="flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1 text-[12px] font-medium text-white">
              <MonitorUp className="size-3.5" />
              Click to watch
            </span>
          )}
        </div>
      )}
      {/* On the stage the name rides with the view buttons, which fade. */}
      {!stage && (
        <span className="absolute bottom-1.5 left-1.5 max-w-[70%] truncate rounded bg-black/50 px-1.5 py-0.5 text-[11px] font-medium text-white">
          {peer.name}
        </span>
      )}
      {peer.sharing && !stage && (
        <span className="absolute left-1.5 top-1.5 rounded bg-brand-600/90 px-1.5 py-0.5 text-[10px] font-medium">
          Sharing
        </span>
      )}
      {peer.muted && !stage && (
        <div className="absolute bottom-1.5 right-1.5">
          <MuteBadge />
        </div>
      )}
      {canManageCall && !peer.muted && !compact && !stage && (
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
  stage,
  selected,
  onSelect,
}: {
  stream: MediaStream | null;
  camOff: boolean;
  sharing: boolean;
  video: boolean;
  muted: boolean;
  compact?: boolean;
  /** Fills the call window: no rounded corners or ring. */
  stage?: boolean;
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
      className={`relative flex h-full min-h-0 items-center justify-center overflow-hidden bg-ink-soft ${
        stage ? "" : "rounded-xl ring-1 ring-white/15"
      } ${
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
      {!stage && (
        <span className="absolute bottom-1.5 left-1.5 rounded bg-black/50 px-1.5 py-0.5 text-[11px] font-medium text-white">
          You
        </span>
      )}
      {sharing && !stage && (
        <span className="absolute left-1.5 top-1.5 rounded bg-brand-600/90 px-1.5 py-0.5 text-[10px] font-medium">
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

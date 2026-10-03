"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/** Where this browser last left the tile — a per-viewer convenience. */
const POS_KEY = "icc.callTilePos";
const EDGE = 8;
type Pos = { x: number; y: number };

/**
 * Minimized in-call tile. Floats over every page so the chat stays
 * usable during a call; tapping the video (or expand) goes full screen.
 * Drag it (by the picture or the name) to put it anywhere; it stays on
 * screen and is remembered for the next call.
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
    canShareScreen,
    recording,
    recorders,
    setView,
  } = useCall();
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const groupVideoRef = useRef<HTMLVideoElement>(null);
  const duration = useDuration(connectedAt);

  // ── Dragging ───────────────────────────────────────────────────────
  const tileRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const drag = useRef<{ id: number; px: number; py: number; x: number; y: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const clamp = useCallback((x: number, y: number): Pos => {
    const el = tileRef.current;
    const w = el?.offsetWidth ?? 256;
    const h = el?.offsetHeight ?? 210;
    return {
      x: Math.round(Math.min(Math.max(EDGE, x), window.innerWidth - w - EDGE)),
      y: Math.round(Math.min(Math.max(EDGE, y), window.innerHeight - h - EDGE)),
    };
  }, []);
  const hasCall = Boolean(call);
  useEffect(() => {
    if (!hasCall) return;
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) ?? "null") as Pos | null;
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        setPos(clamp(saved.x, saved.y));
      }
    } catch {
      /* storage unavailable: the default corner */
    }
    const onResize = () => setPos((p) => (p ? clamp(p.x, p.y) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [hasCall, clamp]);

  // Press on a handle, then follow the pointer on the whole window until it
  // is released: a quick flick leaves the tile before the drag starts, and
  // the tile would never see the rest of it. (Capturing the pointer on the
  // tile instead would retarget the click, and "expand" would stop working.)
  const onPointerDown = (e: React.PointerEvent) => {
    // One drag at a time (a second finger would orphan the first's listeners).
    if (e.button !== 0 || drag.current) return;
    swallowClick.current = false;
    // The call controls stay buttons; the picture (expand) and the name
    // strip are handles.
    const btn = (e.target as HTMLElement).closest("button");
    if (btn && !btn.hasAttribute("data-drag-handle")) return;
    const r = tileRef.current?.getBoundingClientRect();
    if (!r) return;
    drag.current = { id: e.pointerId, px: e.clientX, py: e.clientY, x: r.left, y: r.top, moved: false };
    const move = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== ev.pointerId) return;
      const dx = ev.clientX - d.px;
      const dy = ev.clientY - d.py;
      if (!d.moved) {
        if (Math.hypot(dx, dy) < 6) return; // still a tap
        d.moved = true;
      }
      ev.preventDefault(); // no text selection while dragging
      setPos(clamp(d.x + dx, d.y + dy));
    };
    const end = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || d.id !== ev.pointerId) return;
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (!d.moved) return;
      swallowClick.current = true; // the click that ends a drag isn't "expand"
      const box = tileRef.current?.getBoundingClientRect();
      if (box) {
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ x: box.left, y: box.top }));
        } catch {
          /* not remembered, still moved */
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

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
  // Never crop the remote picture: during a video call the peer may be
  // sharing their screen, and this side can't tell a screen from a camera.
  // A 16:9 camera in this tile only gets hairline bars.
  const fitClass = "object-contain";

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
    <div
      ref={tileRef}
      onPointerDown={onPointerDown}
      onClickCapture={(e) => {
        if (swallowClick.current) {
          swallowClick.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      style={pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : undefined}
      className="fixed right-3 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-[115] w-60 touch-none select-none overflow-hidden rounded-xl bg-ink text-white shadow-lift ring-1 ring-white/10 sm:right-4 sm:bottom-4 sm:w-64"
    >
      <button
        type="button"
        data-drag-handle
        onClick={() => setView("full")}
        className="relative block h-36 w-full cursor-grab bg-ink-soft text-left active:cursor-grabbing"
        aria-label="Expand call to full screen"
        title="Click to expand · drag to move"
      >
        {(recording || recorders.length > 0) && (
          <span
            className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded-full bg-red-500/90 px-2 py-0.5 text-[10px] font-semibold text-white"
            title="This call is being recorded"
          >
            <span className="size-1.5 rounded-full bg-white" />
            REC
          </span>
        )}
        {isGroup ? (
          <>
            {/* Muted: audio plays through the provider's per-peer sinks. */}
            <video
              ref={groupVideoRef}
              autoPlay
              playsInline
              muted
              className={`h-full w-full bg-ink ${
                groupFirst?.sharing ? "object-contain" : "object-cover"
              } ${groupFirst?.hasVideo ? "" : "opacity-0"}`}
            />
            {(!groupFirst || !groupFirst.hasVideo) && (
              <div className="absolute inset-0 flex items-center justify-center">
                <Avatar
                  name={groupFirst?.name ?? call.peerName}
                  size="md"
                  userId={groupFirst?.id ?? call.peerId}
                  className="relative"
                />
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
              <Avatar
                name={call.peerName}
                size="md"
                userId={call.peerId}
                className="relative"
              />
            </div>
          </div>
        )}
        <span className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/40">
          <ExpandIcon />
        </span>
        {sharing && (
          <span className="absolute left-2 top-2 rounded bg-brand-600/90 px-1.5 py-0.5 text-[10px] font-medium">
            Sharing
          </span>
        )}
        {muted && (
          <span
            className="absolute bottom-2 left-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white"
            title="Muted"
            aria-label="Muted"
          >
            <span className="scale-75">
              <MicOffIcon />
            </span>
          </span>
        )}
      </button>

      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1 cursor-grab active:cursor-grabbing" title="Drag to move">
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
        {phase === "in-call" && (canShareScreen || sharing) && (
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

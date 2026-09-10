"use client";

/**
 * App-level call engine. Mounted once in the (app) layout so incoming
 * calls ring on every page and an active call survives navigation.
 *
 * Signaling rides the call_signals table (insert + postgres_changes),
 * same reliability path as chat. One global channel per user with two
 * bindings:
 *   to_user   = me — signals addressed to me
 *   from_user = me — my own answer/decline from ANOTHER tab, so this
 *                    tab stops ringing when a second tab handles a call
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { ensureRealtimeAuth } from "@/lib/supabase/realtime";
import { iceServers, waitForIceGathering } from "@/lib/call/webrtc";
import {
  installAutoResume,
  startRingback,
  startRingtone,
  stopTones,
} from "@/lib/call/tones";
import { IncomingCallOverlay } from "@/components/call/IncomingCallOverlay";
import { FloatingCallTile } from "@/components/call/FloatingCallTile";
import { FullScreenCall } from "@/components/call/FullScreenCall";
import { postCallEvent } from "@/app/actions/rooms";
import { showDesktopNotification } from "@/lib/notifications";

/** Answered but never connected — give up instead of hanging forever. */
const CONNECT_TIMEOUT_MS = 25_000;
/** A "disconnected" ICE state this long counts as a dropped call. */
const DROP_GRACE_MS = 12_000;
const RING_TIMEOUT_MS = 30_000;
/** Callee gives the caller's timeout a grace window before going quiet. */
const RING_TIMEOUT_CALLEE_MS = 35_000;
const STALE_INVITE_MS = 45_000;
const RESEND_MS = 3_000;

type SignalKind = "invite" | "offer" | "answer" | "ice" | "hangup" | "decline";

type SignalPayload = {
  fromName?: string;
  roomName?: string;
  video?: boolean;
  reason?: "busy" | "timeout" | "media";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type SignalRow = {
  room_id: string;
  call_id: string;
  from_user: string;
  to_user: string;
  kind: SignalKind;
  payload: SignalPayload | null;
  created_at: string;
};

export type CallPhase = "idle" | "dialing" | "ringing" | "connecting" | "in-call";

export type ActiveCall = {
  callId: string;
  roomId: string;
  peerId: string;
  peerName: string;
  video: boolean;
};

export type IncomingCall = ActiveCall & { roomName: string | null };

type CallContextValue = {
  phase: CallPhase;
  call: ActiveCall | null;
  incoming: IncomingCall | null;
  view: "full" | "mini";
  muted: boolean;
  camOff: boolean;
  noiseOff: boolean;
  sharing: boolean;
  statusText: string;
  signalReady: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  remoteHasVideo: boolean;
  connectedAt: number | null;
  dial: (
    roomId: string,
    roomName: string,
    peer: { id: string; full_name: string },
    video: boolean,
  ) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => void;
  hangup: () => void;
  toggleMic: () => void;
  toggleCam: () => void;
  toggleNoise: () => void;
  toggleScreenShare: () => Promise<void>;
  setView: (v: "full" | "mini") => void;
};

const CallContext = createContext<CallContextValue | null>(null);

export function useCall() {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error("useCall must be used inside CallProvider");
  return ctx;
}

/** Maps a getUserMedia/getDisplayMedia failure to a message worth showing a user. */
function mediaErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Camera/microphone permission was blocked. Allow access in your browser, then try again.";
      case "NotFoundError":
        return "No microphone or camera was found.";
      case "NotReadableError":
        return "Your camera or microphone is already in use by another app.";
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return "Could not access your microphone or camera.";
}

/** True when an error came from failing to acquire the mic/camera. */
function isMediaError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return [
      "NotAllowedError",
      "SecurityError",
      "NotFoundError",
      "NotReadableError",
      "OverconstrainedError",
      "AbortError",
    ].includes(err.name);
  }
  if (err instanceof Error) {
    return (
      err.message === "Calls need HTTPS." ||
      err.message === "This browser cannot access mic/camera."
    );
  }
  return false;
}

export function CallProvider({
  userId,
  userName,
  children,
}: {
  userId: string;
  userName: string;
  children: React.ReactNode;
}) {
  const supabase = useMemo(() => createClient(), []);

  const [phase, setPhase] = useState<CallPhase>("idle");
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [incoming, setIncoming] = useState<IncomingCall | null>(null);
  const [view, setView] = useState<"full" | "mini">("full");
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [noiseOff, setNoiseOff] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [signalReady, setSignalReady] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  /** True when screen was added as a new sender (voice call); false when replaceTrack. */
  const screenAddedSenderRef = useRef(false);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const callIdRef = useRef<string | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const phaseRef = useRef<CallPhase>("idle");
  const incomingRef = useRef<IncomingCall | null>(null);
  const pendingOfferRef = useRef<{ callId: string; from: string; payload: SignalPayload } | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const acceptedRef = useRef(false);
  const remoteSetRef = useRef(false);
  const answeredCallIdRef = useRef<string | null>(null);
  const resendTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlingRef = useRef<((row: SignalRow) => Promise<void>) | null>(null);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectedAtRef = useRef<number | null>(null);
  /** Set once hangup exists; lets the ICE handler end a dead call. */
  const endCallRef = useRef<(() => void) | null>(null);
  /** Bumped whenever a call begins or is torn down, so stale async aborts. */
  const callGenRef = useRef(0);

  phaseRef.current = phase;
  incomingRef.current = incoming;

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  const clearTimers = useCallback(() => {
    if (resendTimerRef.current) {
      clearInterval(resendTimerRef.current);
      resendTimerRef.current = null;
    }
    if (ringTimerRef.current) {
      clearTimeout(ringTimerRef.current);
      ringTimerRef.current = null;
    }
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
  }, []);

  /**
   * Once the call is answered nothing else was watching the connection:
   * if ICE never completed (blocked relay, dead network) both sides sat on
   * "Connecting…" forever, and a peer that vanished mid-call left the
   * other on a running timer. These end the call instead.
   */
  const armConnectTimeout = useCallback(() => {
    if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
    connectTimerRef.current = setTimeout(() => {
      connectTimerRef.current = null;
      if (connectedAtRef.current) return; // made it through
      showNotice("Couldn't connect — check your network and try again");
      endCallRef.current?.();
    }, CONNECT_TIMEOUT_MS);
  }, [showNotice]);

  /** Ephemeral signaling rows are deleted once their call ends. */
  const purgeSignals = useCallback(
    (callId: string | null) => {
      if (!callId) return;
      void supabase
        .from("call_signals")
        .delete()
        .eq("call_id", callId)
        .then(() => undefined);
    },
    [supabase],
  );

  const cleanup = useCallback(
    (opts?: { purge?: boolean }) => {
      // FIX A: bump the generation so any in-flight async (getMedia/dial/
      // accept/answerOffer/toggleNoise) sees the change and aborts its
      // continuation instead of resurrecting a torn-down call.
      callGenRef.current += 1;
      clearTimers();
      if (dropTimerRef.current) {
        clearTimeout(dropTimerRef.current);
        dropTimerRef.current = null;
      }
      connectedAtRef.current = null;
      stopTones();
      if (opts?.purge) purgeSignals(callIdRef.current);
      pcRef.current?.close();
      pcRef.current = null;
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      cameraTrackRef.current = null;
      screenAddedSenderRef.current = false;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      callIdRef.current = null;
      roomIdRef.current = null;
      peerIdRef.current = null;
      pendingOfferRef.current = null;
      pendingIceRef.current = [];
      acceptedRef.current = false;
      remoteSetRef.current = false;
      answeredCallIdRef.current = null;
      setPhase("idle");
      setCall(null);
      setIncoming(null);
      setView("full");
      setMuted(false);
      setCamOff(false);
      setNoiseOff(false);
      setSharing(false);
      setStatusText("");
      setLocalStream(null);
      setRemoteStream(null);
      setRemoteHasVideo(false);
      setConnectedAt(null);
    },
    [clearTimers, purgeSignals],
  );

  const send = useCallback(
    async (
      kind: SignalKind,
      callId: string,
      to: string,
      roomId: string,
      payload: SignalPayload = {},
    ) => {
      const { error } = await supabase.from("call_signals").insert({
        room_id: roomId,
        call_id: callId,
        from_user: userId,
        to_user: to,
        kind,
        payload,
      });
      if (error) console.warn("call signal insert failed", error.message);
    },
    [supabase, userId],
  );

  const flushIce = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc?.remoteDescription) return;
    const queued = pendingIceRef.current.splice(0);
    for (const c of queued) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* ignore */
      }
    }
  }, []);

  /** Replay ICE rows that arrived before this client was ready. */
  const loadMissedIce = useCallback(
    async (callId: string) => {
      const { data, error } = await supabase
        .from("call_signals")
        .select("payload")
        .eq("call_id", callId)
        .eq("to_user", userId)
        .eq("kind", "ice")
        .order("created_at", { ascending: true });
      if (error || !data) return;
      for (const row of data) {
        const candidate = (row.payload as SignalPayload)?.candidate;
        if (candidate) pendingIceRef.current.push(candidate);
      }
      await flushIce();
    },
    [flushIce, supabase, userId],
  );

  const ensurePc = useCallback(
    (peerId: string) => {
      if (pcRef.current) return pcRef.current;
      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      pc.onicecandidate = (e) => {
        if (!e.candidate || !callIdRef.current || !roomIdRef.current) return;
        void send("ice", callIdRef.current, peerId, roomIdRef.current, {
          candidate: e.candidate.toJSON(),
        });
      };
      pc.ontrack = (e) => {
        const incoming = e.streams[0] ?? new MediaStream([e.track]);
        // Merge newly arrived tracks into one remote stream so voice→screen
        // renegotiation (extra video track) still reaches the UI/audio sink.
        setRemoteStream((prev) => {
          const next = new MediaStream(prev?.getTracks() ?? []);
          for (const t of incoming.getTracks()) {
            if (!next.getTracks().some((x) => x.id === t.id)) next.addTrack(t);
          }
          if (!next.getTracks().some((x) => x.id === e.track.id)) {
            next.addTrack(e.track);
          }
          if (remoteAudioRef.current) {
            remoteAudioRef.current.srcObject = next;
            void remoteAudioRef.current.play().catch(() => undefined);
          }
          return next;
        });
        // FIX C: keep remoteHasVideo honest as the peer's video comes and
        // goes (screen share stop/start, camera off) so the receiver drops
        // back to audio/avatar instead of freezing on the last frame.
        if (e.track.kind === "video") {
          const recompute = () => {
            const active = pcRef.current;
            setRemoteHasVideo(
              Boolean(
                active &&
                  active
                    .getReceivers()
                    .some(
                      (r) =>
                        r.track?.kind === "video" &&
                        r.track.readyState === "live" &&
                        !r.track.muted,
                    ),
              ),
            );
          };
          e.track.addEventListener("ended", recompute);
          e.track.addEventListener("mute", recompute);
          e.track.addEventListener("unmute", recompute);
          incoming.addEventListener("removetrack", recompute);
          recompute();
        }
      };
      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        if (dropTimerRef.current) {
          clearTimeout(dropTimerRef.current);
          dropTimerRef.current = null;
        }
        if (s === "connected" || s === "completed") {
          clearTimers();
          stopTones();
          setPhase("in-call");
          setStatusText("Connected");
          setConnectedAt((prev) => {
            const at = prev ?? Date.now();
            connectedAtRef.current = at;
            return at;
          });
        } else if (s === "checking") {
          setStatusText("Connecting…");
        } else if (s === "disconnected") {
          // Often transient (network switch) — give it a moment to recover.
          setStatusText("Reconnecting…");
          dropTimerRef.current = setTimeout(() => {
            dropTimerRef.current = null;
            if (pcRef.current?.iceConnectionState === "disconnected") {
              showNotice("Call dropped — the connection was lost");
              endCallRef.current?.();
            }
          }, DROP_GRACE_MS);
        } else if (s === "failed" || s === "closed") {
          setStatusText("Connection failed");
          showNotice(
            connectedAtRef.current
              ? "Call dropped — the connection was lost"
              : "Couldn't connect — check your network and try again",
          );
          endCallRef.current?.();
        }
      };
      pcRef.current = pc;
      return pc;
    },
    [clearTimers, send],
  );

  const getMedia = useCallback(async (video: boolean) => {
    // FIX A: capture the generation so a stream that arrives after the call
    // ended is stopped, never stored (this is what kept the webcam light on).
    const gen = callGenRef.current;
    if (!window.isSecureContext && location.hostname !== "localhost") {
      throw new Error("Calls need HTTPS.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot access mic/camera.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: video ? { facingMode: "user" } : false,
    });
    if (callGenRef.current !== gen) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("call ended");
    }
    localStreamRef.current = stream;
    cameraTrackRef.current = stream.getVideoTracks()[0] ?? null;
    setLocalStream(stream);
    return stream;
  }, []);

  /** Answer a mid-call renegotiation offer (e.g. peer started screenshare on a voice call). */
  const answerRenegotiation = useCallback(
    async (sdp: RTCSessionDescriptionInit, from: string, callId: string, roomId: string) => {
      const pc = pcRef.current;
      if (!pc || pc.signalingState !== "stable") return;
      await pc.setRemoteDescription(sdp);
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc);
      const finalAnswer = pc.localDescription ?? answer;
      await send("answer", callId, from, roomId, {
        sdp: { type: finalAnswer.type, sdp: finalAnswer.sdp },
      });
    },
    [flushIce, send],
  );

  const answerOffer = useCallback(
    async (offer: { callId: string; from: string; payload: SignalPayload }) => {
      // FIX A: capture the generation; abort after any await if cleanup ran,
      // so a stale continuation never sends an answer or flips phase after
      // the call already ended.
      const gen = callGenRef.current;
      if (!offer.payload.sdp) return;
      if (answeredCallIdRef.current === offer.callId || remoteSetRef.current) return;
      const pc = ensurePc(offer.from);
      if (pc.currentRemoteDescription || pc.signalingState !== "stable") return;

      const video = Boolean(offer.payload.video);
      if (!localStreamRef.current) await getMedia(video);
      if (callGenRef.current !== gen) return; // FIX A
      const stream = localStreamRef.current!;
      for (const track of stream.getTracks()) {
        if (!pc.getSenders().some((s) => s.track?.id === track.id)) {
          pc.addTrack(track, stream);
        }
      }
      await pc.setRemoteDescription(offer.payload.sdp);
      if (callGenRef.current !== gen) return; // FIX A — do not assign refs
      remoteSetRef.current = true;
      answeredCallIdRef.current = offer.callId;
      await loadMissedIce(offer.callId);
      if (callGenRef.current !== gen) return; // FIX A
      await flushIce();
      if (callGenRef.current !== gen) return; // FIX A
      const answer = await pc.createAnswer();
      if (callGenRef.current !== gen) return; // FIX A
      await pc.setLocalDescription(answer);
      if (callGenRef.current !== gen) return; // FIX A
      await waitForIceGathering(pc);
      if (callGenRef.current !== gen) return; // FIX A
      const finalAnswer = pc.localDescription ?? answer;
      await send("answer", offer.callId, offer.from, roomIdRef.current!, {
        sdp: { type: finalAnswer.type, sdp: finalAnswer.sdp },
      });
      if (callGenRef.current !== gen) return; // FIX A — do not flip phase
      // On a fast network ICE can reach "connected" before this resolves.
      // Without this guard the callee is knocked back to "Connecting…"
      // for the rest of the call — audio flowing, timer never starting.
      if (!connectedAtRef.current) {
        setStatusText("Connecting…");
        setPhase("connecting");
      }
      setIncoming(null);
    },
    [ensurePc, flushIce, getMedia, loadMissedIce, send],
  );

  const handleSignal = useCallback(
    async (row: SignalRow) => {
      // Own rows (from_user = me): only used to stop ringing when
      // another tab of mine answered or declined.
      if (row.from_user === userId) {
        if (
          (row.kind === "answer" || row.kind === "decline") &&
          phaseRef.current === "ringing" &&
          incomingRef.current?.callId === row.call_id &&
          !acceptedRef.current
        ) {
          // FIX E: full cleanup (not a partial reset) so any peer connection
          // or media this tab spun up for the same call can't leak.
          cleanup();
        }
        // Another tab of ours ended the call — this tab must drop too.
        if (
          row.kind === "hangup" &&
          callIdRef.current &&
          callIdRef.current === row.call_id
        ) {
          cleanup();
        }
        return;
      }

      if (row.to_user !== userId) return;
      const p = row.payload ?? {};

      if (row.kind === "invite") {
        if (Date.now() - Date.parse(row.created_at) > STALE_INVITE_MS) return;
        // Busy with a different call → auto-decline.
        if (phaseRef.current !== "idle" && callIdRef.current !== row.call_id) {
          if (incomingRef.current?.callId !== row.call_id) {
            void send("decline", row.call_id, row.from_user, row.room_id, {
              reason: "busy",
            });
          }
          return;
        }
        if (acceptedRef.current || incomingRef.current?.callId === row.call_id) {
          return; // duplicate re-sent invite
        }
        callIdRef.current = row.call_id;
        roomIdRef.current = row.room_id;
        peerIdRef.current = row.from_user;
        setIncoming({
          callId: row.call_id,
          roomId: row.room_id,
          peerId: row.from_user,
          peerName: p.fromName ?? "Unknown caller",
          roomName: p.roomName ?? null,
          video: Boolean(p.video),
        });
        setPhase("ringing");
        startRingtone();
        showDesktopNotification(
          p.video ? "Incoming video call" : "Incoming voice call",
          [p.fromName, p.roomName].filter(Boolean).join(" · ") || "ICC Desk",
          { tag: `call:${row.call_id}` },
        );
        if (ringTimerRef.current) clearTimeout(ringTimerRef.current);
        ringTimerRef.current = setTimeout(() => {
          // Caller times out on its own side; just go quiet locally.
          if (phaseRef.current === "ringing" && !acceptedRef.current) cleanup();
        }, RING_TIMEOUT_CALLEE_MS);
        return;
      }

      if (row.kind === "decline" || row.kind === "hangup") {
        if (!callIdRef.current || callIdRef.current === row.call_id) {
          if (phaseRef.current === "dialing") {
            showNotice(
              row.kind === "decline"
                ? p.reason === "busy"
                  ? "Busy on another call"
                  : p.reason === "media"
                    ? "They couldn't access their mic/camera."
                    : "Call declined"
                : "Call ended",
            );
          } else if (phaseRef.current === "ringing") {
            showNotice("Missed call");
          }
          // Don't purge here — the peer that hung up delays the delete so
          // this INSERT can land on every device first.
          cleanup();
        }
        return;
      }

      if (row.kind === "offer" && p.sdp) {
        // Mid-call renegotiation (screenshare on a voice call).
        if (
          phaseRef.current === "in-call" &&
          callIdRef.current === row.call_id &&
          remoteSetRef.current
        ) {
          try {
            await answerRenegotiation(p.sdp, row.from_user, row.call_id, row.room_id);
          } catch (err) {
            console.warn("renegotiation answer failed", err);
          }
          return;
        }

        if (answeredCallIdRef.current !== row.call_id) {
          pendingOfferRef.current = {
            callId: row.call_id,
            from: row.from_user,
            payload: p,
          };
        }
        if (!acceptedRef.current) return; // wait for the user to accept
        if (answeredCallIdRef.current === row.call_id || remoteSetRef.current) return;
        try {
          await answerOffer({ callId: row.call_id, from: row.from_user, payload: p });
        } catch (err) {
          setStatusText(err instanceof Error ? err.message : "Call failed");
        }
        return;
      }

      if (row.kind === "answer" && p.sdp && pcRef.current) {
        try {
          stopTones();
          clearTimers();
          // The ring timeout just went away — from here on the connection
          // itself is what we wait for.
          armConnectTimeout();
          const pc = pcRef.current;
          if (pc.signalingState === "have-local-offer") {
            remoteSetRef.current = true;
            await pc.setRemoteDescription(p.sdp);
            await loadMissedIce(row.call_id);
            await flushIce();
          }
          if (phaseRef.current !== "in-call") {
            setPhase("connecting");
            setStatusText("Connecting…");
          }
        } catch (err) {
          setStatusText(err instanceof Error ? err.message : "Answer failed");
        }
        return;
      }

      if (row.kind === "ice" && p.candidate) {
        if (pcRef.current?.remoteDescription) {
          try {
            await pcRef.current.addIceCandidate(p.candidate);
          } catch {
            /* ignore */
          }
        } else {
          pendingIceRef.current.push(p.candidate);
        }
      }
    },
    [answerOffer, answerRenegotiation, armConnectTimeout, cleanup, clearTimers, flushIce, loadMissedIce, send, showNotice, userId],
  );

  handlingRef.current = handleSignal;

  const hangup = useCallback(() => {
    const id = callIdRef.current;
    const peer = peerIdRef.current;
    const room = roomIdRef.current;
    // Tear down local media immediately, but do not delete signaling
    // rows until the hangup insert has been delivered — otherwise the
    // peer never sees the hangup and stays stuck in the call.
    cleanup({ purge: false });
    if (id && peer && room) {
      void postCallEvent(room, "call_ended", "Call ended").catch(() => {});
      void send("hangup", id, peer, room).finally(() => {
        window.setTimeout(() => purgeSignals(id), 2000);
      });
    }
  }, [cleanup, purgeSignals, send]);

  // The ICE handler is created before hangup exists, so it ends calls
  // through this ref.
  endCallRef.current = hangup;

  const dial = useCallback(
    async (
      roomId: string,
      roomName: string,
      peer: { id: string; full_name: string },
      video: boolean,
    ) => {
      if (!signalReady) {
        showNotice("Still connecting — try again in a moment");
        return;
      }
      if (phaseRef.current !== "idle") return;

      // FIX A: a new call begins here — bump the generation so any async
      // continuation from a previous (torn-down) call aborts itself.
      callGenRef.current += 1;
      const gen = callGenRef.current;

      const callId = crypto.randomUUID();
      callIdRef.current = callId;
      roomIdRef.current = roomId;
      peerIdRef.current = peer.id;
      acceptedRef.current = true;
      setCall({ callId, roomId, peerId: peer.id, peerName: peer.full_name, video });
      setPhase("dialing");
      setView("full");
      setStatusText("Ringing…");

      try {
        const stream = await getMedia(video);
        if (callGenRef.current !== gen) return; // FIX A
        const pc = ensurePc(peer.id);
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));

        const invitePayload: SignalPayload = {
          fromName: userName,
          roomName,
          video,
        };
        await send("invite", callId, peer.id, roomId, invitePayload);
        if (callGenRef.current !== gen) return; // FIX A
        void postCallEvent(
          roomId,
          "call_started",
          video ? "Video call started" : "Voice call started",
        ).catch(() => {});

        const offer = await pc.createOffer();
        if (callGenRef.current !== gen) return; // FIX A
        await pc.setLocalDescription(offer);
        // Embed candidates in the SDP so a late accept still has a full offer.
        await waitForIceGathering(pc);
        if (callGenRef.current !== gen) return; // FIX A
        const finalOffer = pc.localDescription ?? offer;
        const offerPayload: SignalPayload = {
          fromName: userName,
          roomName,
          video,
          sdp: { type: finalOffer.type, sdp: finalOffer.sdp },
        };
        await send("offer", callId, peer.id, roomId, offerPayload);
        if (callGenRef.current !== gen) return; // FIX A

        startRingback();

        // Re-send invite + offer until answered (covers a callee whose
        // page is still loading), bounded by the ring timeout below.
        resendTimerRef.current = setInterval(() => {
          if (remoteSetRef.current || pcRef.current?.connectionState === "connected") {
            if (resendTimerRef.current) clearInterval(resendTimerRef.current);
            resendTimerRef.current = null;
            return;
          }
          void send("invite", callId, peer.id, roomId, invitePayload);
          void send("offer", callId, peer.id, roomId, offerPayload);
        }, RESEND_MS);

        ringTimerRef.current = setTimeout(() => {
          if (phaseRef.current !== "dialing") return;
          void send("hangup", callId, peer.id, roomId, { reason: "timeout" });
          // Persistent trace + unread badge for the callee. Clients can
          // only insert text/file kinds, so this rides a normal message.
          void supabase.from("messages").insert({
            room_id: roomId,
            sender_id: userId,
            kind: "text",
            body: "📞 Missed call",
          });
          showNotice("No answer");
          cleanup({ purge: true });
        }, RING_TIMEOUT_MS);
      } catch (err) {
        if (callGenRef.current !== gen) return; // FIX A: cleanup already ran
        showNotice(mediaErrorMessage(err)); // FIX B: truthful media failure
        cleanup({ purge: true });
      }
    },
    [cleanup, ensurePc, getMedia, send, showNotice, signalReady, supabase, userId, userName],
  );

  const accept = useCallback(async () => {
    const inc = incomingRef.current;
    if (!inc) return;
    // FIX A: a new call begins here — bump the generation.
    callGenRef.current += 1;
    const gen = callGenRef.current;
    acceptedRef.current = true;
    stopTones();
    clearTimers();
    armConnectTimeout();
    setCall({
      callId: inc.callId,
      roomId: inc.roomId,
      peerId: inc.peerId,
      peerName: inc.peerName,
      video: inc.video,
    });
    setPhase("connecting");
    setView("full");
    setStatusText("Connecting…");
    try {
      await getMedia(inc.video);
      if (callGenRef.current !== gen) return; // FIX A
      const pending = pendingOfferRef.current;
      if (pending && pending.callId === inc.callId) {
        await answerOffer(pending);
        if (callGenRef.current !== gen) return; // FIX A
        pendingOfferRef.current = null;
      } else {
        setStatusText("Waiting for call data…");
      }
      setIncoming(null);
    } catch (err) {
      if (callGenRef.current !== gen) return; // FIX A: cleanup already ran
      // FIX B: when OUR media fails, tell the caller the truth (not a bare
      // "declined") and show ourselves a friendly reason.
      const media = isMediaError(err);
      showNotice(mediaErrorMessage(err));
      void send(
        "decline",
        inc.callId,
        inc.peerId,
        inc.roomId,
        media ? { reason: "media" } : {},
      );
      cleanup();
    }
  }, [answerOffer, armConnectTimeout, cleanup, clearTimers, getMedia, send, showNotice]);

  const decline = useCallback(() => {
    const inc = incomingRef.current;
    if (!inc) return;
    void postCallEvent(inc.roomId, "call_ended", "Call ended").catch(() => {});
    void send("decline", inc.callId, inc.peerId, inc.roomId);
    pendingOfferRef.current = null;
    cleanup();
  }, [cleanup, send]);

  const toggleMic = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      localStreamRef.current?.getAudioTracks().forEach((t) => {
        t.enabled = !next;
      });
      return next;
    });
  }, []);

  const toggleCam = useCallback(() => {
    setCamOff((prev) => {
      const next = !prev;
      // While screensharing, cam toggle only affects the parked camera track.
      const target =
        cameraTrackRef.current ??
        localStreamRef.current?.getVideoTracks()[0] ??
        null;
      if (target && target !== screenStreamRef.current?.getVideoTracks()[0]) {
        target.enabled = !next;
      } else if (!screenStreamRef.current) {
        localStreamRef.current?.getVideoTracks().forEach((t) => {
          t.enabled = !next;
        });
      }
      return next;
    });
  }, []);

  const toggleNoise = useCallback(() => {
    const next = !noiseOff;
    setNoiseOff(next);
    // FIX D: applyConstraints is silently ignored for noiseSuppression by
    // several browsers, so re-acquire the audio track with the desired
    // setting and hot-swap it onto the sender.
    const gen = callGenRef.current;
    const pc = pcRef.current;
    const ls = localStreamRef.current;
    const oldTrack = ls?.getAudioTracks()[0] ?? null;
    void (async () => {
      try {
        const fresh = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: !next,
            autoGainControl: true,
          },
          video: false,
        });
        const newTrack = fresh.getAudioTracks()[0] ?? null;
        // FIX A: call ended mid-acquire — stop the fresh track, keep nothing.
        if (callGenRef.current !== gen || !newTrack) {
          fresh.getTracks().forEach((t) => t.stop());
          return;
        }
        // Preserve the current mute state on the replacement track.
        newTrack.enabled = oldTrack ? oldTrack.enabled : true;
        const sender = pc?.getSenders().find((s) => s.track?.kind === "audio");
        if (sender) {
          try {
            await sender.replaceTrack(newTrack);
          } catch {
            /* ignore */
          }
        }
        // Keep localStreamRef owning the live audio track so cleanup stops it.
        if (ls) {
          if (oldTrack) ls.removeTrack(oldTrack);
          ls.addTrack(newTrack);
        }
        oldTrack?.stop();
      } catch {
        /* ignore — leave the toggle state flipped; it can be retried */
      }
    })();
  }, [noiseOff]);

  const refreshLocalPreview = useCallback((screenTrack: MediaStreamTrack | null) => {
    const mic = localStreamRef.current?.getAudioTracks() ?? [];
    if (screenTrack) {
      setLocalStream(new MediaStream([...mic, screenTrack]));
      return;
    }
    const cam = cameraTrackRef.current;
    const tracks = cam ? [...mic, cam] : [...mic];
    const stream = new MediaStream(tracks);
    // Keep localStreamRef as the camera/mic ownership stream for cleanup.
    setLocalStream(stream);
  }, []);

  const stopScreenShare = useCallback(async () => {
    const pc = pcRef.current;
    const screen = screenStreamRef.current;
    const screenTrack = screen?.getVideoTracks()[0] ?? null;

    if (pc && screenTrack) {
      const videoSender = pc
        .getSenders()
        .find((s) => s.track?.id === screenTrack.id || s.track?.kind === "video");
      if (screenAddedSenderRef.current && videoSender) {
        try {
          pc.removeTrack(videoSender);
        } catch {
          /* ignore */
        }
        if (
          peerIdRef.current &&
          callIdRef.current &&
          roomIdRef.current &&
          pc.signalingState === "stable"
        ) {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await waitForIceGathering(pc);
            const finalOffer = pc.localDescription ?? offer;
            await send("offer", callIdRef.current, peerIdRef.current, roomIdRef.current, {
              video: true,
              sdp: { type: finalOffer.type, sdp: finalOffer.sdp },
            });
          } catch (err) {
            console.warn("screenshare stop renegotiation failed", err);
          }
        }
      } else if (videoSender) {
        if (cameraTrackRef.current) {
          try {
            await videoSender.replaceTrack(cameraTrackRef.current);
          } catch {
            /* ignore */
          }
        } else {
          // FIX C: camera was off, so there's no track to restore. Leaving
          // the sender pointed at the stopped screen track freezes the last
          // frame on the peer — drop the sender and renegotiate so the peer
          // cleanly sees the video go away (same as the voice-call path).
          try {
            pc.removeTrack(videoSender);
          } catch {
            /* ignore */
          }
          if (
            peerIdRef.current &&
            callIdRef.current &&
            roomIdRef.current &&
            pc.signalingState === "stable"
          ) {
            try {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              await waitForIceGathering(pc);
              const finalOffer = pc.localDescription ?? offer;
              await send("offer", callIdRef.current, peerIdRef.current, roomIdRef.current, {
                video: true,
                sdp: { type: finalOffer.type, sdp: finalOffer.sdp },
              });
            } catch (err) {
              console.warn("screenshare stop renegotiation failed", err);
            }
          }
        }
      }
    }

    screen?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    screenAddedSenderRef.current = false;
    setSharing(false);
    refreshLocalPreview(null);
  }, [refreshLocalPreview, send]);

  const startScreenShare = useCallback(async () => {
    if (phaseRef.current !== "in-call") return;
    if (!window.isSecureContext && location.hostname !== "localhost") {
      showNotice("Screen share needs HTTPS.");
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      showNotice("This browser cannot share the screen.");
      return;
    }
    const pc = pcRef.current;
    if (!pc || !peerIdRef.current || !callIdRef.current || !roomIdRef.current) return;

    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: "monitor",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { max: 30 },
        },
        audio: false,
        preferCurrentTab: false,
        selfBrowserSurface: "include",
        surfaceSwitching: "include",
        monitorTypeSurfaces: "include",
      } as DisplayMediaStreamOptions);
      const screenTrack = screen.getVideoTracks()[0];
      if (!screenTrack) {
        screen.getTracks().forEach((t) => t.stop());
        return;
      }
      try {
        screenTrack.contentHint = "detail";
      } catch {
        /* ignore */
      }

      screenStreamRef.current = screen;
      screenTrack.onended = () => {
        void stopScreenShare();
      };

      const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (videoSender) {
        if (videoSender.track && videoSender.track !== cameraTrackRef.current) {
          // Keep the original camera for restore if we somehow replaced already.
        } else if (videoSender.track) {
          cameraTrackRef.current = videoSender.track;
        }
        await videoSender.replaceTrack(screenTrack);
        screenAddedSenderRef.current = false;
      } else {
        const camStream = localStreamRef.current ?? new MediaStream();
        pc.addTrack(screenTrack, camStream);
        screenAddedSenderRef.current = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);
        const finalOffer = pc.localDescription ?? offer;
        await send("offer", callIdRef.current, peerIdRef.current, roomIdRef.current, {
          video: true,
          sdp: { type: finalOffer.type, sdp: finalOffer.sdp },
        });
      }

      setSharing(true);
      refreshLocalPreview(screenTrack);
    } catch (err) {
      // User cancelled the picker — not an error worth surfacing.
      if (err instanceof DOMException && err.name === "NotAllowedError") return;
      showNotice(err instanceof Error ? err.message : "Could not share screen");
    }
  }, [refreshLocalPreview, send, showNotice, stopScreenShare]);

  const toggleScreenShare = useCallback(async () => {
    if (screenStreamRef.current) {
      await stopScreenShare();
    } else {
      await startScreenShare();
    }
  }, [startScreenShare, stopScreenShare]);

  // One global signaling channel for the whole session.
  useEffect(() => {
    installAutoResume();
    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    (async () => {
      await ensureRealtimeAuth(supabase);
      if (cancelled) return;

      channel = supabase
        .channel(`call:${userId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "call_signals",
            filter: `to_user=eq.${userId}`,
          },
          (payload) => {
            void handlingRef.current?.(payload.new as SignalRow);
          },
        )
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "call_signals",
            filter: `from_user=eq.${userId}`,
          },
          (payload) => {
            void handlingRef.current?.(payload.new as SignalRow);
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") setSignalReady(true);
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setSignalReady(false);
          }
        });
    })();

    return () => {
      cancelled = true;
      setSignalReady(false);
      if (channel) void supabase.removeChannel(channel);
      cleanup();
    };
    // Stable subscribe — handler goes through handlingRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, userId]);

  const value = useMemo<CallContextValue>(
    () => ({
      phase,
      call,
      incoming,
      view,
      muted,
      camOff,
      noiseOff,
      sharing,
      statusText,
      signalReady,
      localStream,
      remoteStream,
      remoteHasVideo,
      connectedAt,
      dial,
      accept,
      decline,
      hangup,
      toggleMic,
      toggleCam,
      toggleNoise,
      toggleScreenShare,
      setView,
    }),
    [
      phase,
      call,
      incoming,
      view,
      muted,
      camOff,
      noiseOff,
      sharing,
      statusText,
      signalReady,
      localStream,
      remoteStream,
      remoteHasVideo,
      connectedAt,
      dial,
      accept,
      decline,
      hangup,
      toggleMic,
      toggleCam,
      toggleNoise,
      toggleScreenShare,
    ],
  );

  const onCall = call && phase !== "idle" && phase !== "ringing";

  return (
    <CallContext.Provider value={value}>
      {children}
      {/* Persistent audio sink — never unmounts, so call audio survives
          navigation and minimize/expand. */}
      <audio ref={remoteAudioRef} autoPlay className="hidden" />
      {incoming && phase === "ringing" && <IncomingCallOverlay />}
      {onCall && (view === "full" ? <FullScreenCall /> : <FloatingCallTile />)}
      {notice && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-20 left-1/2 z-[130] -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-white shadow-lg"
        >
          {notice}
        </div>
      )}
    </CallContext.Provider>
  );
}

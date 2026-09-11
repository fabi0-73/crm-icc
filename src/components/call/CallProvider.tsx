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
 *
 * Topology: a full mesh. Every participant holds one RTCPeerConnection
 * per other participant, all sharing the same call_id. The invite
 * carries the roster; to avoid glare exactly one side of each pair
 * offers (the caller always offers to the people it invited, and
 * between two invitees the lower user id offers).
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

/** Hard ceiling on a single group call. */
export const MAX_CALL_PARTICIPANTS = 100;

type SignalKind = "invite" | "offer" | "answer" | "ice" | "hangup" | "decline";

type RosterEntry = { id: string; name: string };

type SignalPayload = {
  fromName?: string;
  roomName?: string;
  video?: boolean;
  reason?: "busy" | "timeout" | "media";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  /** Everyone in this call, caller included (mesh discovery). */
  roster?: RosterEntry[];
  /** Who started the call — invitees never offer to them. */
  callerId?: string;
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
  /** Primary peer (the other person in a 1:1, the caller in a group). */
  peerId: string;
  peerName: string;
  video: boolean;
  /** Everyone invited, caller included. One entry in a 1:1. */
  roster: RosterEntry[];
};

export type IncomingCall = ActiveCall & { roomName: string | null };

export type Participant = {
  id: string;
  name: string;
  stream: MediaStream | null;
  hasVideo: boolean;
  connected: boolean;
};

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
  /** Primary remote stream — the mini tile and 1:1 view use this. */
  remoteStream: MediaStream | null;
  remoteHasVideo: boolean;
  participants: Participant[];
  connectedAt: number | null;
  dial: (
    roomId: string,
    roomName: string,
    peers: RosterEntry[],
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

/** One leg of the mesh. */
type PeerEntry = {
  pc: RTCPeerConnection;
  name: string;
  stream: MediaStream | null;
  hasVideo: boolean;
  connected: boolean;
  pendingIce: RTCIceCandidateInit[];
  remoteSet: boolean;
  /** True once we added a screen track as an extra sender (voice call). */
  screenAddedSender: boolean;
};

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
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const callIdRef = useRef<string | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const callerIdRef = useRef<string | null>(null);
  const rosterRef = useRef<RosterEntry[]>([]);
  const phaseRef = useRef<CallPhase>("idle");
  const incomingRef = useRef<IncomingCall | null>(null);
  const videoCallRef = useRef(false);
  /** Offers that arrived before this user accepted, keyed by sender. */
  const pendingOffersRef = useRef<Map<string, SignalPayload>>(new Map());
  const acceptedRef = useRef(false);
  const resendTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlingRef = useRef<((row: SignalRow) => Promise<void>) | null>(null);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dropTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
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

  /** Publish the peer map to React. */
  const syncParticipants = useCallback(() => {
    setParticipants(
      [...peersRef.current.entries()].map(([id, p]) => ({
        id,
        name: p.name,
        stream: p.stream,
        hasVideo: p.hasVideo,
        connected: p.connected,
      })),
    );
  }, []);

  /**
   * Once the call is answered nothing else was watching the connection:
   * if ICE never completed (blocked relay, dead network) everyone sat on
   * "Connecting…" forever. This ends the call instead.
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

  /** Drop one leg of the mesh (peer hung up, or its connection died). */
  const closePeer = useCallback(
    (peerId: string) => {
      const entry = peersRef.current.get(peerId);
      if (!entry) return;
      try {
        entry.pc.close();
      } catch {
        /* ignore */
      }
      peersRef.current.delete(peerId);
      const timer = dropTimersRef.current.get(peerId);
      if (timer) {
        clearTimeout(timer);
        dropTimersRef.current.delete(peerId);
      }
      syncParticipants();
    },
    [syncParticipants],
  );

  const cleanup = useCallback(
    (opts?: { purge?: boolean }) => {
      // Bump the generation so any in-flight async (getMedia/dial/accept/
      // answerOffer/toggleNoise) sees the change and aborts its
      // continuation instead of resurrecting a torn-down call.
      callGenRef.current += 1;
      clearTimers();
      dropTimersRef.current.forEach((t) => clearTimeout(t));
      dropTimersRef.current.clear();
      connectedAtRef.current = null;
      stopTones();
      if (opts?.purge) purgeSignals(callIdRef.current);
      peersRef.current.forEach((entry) => {
        try {
          entry.pc.close();
        } catch {
          /* ignore */
        }
      });
      peersRef.current.clear();
      // Screen capture is stopped here too: ending a call while sharing
      // must release the display surface, not just the camera and mic.
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      cameraTrackRef.current = null;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      callIdRef.current = null;
      roomIdRef.current = null;
      callerIdRef.current = null;
      rosterRef.current = [];
      videoCallRef.current = false;
      pendingOffersRef.current.clear();
      acceptedRef.current = false;
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
      setParticipants([]);
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

  const flushIce = useCallback(async (peerId: string) => {
    const entry = peersRef.current.get(peerId);
    if (!entry?.pc.remoteDescription) return;
    const queued = entry.pendingIce.splice(0);
    for (const c of queued) {
      try {
        await entry.pc.addIceCandidate(c);
      } catch {
        /* ignore */
      }
    }
  }, []);

  /** Replay ICE rows from one peer that arrived before we were ready. */
  const loadMissedIce = useCallback(
    async (callId: string, peerId: string) => {
      const { data, error } = await supabase
        .from("call_signals")
        .select("payload")
        .eq("call_id", callId)
        .eq("to_user", userId)
        .eq("from_user", peerId)
        .eq("kind", "ice")
        .order("created_at", { ascending: true });
      if (error || !data) return;
      const entry = peersRef.current.get(peerId);
      if (!entry) return;
      for (const row of data) {
        const candidate = (row.payload as SignalPayload)?.candidate;
        if (candidate) entry.pendingIce.push(candidate);
      }
      await flushIce(peerId);
    },
    [flushIce, supabase, userId],
  );

  const ensurePeer = useCallback(
    (peerId: string, name?: string) => {
      const existing = peersRef.current.get(peerId);
      if (existing) {
        if (name && existing.name !== name) {
          existing.name = name;
          syncParticipants();
        }
        return existing;
      }

      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      const entry: PeerEntry = {
        pc,
        name: name ?? "Participant",
        stream: null,
        hasVideo: false,
        connected: false,
        pendingIce: [],
        remoteSet: false,
        screenAddedSender: false,
      };
      peersRef.current.set(peerId, entry);

      pc.onicecandidate = (e) => {
        if (!e.candidate || !callIdRef.current || !roomIdRef.current) return;
        void send("ice", callIdRef.current, peerId, roomIdRef.current, {
          candidate: e.candidate.toJSON(),
        });
      };

      pc.ontrack = (e) => {
        const incomingStream = e.streams[0] ?? new MediaStream([e.track]);
        const current = peersRef.current.get(peerId);
        if (!current) return;
        // Merge newly arrived tracks into one stream per peer so a
        // voice→screen renegotiation reaches the UI and the audio sink.
        const next = new MediaStream(current.stream?.getTracks() ?? []);
        for (const t of incomingStream.getTracks()) {
          if (!next.getTracks().some((x) => x.id === t.id)) next.addTrack(t);
        }
        if (!next.getTracks().some((x) => x.id === e.track.id)) {
          next.addTrack(e.track);
        }
        current.stream = next;

        // Keep hasVideo honest as the peer's video comes and goes (screen
        // share stop/start, camera off) so the tile drops back to the
        // avatar instead of freezing on the last frame.
        const recompute = () => {
          const live = peersRef.current.get(peerId);
          if (!live) return;
          live.hasVideo = live.pc
            .getReceivers()
            .some(
              (r) =>
                r.track?.kind === "video" &&
                r.track.readyState === "live" &&
                !r.track.muted,
            );
          syncParticipants();
        };
        if (e.track.kind === "video") {
          e.track.addEventListener("ended", recompute);
          e.track.addEventListener("mute", recompute);
          e.track.addEventListener("unmute", recompute);
          incomingStream.addEventListener("removetrack", recompute);
        }
        recompute();
        syncParticipants();
      };

      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        const live = peersRef.current.get(peerId);
        if (!live) return;
        const existingTimer = dropTimersRef.current.get(peerId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          dropTimersRef.current.delete(peerId);
        }

        if (s === "connected" || s === "completed") {
          live.connected = true;
          syncParticipants();
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
          if (!connectedAtRef.current) setStatusText("Connecting…");
        } else if (s === "disconnected") {
          // Often transient (network switch) — give it a moment to recover.
          live.connected = false;
          syncParticipants();
          if (peersRef.current.size === 1) setStatusText("Reconnecting…");
          dropTimersRef.current.set(
            peerId,
            setTimeout(() => {
              dropTimersRef.current.delete(peerId);
              const stillBad =
                peersRef.current.get(peerId)?.pc.iceConnectionState ===
                "disconnected";
              if (!stillBad) return;
              closePeer(peerId);
              if (peersRef.current.size === 0) {
                showNotice("Call dropped — the connection was lost");
                endCallRef.current?.();
              }
            }, DROP_GRACE_MS),
          );
        } else if (s === "failed" || s === "closed") {
          closePeer(peerId);
          if (peersRef.current.size === 0) {
            setStatusText("Connection failed");
            showNotice(
              connectedAtRef.current
                ? "Call dropped — the connection was lost"
                : "Couldn't connect — check your network and try again",
            );
            endCallRef.current?.();
          }
        }
      };

      syncParticipants();
      return entry;
    },
    [clearTimers, closePeer, send, showNotice, syncParticipants],
  );

  const getMedia = useCallback(async (video: boolean) => {
    // Capture the generation so a stream that arrives after the call
    // ended is stopped, never stored (this is what kept the webcam on).
    const gen = callGenRef.current;
    if (!window.isSecureContext && location.hostname !== "localhost") {
      throw new Error("Calls need HTTPS.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot access mic/camera.");
    }
    // 720p 16:9 with no crop-scaling: the default 4:3 capture was being
    // cropped to fill the stage, which is what made the camera look
    // zoomed in. A wider native frame keeps the same detail.
    const videoConstraints = {
      facingMode: "user",
      width: { ideal: 1280, max: 1920 },
      height: { ideal: 720, max: 1080 },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: 30, max: 30 },
      resizeMode: "none",
    } as unknown as MediaTrackConstraints;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: video ? videoConstraints : false,
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

  /** Put our local tracks on a peer connection exactly once. */
  const attachLocalTracks = useCallback((pc: RTCPeerConnection) => {
    const stream = localStreamRef.current;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      if (!pc.getSenders().some((s) => s.track?.id === track.id)) {
        pc.addTrack(track, stream);
      }
    }
    // If we are already screen sharing, the newcomer gets the screen too.
    const screenTrack = screenStreamRef.current?.getVideoTracks()[0];
    if (screenTrack && !pc.getSenders().some((s) => s.track?.id === screenTrack.id)) {
      pc.addTrack(screenTrack, stream);
    }
  }, []);

  /** Offer to a peer we are responsible for initiating with. */
  const offerTo = useCallback(
    async (peerId: string, name: string, video: boolean) => {
      const callId = callIdRef.current;
      const roomId = roomIdRef.current;
      if (!callId || !roomId) return;
      const gen = callGenRef.current;
      const entry = ensurePeer(peerId, name);
      attachLocalTracks(entry.pc);
      if (entry.pc.signalingState !== "stable") return;

      const offer = await entry.pc.createOffer();
      if (callGenRef.current !== gen) return;
      await entry.pc.setLocalDescription(offer);
      await waitForIceGathering(entry.pc);
      if (callGenRef.current !== gen) return;
      const finalOffer = entry.pc.localDescription ?? offer;
      await send("offer", callId, peerId, roomId, {
        fromName: userName,
        video,
        callerId: callerIdRef.current ?? undefined,
        roster: rosterRef.current,
        sdp: { type: finalOffer.type, sdp: finalOffer.sdp },
      });
    },
    [attachLocalTracks, ensurePeer, send, userName],
  );

  /** Answer a mid-call renegotiation offer (peer started screenshare). */
  const answerRenegotiation = useCallback(
    async (
      sdp: RTCSessionDescriptionInit,
      from: string,
      callId: string,
      roomId: string,
    ) => {
      const entry = peersRef.current.get(from);
      if (!entry || entry.pc.signalingState !== "stable") return;
      await entry.pc.setRemoteDescription(sdp);
      await flushIce(from);
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      await waitForIceGathering(entry.pc);
      const finalAnswer = entry.pc.localDescription ?? answer;
      await send("answer", callId, from, roomId, {
        sdp: { type: finalAnswer.type, sdp: finalAnswer.sdp },
      });
    },
    [flushIce, send],
  );

  /** Answer the initial offer from one peer. */
  const answerOffer = useCallback(
    async (offer: { callId: string; from: string; payload: SignalPayload }) => {
      // Capture the generation; abort after any await if cleanup ran, so a
      // stale continuation never sends an answer or flips phase.
      const gen = callGenRef.current;
      if (!offer.payload.sdp) return;
      const entry = ensurePeer(offer.from, offer.payload.fromName);
      if (entry.remoteSet || entry.pc.currentRemoteDescription) return;
      if (entry.pc.signalingState !== "stable") return;

      const video = Boolean(offer.payload.video || videoCallRef.current);
      if (!localStreamRef.current) await getMedia(video);
      if (callGenRef.current !== gen) return;
      attachLocalTracks(entry.pc);

      await entry.pc.setRemoteDescription(offer.payload.sdp);
      if (callGenRef.current !== gen) return;
      entry.remoteSet = true;
      await loadMissedIce(offer.callId, offer.from);
      if (callGenRef.current !== gen) return;
      await flushIce(offer.from);
      const answer = await entry.pc.createAnswer();
      if (callGenRef.current !== gen) return;
      await entry.pc.setLocalDescription(answer);
      await waitForIceGathering(entry.pc);
      if (callGenRef.current !== gen) return;
      const finalAnswer = entry.pc.localDescription ?? answer;
      await send("answer", offer.callId, offer.from, roomIdRef.current!, {
        sdp: { type: finalAnswer.type, sdp: finalAnswer.sdp },
      });
      if (callGenRef.current !== gen) return;
      // On a fast network ICE can reach "connected" before this resolves;
      // without the guard the callee is knocked back to "Connecting…".
      if (!connectedAtRef.current) {
        setStatusText("Connecting…");
        setPhase("connecting");
      }
      setIncoming(null);
    },
    [
      attachLocalTracks,
      ensurePeer,
      flushIce,
      getMedia,
      loadMissedIce,
      send,
    ],
  );

  /** Connect to everyone else in the roster (mesh), avoiding glare. */
  const connectRoster = useCallback(
    (video: boolean) => {
      const callerId = callerIdRef.current;
      for (const person of rosterRef.current) {
        if (person.id === userId) continue;
        if (person.id === callerId) continue; // they offer to us
        if (peersRef.current.has(person.id)) continue;
        // Deterministic offerer between two invitees.
        if (userId < person.id) {
          void offerTo(person.id, person.name, video).catch(() => {});
        } else {
          ensurePeer(person.id, person.name);
        }
      }
    },
    [ensurePeer, offerTo, userId],
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
          // Full cleanup (not a partial reset) so any peer connection or
          // media this tab spun up for the same call can't leak.
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
        callerIdRef.current = row.from_user;
        videoCallRef.current = Boolean(p.video);
        rosterRef.current =
          p.roster && p.roster.length > 0
            ? p.roster
            : [
                { id: row.from_user, name: p.fromName ?? "Unknown caller" },
                { id: userId, name: userName },
              ];
        setIncoming({
          callId: row.call_id,
          roomId: row.room_id,
          peerId: row.from_user,
          peerName: p.fromName ?? "Unknown caller",
          roomName: p.roomName ?? null,
          video: Boolean(p.video),
          roster: rosterRef.current,
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
        if (callIdRef.current && callIdRef.current !== row.call_id) return;

        if (row.kind === "decline" && peersRef.current.size > 0) {
          // One invitee said no to a group call — the call goes on.
          pendingOffersRef.current.delete(row.from_user);
          closePeer(row.from_user);
          if (peersRef.current.size > 0) return;
        }

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
        // Don't purge here — whoever hung up delays the delete so this
        // INSERT can land on every device first.
        cleanup();
        return;
      }

      if (row.kind === "offer" && p.sdp) {
        const known = peersRef.current.get(row.from_user);
        // Mid-call renegotiation (screenshare started/stopped).
        if (known?.remoteSet && callIdRef.current === row.call_id) {
          try {
            await answerRenegotiation(p.sdp, row.from_user, row.call_id, row.room_id);
          } catch (err) {
            console.warn("renegotiation answer failed", err);
          }
          return;
        }

        // A participant we have not met yet (mesh join) — only trust it
        // for the call we are already in, or one we are being invited to.
        if (callIdRef.current && callIdRef.current !== row.call_id) return;
        if (!acceptedRef.current) {
          pendingOffersRef.current.set(row.from_user, p);
          return; // wait for the user to accept
        }
        try {
          await answerOffer({
            callId: row.call_id,
            from: row.from_user,
            payload: p,
          });
        } catch (err) {
          setStatusText(err instanceof Error ? err.message : "Call failed");
        }
        return;
      }

      if (row.kind === "answer" && p.sdp) {
        const entry = peersRef.current.get(row.from_user);
        if (!entry) return;
        try {
          stopTones();
          clearTimers();
          // The ring timeout just went away — from here on the connection
          // itself is what we wait for.
          armConnectTimeout();
          if (entry.pc.signalingState === "have-local-offer") {
            entry.remoteSet = true;
            await entry.pc.setRemoteDescription(p.sdp);
            await loadMissedIce(row.call_id, row.from_user);
            await flushIce(row.from_user);
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
        const entry = peersRef.current.get(row.from_user);
        if (!entry) return;
        if (entry.pc.remoteDescription) {
          try {
            await entry.pc.addIceCandidate(p.candidate);
          } catch {
            /* ignore */
          }
        } else {
          entry.pendingIce.push(p.candidate);
        }
      }
    },
    [
      answerOffer,
      answerRenegotiation,
      armConnectTimeout,
      cleanup,
      clearTimers,
      closePeer,
      flushIce,
      loadMissedIce,
      send,
      showNotice,
      userId,
      userName,
    ],
  );

  handlingRef.current = handleSignal;

  const hangup = useCallback(() => {
    const id = callIdRef.current;
    const room = roomIdRef.current;
    // Everyone in the call, not just the people we have a connection to:
    // an invitee that never answered must stop ringing as well.
    const targets = new Set<string>([
      ...peersRef.current.keys(),
      ...rosterRef.current.map((r) => r.id),
    ]);
    targets.delete(userId);

    // Tear down local media (camera, mic AND any screen capture)
    // immediately, but do not delete signaling rows until the hangup
    // inserts have been delivered — otherwise peers never see the hangup
    // and stay stuck in the call.
    cleanup({ purge: false });
    if (id && room && targets.size > 0) {
      void postCallEvent(room, "call_ended", "Call ended").catch(() => {});
      void Promise.all(
        [...targets].map((to) => send("hangup", id, to, room)),
      ).finally(() => {
        window.setTimeout(() => purgeSignals(id), 2000);
      });
    }
  }, [cleanup, purgeSignals, send, userId]);

  // The ICE handler is created before hangup exists, so it ends calls
  // through this ref.
  endCallRef.current = hangup;

  const dial = useCallback(
    async (
      roomId: string,
      roomName: string,
      peers: RosterEntry[],
      video: boolean,
    ) => {
      if (!signalReady) {
        showNotice("Still connecting — try again in a moment");
        return;
      }
      if (phaseRef.current !== "idle") return;
      const invitees = peers.filter((p) => p.id !== userId);
      if (invitees.length === 0) return;
      if (invitees.length + 1 > MAX_CALL_PARTICIPANTS) {
        showNotice(`A call can hold ${MAX_CALL_PARTICIPANTS} people.`);
        return;
      }

      // A new call begins here — bump the generation so any async
      // continuation from a previous (torn-down) call aborts itself.
      callGenRef.current += 1;
      const gen = callGenRef.current;

      const callId = crypto.randomUUID();
      const roster: RosterEntry[] = [
        { id: userId, name: userName },
        ...invitees,
      ];
      callIdRef.current = callId;
      roomIdRef.current = roomId;
      callerIdRef.current = userId;
      rosterRef.current = roster;
      videoCallRef.current = video;
      acceptedRef.current = true;
      setCall({
        callId,
        roomId,
        peerId: invitees[0].id,
        peerName:
          invitees.length === 1
            ? invitees[0].name
            : `${roomName} · ${invitees.length + 1} people`,
        video,
        roster,
      });
      setPhase("dialing");
      setView("full");
      setStatusText("Ringing…");

      try {
        await getMedia(video);
        if (callGenRef.current !== gen) return;

        const invitePayload: SignalPayload = {
          fromName: userName,
          roomName,
          video,
          roster,
          callerId: userId,
        };

        for (const peer of invitees) {
          const entry = ensurePeer(peer.id, peer.name);
          attachLocalTracks(entry.pc);
          await send("invite", callId, peer.id, roomId, invitePayload);
        }
        if (callGenRef.current !== gen) return;

        void postCallEvent(
          roomId,
          "call_started",
          video ? "Video call started" : "Voice call started",
        ).catch(() => {});

        // Offer to each invitee. Candidates are embedded in the SDP so a
        // late accept still has a complete offer.
        const offers = new Map<string, SignalPayload>();
        for (const peer of invitees) {
          const entry = peersRef.current.get(peer.id);
          if (!entry) continue;
          const offer = await entry.pc.createOffer();
          if (callGenRef.current !== gen) return;
          await entry.pc.setLocalDescription(offer);
          await waitForIceGathering(entry.pc);
          if (callGenRef.current !== gen) return;
          const finalOffer = entry.pc.localDescription ?? offer;
          const payload: SignalPayload = {
            fromName: userName,
            roomName,
            video,
            roster,
            callerId: userId,
            sdp: { type: finalOffer.type, sdp: finalOffer.sdp },
          };
          offers.set(peer.id, payload);
          await send("offer", callId, peer.id, roomId, payload);
        }
        if (callGenRef.current !== gen) return;

        startRingback();

        // Re-send invite + offer until answered (covers a callee whose
        // page is still loading), bounded by the ring timeout below.
        resendTimerRef.current = setInterval(() => {
          const outstanding = [...peersRef.current.entries()].filter(
            ([, e]) => !e.remoteSet && e.pc.connectionState !== "connected",
          );
          if (outstanding.length === 0) {
            if (resendTimerRef.current) clearInterval(resendTimerRef.current);
            resendTimerRef.current = null;
            return;
          }
          for (const [peerId] of outstanding) {
            void send("invite", callId, peerId, roomId, invitePayload);
            const payload = offers.get(peerId);
            if (payload) void send("offer", callId, peerId, roomId, payload);
          }
        }, RESEND_MS);

        ringTimerRef.current = setTimeout(() => {
          if (phaseRef.current !== "dialing") return;
          for (const peer of invitees) {
            void send("hangup", callId, peer.id, roomId, { reason: "timeout" });
          }
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
        if (callGenRef.current !== gen) return; // cleanup already ran
        showNotice(mediaErrorMessage(err));
        cleanup({ purge: true });
      }
    },
    [
      attachLocalTracks,
      cleanup,
      ensurePeer,
      getMedia,
      send,
      showNotice,
      signalReady,
      supabase,
      userId,
      userName,
    ],
  );

  const accept = useCallback(async () => {
    const inc = incomingRef.current;
    if (!inc) return;
    // A new call begins here — bump the generation.
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
      peerName:
        inc.roster.length > 2
          ? `${inc.roomName ?? "Group"} · ${inc.roster.length} people`
          : inc.peerName,
      video: inc.video,
      roster: inc.roster,
    });
    setPhase("connecting");
    setView("full");
    setStatusText("Connecting…");
    try {
      await getMedia(inc.video);
      if (callGenRef.current !== gen) return;

      const pending = [...pendingOffersRef.current.entries()];
      pendingOffersRef.current.clear();
      for (const [from, payload] of pending) {
        await answerOffer({ callId: inc.callId, from, payload });
        if (callGenRef.current !== gen) return;
      }
      if (pending.length === 0) setStatusText("Waiting for call data…");

      // Group call: reach the other invitees directly (mesh).
      connectRoster(inc.video);
      setIncoming(null);
    } catch (err) {
      if (callGenRef.current !== gen) return; // cleanup already ran
      // When OUR media fails, tell the caller the truth (not a bare
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
  }, [
    answerOffer,
    armConnectTimeout,
    cleanup,
    clearTimers,
    connectRoster,
    getMedia,
    send,
    showNotice,
  ]);

  const decline = useCallback(() => {
    const inc = incomingRef.current;
    if (!inc) return;
    void postCallEvent(inc.roomId, "call_ended", "Call ended").catch(() => {});
    void send("decline", inc.callId, inc.peerId, inc.roomId);
    pendingOffersRef.current.clear();
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
    // applyConstraints is silently ignored for noiseSuppression by several
    // browsers, so re-acquire the audio track with the desired setting and
    // hot-swap it onto every sender.
    const gen = callGenRef.current;
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
        // Call ended mid-acquire — stop the fresh track, keep nothing.
        if (callGenRef.current !== gen || !newTrack) {
          fresh.getTracks().forEach((t) => t.stop());
          return;
        }
        // Preserve the current mute state on the replacement track.
        newTrack.enabled = oldTrack ? oldTrack.enabled : true;
        for (const entry of peersRef.current.values()) {
          const sender = entry.pc
            .getSenders()
            .find((s) => s.track?.kind === "audio");
          if (!sender) continue;
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
    // Keep localStreamRef as the camera/mic ownership stream for cleanup.
    setLocalStream(new MediaStream(tracks));
  }, []);

  /** Re-offer to one peer after adding/removing a screen track. */
  const renegotiate = useCallback(
    async (peerId: string, entry: PeerEntry) => {
      const callId = callIdRef.current;
      const roomId = roomIdRef.current;
      if (!callId || !roomId || entry.pc.signalingState !== "stable") return;
      try {
        const offer = await entry.pc.createOffer();
        await entry.pc.setLocalDescription(offer);
        await waitForIceGathering(entry.pc);
        const finalOffer = entry.pc.localDescription ?? offer;
        await send("offer", callId, peerId, roomId, {
          video: true,
          sdp: { type: finalOffer.type, sdp: finalOffer.sdp },
        });
      } catch (err) {
        console.warn("renegotiation failed", err);
      }
    },
    [send],
  );

  const stopScreenShare = useCallback(async () => {
    const screen = screenStreamRef.current;
    const screenTrack = screen?.getVideoTracks()[0] ?? null;

    if (screenTrack) {
      for (const [peerId, entry] of peersRef.current.entries()) {
        const videoSender = entry.pc
          .getSenders()
          .find(
            (s) => s.track?.id === screenTrack.id || s.track?.kind === "video",
          );
        if (!videoSender) continue;

        if (entry.screenAddedSender) {
          try {
            entry.pc.removeTrack(videoSender);
          } catch {
            /* ignore */
          }
          entry.screenAddedSender = false;
          await renegotiate(peerId, entry);
        } else if (cameraTrackRef.current) {
          try {
            await videoSender.replaceTrack(cameraTrackRef.current);
          } catch {
            /* ignore */
          }
        } else {
          // Camera was off, so there's no track to restore. Leaving the
          // sender pointed at the stopped screen track freezes the last
          // frame on the peer — drop it and renegotiate instead.
          try {
            entry.pc.removeTrack(videoSender);
          } catch {
            /* ignore */
          }
          await renegotiate(peerId, entry);
        }
      }
    }

    screen?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setSharing(false);
    refreshLocalPreview(null);
  }, [refreshLocalPreview, renegotiate]);

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
    if (peersRef.current.size === 0 || !callIdRef.current || !roomIdRef.current) {
      return;
    }

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

      for (const [peerId, entry] of peersRef.current.entries()) {
        const videoSender = entry.pc
          .getSenders()
          .find((s) => s.track?.kind === "video");
        if (videoSender) {
          if (videoSender.track && videoSender.track !== cameraTrackRef.current) {
            // Already replaced somehow — keep the original for restore.
          } else if (videoSender.track) {
            cameraTrackRef.current = videoSender.track;
          }
          await videoSender.replaceTrack(screenTrack);
          entry.screenAddedSender = false;
        } else {
          const camStream = localStreamRef.current ?? new MediaStream();
          entry.pc.addTrack(screenTrack, camStream);
          entry.screenAddedSender = true;
          await renegotiate(peerId, entry);
        }
      }

      setSharing(true);
      refreshLocalPreview(screenTrack);
    } catch (err) {
      // User cancelled the picker — not an error worth surfacing.
      if (err instanceof DOMException && err.name === "NotAllowedError") return;
      showNotice(err instanceof Error ? err.message : "Could not share screen");
    }
  }, [refreshLocalPreview, renegotiate, showNotice, stopScreenShare]);

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

  const primary = participants[0] ?? null;
  const remoteHasVideo = participants.some((p) => p.hasVideo);

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
      remoteStream: primary?.stream ?? null,
      remoteHasVideo,
      participants,
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
      primary,
      remoteHasVideo,
      participants,
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
      {/* Persistent audio sinks — one per participant, never inside the
          call UI, so audio survives navigation and minimize/expand. The
          video elements stay muted so nothing plays twice. */}
      {participants.map((p) => (
        <PeerAudio key={p.id} stream={p.stream} />
      ))}
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

function PeerAudio({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => undefined);
    return () => {
      el.srcObject = null;
    };
  }, [stream]);
  return <audio ref={ref} autoPlay className="hidden" />;
}

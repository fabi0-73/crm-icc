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
  SCREEN_SHARE_PROFILE,
  applyScreenShareParams,
  displayMediaOptions,
  restoreSenderParams,
  watchScreenShareEncoder,
  type GroupView,
  type SavedSenderParams,
} from "@/lib/call/screen-share";
// Types only — the LiveKit SDK itself is imported lazily inside joinLiveKit so
// its ~140 kB never loads for the many sessions that never place a call.
import type {
  CallRoomHandle,
  LiveKitParticipant,
} from "@/lib/call/livekit-room";
import {
  createCallToken,
  muteCallParticipant,
  removeCallParticipant,
} from "@/app/actions/livekit";
import {
  installAutoResume,
  startRingback,
  startRingtone,
  stopTones,
} from "@/lib/call/tones";
import { readNotifyPrefs } from "@/lib/notify-prefs";
import { dismissNotifications, notify } from "@/lib/notify";
import { IncomingCallOverlay } from "@/components/call/IncomingCallOverlay";
import { CallLobby } from "@/components/call/CallLobby";
import { FloatingCallTile } from "@/components/call/FloatingCallTile";
import { FullScreenCall } from "@/components/call/FullScreenCall";
import { PeerAudioSinks } from "@/components/call/CallGrid";
import { X } from "lucide-react";
import type { Role } from "@/lib/types";

/** Answered but never connected — give up instead of hanging forever. */
const CONNECT_TIMEOUT_MS = 25_000;
/** A "disconnected" ICE state this long counts as a dropped call. */
const DROP_GRACE_MS = 12_000;
/** How long we keep ringing before giving up and logging a missed call.
 *  Long on purpose — 30s stopped before people could reach their phone. */
const RING_TIMEOUT_MS = 60_000;
/** Callee gives the caller's timeout a grace window before going quiet. */
const RING_TIMEOUT_CALLEE_MS = 65_000;
const STALE_INVITE_MS = 45_000;
const RESEND_MS = 3_000;
/** Grace before deleting a finished call's signal rows, so the hangup that
 *  ends the call is still there to be delivered. */
const PURGE_DELAY_MS = 8_000;
/** How long a group call may sit with nobody else in it before it ends
 *  itself. Long enough to ride out a reconnect, short enough not to strand. */
const EMPTY_ROOM_GRACE_MS = 4_000;
/** How long a left group call stays rejoinable. */
const REJOIN_WINDOW_MS = 120_000;
/** How long late invites for a finished call are ignored. Must outlive the
 *  resend window (RING_TIMEOUT_MS) but stay short enough that a deliberate
 *  re-invite from "add participant" still rings. */
const DONE_CALL_TTL_MS = 90_000;

type SignalKind = "invite" | "offer" | "answer" | "ice" | "hangup" | "decline";

type SignalPayload = {
  fromName?: string;
  roomName?: string;
  video?: boolean;
  reason?: "busy" | "timeout" | "media";
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  /** GROUP CALLS: every group signal is tagged so the receiver can route it
   *  to the mesh handler and never through the 1:1 code (no new DB `kind`). */
  group?: boolean;
  /** A group `invite` with joining=true is a presence announcement from a
   *  participant who just accepted — a pairing trigger, not a fresh ring. */
  joining?: boolean;
  /** The full participant set (initiator + all invitees) at call start, so a
   *  joiner knows everyone to announce itself to. */
  members?: string[];
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
  /** GROUP CALLS: true for a full-mesh group call. A 1:1 DM call omits it. */
  group?: boolean;
  /** GROUP CALLS: full participant set (initiator + all invitees). */
  memberIds?: string[];
};

export type IncomingCall = ActiveCall & { roomName: string | null };

/** Preview before a group video call actually joins LiveKit. */
export type GroupLobby = {
  intent: "outgoing" | "incoming";
  roomId: string;
  roomName: string;
  memberIds: string[];
  video: true;
};

/** GROUP CALLS: one remote participant, mirrored into state for the grid UI. */
export type GroupParticipant = {
  id: string;
  name: string;
  stream: MediaStream;
  hasVideo: boolean;
  muted: boolean;
  sharing: boolean;
};

type CallContextValue = {
  /** The signed-in user's id, so call tiles can show their own photo. */
  selfId: string;
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
  /** GROUP CALLS: remote participants for the grid ([] for a 1:1 call). */
  groupPeers: GroupParticipant[];
  /** GROUP CALLS: the grid reports whether it shows the grid or a focused
   *  share, so each video is fetched at the size it is displayed. */
  setGroupLayout: (layout: GroupView) => void;
  /** True when this user may add/remove people in the active call. */
  canManageCall: boolean;
  /** GROUP CALLS: ring someone into the call already in progress. */
  addParticipant: (userId: string) => Promise<void>;
  /** GROUP CALLS: evict someone from the call in progress. */
  removeParticipant: (userId: string) => Promise<void>;
  /** GROUP CALLS: force-mute someone else's microphone. */
  muteParticipant: (userId: string) => Promise<void>;
  /** A group call this device just left and can still rejoin, if any. */
  rejoinable: { callId: string; roomId: string; roomName: string; video: boolean } | null;
  rejoinCall: () => Promise<void>;
  dismissRejoin: () => void;
  dial: (
    roomId: string,
    roomName: string,
    peer: { id: string; full_name: string },
    video: boolean,
  ) => Promise<void>;
  /** GROUP CALLS: start a full-mesh call with every other room member. */
  startGroupCall: (
    roomId: string,
    roomName: string,
    memberIds: string[],
    video: boolean,
  ) => Promise<void>;
  /** Group video only: open the pre-join lobby instead of connecting. */
  prepareGroupCall: (
    roomId: string,
    roomName: string,
    memberIds: string[],
  ) => void;
  /** Incoming group video: Accept opens the lobby instead of joining. */
  openIncomingLobby: () => void;
  lobby: GroupLobby | null;
  confirmLobby: (prefs: { muted: boolean; camOff: boolean }) => Promise<void>;
  cancelLobby: () => void;
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

/** mm:ss (or h:mm:ss) for a connected-call duration, used in call-history. */
function formatCallDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function CallProvider({
  userId,
  userName,
  userRole,
  children,
}: {
  userId: string;
  userName: string;
  /** Only admins and managers may manage participants mid-call. */
  userRole?: Role;
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
  // GROUP CALLS: render-facing snapshot of the peers (empty for 1:1).
  const [groupPeers, setGroupPeers] = useState<GroupParticipant[]>([]);
  /** A group call this device left that can still be rejoined. */
  const [rejoinable, setRejoinable] = useState<{
    callId: string;
    roomId: string;
    roomName: string;
    video: boolean;
  } | null>(null);
  const [lobby, setLobby] = useState<GroupLobby | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  /** True when screen was added as a new sender (voice call); false when replaceTrack. */
  const screenAddedSenderRef = useRef(false);
  // 1:1 screen share: the camera sender's settings before screen settings
  // replaced them (restored on stop), and the AV1 CPU watchdog's stop.
  const screenParamsRef = useRef<{
    sender: RTCRtpSender;
    saved: SavedSenderParams;
  } | null>(null);
  const stopEncoderWatchRef = useRef<(() => void) | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const callIdRef = useRef<string | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const phaseRef = useRef<CallPhase>("idle");
  const incomingRef = useRef<IncomingCall | null>(null);
  const lobbyRef = useRef<GroupLobby | null>(null);
  /** Mic/camera chosen in the lobby; consumed once by joinLiveKit. */
  const joinPrefsRef = useRef<{ mic: boolean; camera: boolean } | null>(null);
  /** Mirror of `call` for callbacks that must not depend on it. */
  const callRef = useRef<ActiveCall | null>(null);
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
  /** True only on the side that dialed — the caller logs call-history so
   *  both sides don't double-insert the started/ended system messages. */
  const isCallerRef = useRef(false);
  /** Guards the one-time "Call started" insert per connected call. */
  const startedLoggedRef = useRef(false);
  // GROUP CALLS: the live LiveKit room for the active group call. A call is
  // either 1:1 (pcRef, peer-to-peer) or a group (lkRef, SFU), never both.
  const lkRef = useRef<CallRoomHandle | null>(null);

  // GROUP CALLS: tell the SFU what this screen shows, so every video arrives
  // at the size it is displayed — a focused share at full quality, small
  // tiles small, hidden video not at all. Full view: the grid reports grid or
  // focus. Minimized: the floating tile shows the first participant only.
  const [gridLayout, setGroupLayout] = useState<GroupView>({ layout: "grid" });
  const firstPeerId = groupPeers[0]?.id ?? null;
  useEffect(() => {
    lkRef.current?.setView(
      view === "full" ? gridLayout : { layout: "mini", shownId: firstPeerId },
    );
    // groupPeers.length: re-apply once the call's first participants arrive.
  }, [view, gridLayout, firstPeerId, groupPeers.length]);
  /** True once at least one other person has been in this group call, so an
   *  empty room means "everyone left" rather than "nobody has joined yet". */
  const hadPeersRef = useRef(false);
  /** Debounces the empty-room check so a reconnect blip can't end a call. */
  const emptyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Calls this device is done with, and when. A group initiator keeps
   * re-inviting for the whole ring window (it ignores declines so the call
   * continues for everyone else), which would otherwise re-ring someone who
   * already said no — or who just left.
   *
   * Time-bounded on purpose: a permanent block would also swallow a
   * DELIBERATE re-invite from "add participant", so it only has to outlive
   * the resend window.
   */
  const declinedCallsRef = useRef<Map<string, number>>(new Map());
  /** True while the active/ringing call is a group call. */
  const groupRef = useRef(false);
  /** Whether the active group call is a video call (drives offer payloads). */
  const groupVideoRef = useRef(false);
  /** Full invited set (initiator + invitees) so leaving can also quiet an
   *  invitee who is still ringing (not yet a connected peer). */
  const groupMembersRef = useRef<string[]>([]);

  phaseRef.current = phase;
  incomingRef.current = incoming;
  callRef.current = call;

  /** True while late invites for a finished call should still be ignored. */
  const isCallDone = useCallback((callId: string) => {
    const now = Date.now();
    for (const [id, ts] of declinedCallsRef.current) {
      if (now - ts > DONE_CALL_TTL_MS) declinedCallsRef.current.delete(id);
    }
    const ts = declinedCallsRef.current.get(callId);
    return ts !== undefined && now - ts <= DONE_CALL_TTL_MS;
  }, []);

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

  /**
   * Ephemeral signaling rows are deleted once their call ends — but never
   * immediately. Purging the instant we hang up deleted the cancellation we
   * had just inserted, so a receiver whose realtime socket was mid-reconnect
   * never learned the call was over and kept ringing. Deleting a few seconds
   * later leaves the hangup long enough to be delivered.
   */
  const purgeSignals = useCallback(
    (callId: string | null) => {
      if (!callId) return;
      setTimeout(() => {
        void supabase
          .from("call_signals")
          .delete()
          .eq("call_id", callId)
          .then(() => undefined);
      }, PURGE_DELAY_MS);
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
      // Call history (#2): only the CALLER logs, and only for a call that
      // actually connected — a no-answer is already covered by the missed
      // call trace. connectedAtRef is nulled just below, so a re-entrant
      // cleanup (pc.close → connectionstatechange → hangup → cleanup) can
      // never double-insert this.
      if (isCallerRef.current && connectedAtRef.current && roomIdRef.current) {
        const durationS = Math.max(
          0,
          Math.round((Date.now() - connectedAtRef.current) / 1000),
        );
        void supabase.from("messages").insert({
          room_id: roomIdRef.current,
          sender_id: userId,
          kind: "text",
          body: `📞 Call ended · ${formatCallDuration(durationS)}`,
          metadata: { event: "call_ended", duration_s: durationS },
        });
      }
      if (dropTimerRef.current) {
        clearTimeout(dropTimerRef.current);
        dropTimerRef.current = null;
      }
      connectedAtRef.current = null;
      // Remember this call is over. The caller re-sends invites every few
      // seconds for the whole ring window, and those inserts race the single
      // hangup — without this, an invite landing just after the hangup finds
      // us back in "idle" with everything cleared, sails through every guard
      // and rings us again for a call that no longer exists.
      if (callIdRef.current) {
        declinedCallsRef.current.set(callIdRef.current, Date.now());
      }
      stopTones();
      // The pushed "Incoming call" pop-up has nothing else to clear it once
      // the call is answered, declined, missed or hung up.
      void dismissNotifications("call");
      if (opts?.purge) purgeSignals(callIdRef.current);
      pcRef.current?.close();
      pcRef.current = null;
      // GROUP CALLS: leave the LiveKit room. Null the ref FIRST so the
      // handle's onDisconnected callback recognises this as our own teardown
      // and doesn't loop back into hangup. Inert for a 1:1 call.
      {
        const handle = lkRef.current;
        lkRef.current = null;
        if (handle) void handle.disconnect();
      }
      groupRef.current = false;
      hadPeersRef.current = false;
      if (emptyTimerRef.current) {
        clearTimeout(emptyTimerRef.current);
        emptyTimerRef.current = null;
      }
      groupVideoRef.current = false;
      groupMembersRef.current = [];
      setGroupPeers([]);
      // Drop the persistent audio sink's stream so a torn-down call leaves
      // nothing playing (the element itself never unmounts).
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
      isCallerRef.current = false;
      startedLoggedRef.current = false;
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      cameraTrackRef.current = null;
      screenAddedSenderRef.current = false;
      stopEncoderWatchRef.current?.();
      stopEncoderWatchRef.current = null;
      screenParamsRef.current = null;
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
      setLobby(null);
      lobbyRef.current = null;
      joinPrefsRef.current = null;
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
    [clearTimers, purgeSignals, supabase, userId],
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
          // Call history (#2): the caller logs "Call started" once, the first
          // time ICE reaches connected. The callee never logs, so the pair of
          // system messages isn't double-inserted.
          if (isCallerRef.current && !startedLoggedRef.current && roomIdRef.current) {
            startedLoggedRef.current = true;
            void supabase.from("messages").insert({
              room_id: roomIdRef.current,
              sender_id: userId,
              kind: "text",
              body: "📞 Call started",
              metadata: { event: "call_started" },
            });
          }
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
      // FIX 1: connectionState changes fire on network/peer state and are NOT
      // subject to background-tab setTimeout throttling, so a hidden tab still
      // tears down (stops mic/camera, closes pc) the instant the peer closes
      // their connection — even when the realtime `hangup` row is delayed
      // while the tab is backgrounded. This is what keeps B's camera/mic LED
      // from staying on after A hangs up.
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === "failed" || s === "closed") {
          endCallRef.current?.();
        }
      };
      pcRef.current = pc;
      return pc;
    },
    [clearTimers, send, supabase, userId],
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
      // FIX 5: request mono + the full suppression trio explicitly. Mono keeps
      // voice constraints from being widened to a stereo track that some
      // browsers pass through with less processing.
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      // 1:1 only — group calls never reach here, LiveKit owns their capture
      // (see livekit-room.ts videoCaptureDefaults). Ask for a real 16:9 frame
      // rather than the browser's default (often 4:3): the call surfaces are
      // widescreen, so a 4:3 source had to be cropped, which is what looked
      // zoomed in.
      video: video
        ? {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 },
            aspectRatio: { ideal: 16 / 9 },
          }
        : false,
    });
    if (callGenRef.current !== gen) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("call ended");
    }
    localStreamRef.current = stream;
    cameraTrackRef.current = stream.getVideoTracks()[0] ?? null;
    // FIX 5: re-assert suppression on the live track for browsers that honor
    // runtime applyConstraints. Best-effort — never throw if unsupported.
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      try {
        await audioTrack.applyConstraints({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        });
      } catch {
        /* ignore — this browser doesn't honor runtime audio constraints */
      }
    }
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

  // ══════════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════════
  // GROUP CALLS — LiveKit (SFU)
  //
  // A group call no longer builds a peer connection to every other person.
  // Each participant publishes once to LiveKit's SFU and subscribes to the
  // rest, so there is no O(n²) uplink ceiling and no per-pair handshake that
  // can silently fail ("some people can't see each other").
  //
  // Ringing still rides call_signals (invite / hangup), so the incoming-call
  // overlay, push notifications and room permissions are unchanged — only the
  // media path moved. The 1:1 path further below is untouched and stays
  // peer-to-peer, which also keeps 1:1 calls off the LiveKit minute budget.
  // ══════════════════════════════════════════════════════════════════════

  /** Mirror LiveKit's participants into the grid state the UI already renders. */
  const applyLiveKitUpdate = useCallback(
    (payload: {
      participants: LiveKitParticipant[];
      localStream: MediaStream | null;
      localSharing: boolean;
    }) => {
      setGroupPeers(
        payload.participants.map((p) => ({
          id: p.id,
          name: p.name,
          stream: p.stream,
          hasVideo: p.hasVideo,
          muted: p.muted,
          sharing: p.sharing,
        })),
      );
      setLocalStream(payload.localStream);
      setSharing(payload.localSharing);
      if (payload.participants.length > 0) {
        hadPeersRef.current = true;
        if (emptyTimerRef.current) {
          clearTimeout(emptyTimerRef.current);
          emptyTimerRef.current = null;
        }
        // NOTE: deliberately does NOT clearTimers() — the initiator's re-ring
        // loop must keep running for people who haven't answered yet just
        // because the first person joined. Those timers expire on their own.
        stopTones();
        setStatusText("Connected");
        setConnectedAt((prev) => {
          const at = prev ?? Date.now();
          connectedAtRef.current = at;
          return at;
        });
      } else if (!connectedAtRef.current) {
        setStatusText("Waiting for others…");
      } else if (hadPeersRef.current && !emptyTimerRef.current) {
        // Everyone else has gone. A group call stays open while anyone is
        // still in it, but nobody should be left sitting alone in an empty
        // room — which is exactly how the "other participant stays stuck in
        // the call" report happened. Debounced so a reconnect blip can't end
        // a live call.
        setStatusText("Everyone left");
        emptyTimerRef.current = setTimeout(() => {
          emptyTimerRef.current = null;
          if (!groupRef.current) return;
          if ((lkRef.current?.room.remoteParticipants.size ?? 0) > 0) return;
          showNotice("Call ended");
          endCallRef.current?.();
        }, EMPTY_ROOM_GRACE_MS);
      }
    },
    [showNotice],
  );

  /**
   * Join this call's LiveKit room. The token is minted server-side and only
   * issued to a member of the conversation, so joining is permission-checked
   * there rather than trusted from the client.
   */
  const joinLiveKit = useCallback(
    async (roomId: string, callId: string, video: boolean, gen: number) => {
      const res = await createCallToken(roomId, callId);
      if (callGenRef.current !== gen) return false;
      if (!res.token || !res.url) {
        showNotice(res.error ?? "Could not join the call.");
        return false;
      }
      const { connectCallRoom } = await import("@/lib/call/livekit-room");
      if (callGenRef.current !== gen) return false;
      const prefs = joinPrefsRef.current ?? { mic: true, camera: video };
      joinPrefsRef.current = null;
      const handle = await connectCallRoom({
        url: res.url,
        token: res.token,
        video,
        micEnabled: prefs.mic,
        cameraEnabled: video && prefs.camera,
        onUpdate: applyLiveKitUpdate,
        onLocalMic: (isMuted) => setMuted(isMuted),
        onDisconnected: () => {
          // cleanup() nulls lkRef before disconnecting, so this only fires for
          // an unexpected drop — never as an echo of our own teardown.
          if (lkRef.current) endCallRef.current?.();
        },
      });
      if (callGenRef.current !== gen) {
        void handle.disconnect();
        return false;
      }
      lkRef.current = handle;

      // Call history: only the initiator logs, once.
      if (isCallerRef.current && !startedLoggedRef.current && roomIdRef.current) {
        startedLoggedRef.current = true;
        void supabase.from("messages").insert({
          room_id: roomIdRef.current,
          sender_id: userId,
          kind: "text",
          body: "📞 Call started",
          metadata: { event: "call_started" },
        });
      }
      return true;
    },
    [applyLiveKitUpdate, showNotice, supabase, userId],
  );

  /** Route one group-tagged signal. Returns nothing; never touches 1:1 state
   *  except the shared call refs it owns while a group call is active. */
  const handleGroupSignal = useCallback(
    async (row: SignalRow, p: SignalPayload) => {
      if (row.kind === "invite") {
        // A "joining" announcement was the mesh's peer-discovery handshake.
        // LiveKit does discovery itself, so it is now only noise — ignore it.
        if (p.joining) return;
        // Initial ring invite (mirror of the 1:1 invite guards).
        if (isCallDone(row.call_id)) return; // finished, or we said no
        if (Date.now() - Date.parse(row.created_at) > STALE_INVITE_MS) return;
        if (phaseRef.current !== "idle" && callIdRef.current !== row.call_id) {
          if (incomingRef.current?.callId !== row.call_id) {
            void send("decline", row.call_id, row.from_user, row.room_id, {
              group: true,
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
        groupRef.current = true;
        groupVideoRef.current = Boolean(p.video);
        setIncoming({
          callId: row.call_id,
          roomId: row.room_id,
          peerId: row.from_user,
          peerName: p.fromName ?? "Unknown caller",
          roomName: p.roomName ?? null,
          video: Boolean(p.video),
          group: true,
          memberIds: Array.isArray(p.members) ? p.members : [],
        });
        setPhase("ringing");
        if (readNotifyPrefs().calls) startRingtone();
        notify({
          title: "Incoming group call",
          body: `${p.fromName ?? "Someone"} started a call${p.roomName ? ` in ${p.roomName}` : ""}`,
          tag: "call",
          url: "/rooms/" + row.room_id,
          force: true,
        });
        if (ringTimerRef.current) clearTimeout(ringTimerRef.current);
        ringTimerRef.current = setTimeout(() => {
          if (phaseRef.current === "ringing" && !acceptedRef.current) cleanup();
        }, RING_TIMEOUT_CALLEE_MS);
        return;
      }

      // A hangup applies whether we are still ringing or already joined.
      if (row.kind === "hangup") {
        if (!groupRef.current || callIdRef.current !== row.call_id) return;
        groupMembersRef.current = groupMembersRef.current.filter(
          (id) => id !== row.from_user,
        );
        // Only the person who invited us ending things means the call is over
        // for us. hangupGroup fans its notice out to EVERY member, so without
        // this check any participant leaving a live call would stop a still
        // ringing invitee with a bogus "Missed call".
        if (!acceptedRef.current && row.from_user === peerIdRef.current) {
          if (phaseRef.current === "ringing") showNotice("Missed call");
          cleanup();
        }
        // Already joined: someone leaving is LiveKit's business — it removes
        // their tile on its own. Like any meeting, the room stays open until
        // YOU hang up, so a late joiner isn't locked out.
        return;
      }

      // offer/answer/ice were the mesh's signalling and no longer apply — the
      // SFU negotiates media itself. decline is intentionally ignored: a group
      // call continues with whoever joined.
    },
    [cleanup, isCallDone, send, showNotice],
  );

  const handleSignal = useCallback(
    async (row: SignalRow) => {
      // Own rows (from_user = me): only used to stop ringing when
      // another tab of mine answered or declined.
      if (row.from_user === userId) {
        const sp = row.payload ?? {};
        // GROUP CALLS: another of my tabs accepted (announced joining) or hung
        // up/declined this group call — this still-ringing tab should go quiet.
        if (
          sp.group &&
          phaseRef.current === "ringing" &&
          incomingRef.current?.callId === row.call_id &&
          !acceptedRef.current &&
          ((row.kind === "invite" && sp.joining) ||
            row.kind === "hangup" ||
            row.kind === "decline")
        ) {
          cleanup();
          return;
        }
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
        return;
      }

      if (row.to_user !== userId) return;
      const p = row.payload ?? {};

      // GROUP CALLS: any group-tagged signal is handled by the mesh path and
      // never falls through to the 1:1 logic below.
      if (p.group) {
        await handleGroupSignal(row, p);
        return;
      }

      if (row.kind === "invite") {
        if (isCallDone(row.call_id)) return; // finished, or we said no
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
        // FIX 4: honor the per-device "calls" mute. When calls are muted we
        // still show the incoming-call overlay (setIncoming above) — only the
        // ring tone is silenced. The outgoing ringback is left untouched.
        if (readNotifyPrefs().calls) startRingtone();
        // #8: desktop/mobile pop-up for the incoming call. CallProvider is
        // mounted app-wide, so this fires whatever section the app is on and
        // even when another tab/app is focused (force:true).
        notify({
          title: "Incoming call",
          body: `${p.fromName ?? "Someone"} is calling`,
          tag: "call",
          url: "/rooms/" + row.room_id,
          force: true,
        });
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
          // The other side is done with this call either way; its rows
          // have already been broadcast, so purging here is safe.
          cleanup({ purge: true });
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
            // Voice call + screen share: the screen's sender was added with
            // this offer, so its codecs only exist now — apply the screen
            // settings (see startScreenShare). It is removed on stop, so
            // there is nothing to restore.
            const screenTrack = screenStreamRef.current?.getVideoTracks()[0];
            const screenSender =
              screenAddedSenderRef.current && screenTrack
                ? pc.getSenders().find((x) => x.track === screenTrack)
                : undefined;
            if (screenSender) {
              const applied = await applyScreenShareParams(
                screenSender,
                SCREEN_SHARE_PROFILE.p2pMaxBitrate,
              );
              stopEncoderWatchRef.current ??= watchScreenShareEncoder(
                screenSender,
                applied?.codec,
              );
            }
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
    [answerOffer, answerRenegotiation, armConnectTimeout, cleanup, clearTimers, flushIce, handleGroupSignal, isCallDone, loadMissedIce, send, showNotice, userId],
  );

  handlingRef.current = handleSignal;

  /** GROUP CALLS: leave — tell every connected peer AND any still-invited
   *  member (so an invitee who is still ringing stops), then tear down. */
  const hangupGroup = useCallback(() => {
    const callId = callIdRef.current;
    const roomId = roomIdRef.current;
    // Leaving a group call is usually not final — the others may still be
    // talking — so keep the door open for a short while.
    if (callId && roomId && acceptedRef.current) {
      setRejoinable({
        callId,
        roomId,
        roomName: callRef.current?.peerName || "Group call",
        video: groupVideoRef.current,
      });
    }
    if (callId && roomId) {
      // Tell everyone we were ringing (or sitting in the room with) that we're
      // gone, so a still-ringing invitee stops. Participants already in the
      // LiveKit room see us leave through the SFU.
      for (const id of groupMembersRef.current) {
        if (id && id !== userId) {
          void send("hangup", callId, id, roomId, { group: true });
        }
      }
    }
    // No purge: the call_id's signal rows are shared by everyone in the call.
    cleanup();
  }, [cleanup, send, userId]);

  const hangup = useCallback(() => {
    if (groupRef.current) {
      hangupGroup();
      return;
    }
    if (callIdRef.current && peerIdRef.current && roomIdRef.current) {
      void send("hangup", callIdRef.current, peerIdRef.current, roomIdRef.current);
    }
    cleanup({ purge: true });
  }, [cleanup, hangupGroup, send]);

  // The ICE handler is created before hangup exists, so it ends calls
  // through this ref.
  endCallRef.current = hangup;


  const canManageCall = userRole === "admin" || userRole === "manager";

  /**
   * Ring someone into a call that is already running. The invite carries the
   * SAME call id, so accepting drops them into the same LiveKit room as
   * everyone else — no separate call, no renegotiation.
   */
  const addParticipant = useCallback(
    async (targetId: string) => {
      if (!canManageCall) return;
      const callId = callIdRef.current;
      const roomId = roomIdRef.current;
      if (!groupRef.current || !callId || !roomId) return;
      if (!targetId || targetId === userId) return;

      if (!groupMembersRef.current.includes(targetId)) {
        groupMembersRef.current = [...groupMembersRef.current, targetId];
      }
      await send("invite", callId, targetId, roomId, {
        group: true,
        video: groupVideoRef.current,
        fromName: userName,
        roomName: callRef.current?.peerName,
        members: groupMembersRef.current,
      });
      showNotice("Ringing them now");
    },
    [canManageCall, send, showNotice, userId, userName],
  );

  /** Evict someone mid-call. Only the LiveKit server API can do this. */
  const removeParticipant = useCallback(
    async (targetId: string) => {
      if (!canManageCall) return;
      const callId = callIdRef.current;
      const roomId = roomIdRef.current;
      if (!groupRef.current || !callId || !roomId) return;
      // Stop re-ringing them if they were still being invited.
      groupMembersRef.current = groupMembersRef.current.filter(
        (id) => id !== targetId,
      );
      void send("hangup", callId, targetId, roomId, { group: true });
      const res = await removeCallParticipant(roomId, callId, targetId);
      if (res.error) showNotice(res.error);
    },
    [canManageCall, send, showNotice],
  );

  /** Force-mute someone mid-call. LiveKit must do this server-side. */
  const muteParticipant = useCallback(
    async (targetId: string) => {
      if (!canManageCall) return;
      const callId = callIdRef.current;
      const roomId = roomIdRef.current;
      if (!groupRef.current || !callId || !roomId) return;
      const res = await muteCallParticipant(roomId, callId, targetId);
      if (res.error) showNotice(res.error);
    },
    [canManageCall, showNotice],
  );

  /** Rejoin the group call this device just left. */
  const rejoinCall = useCallback(async () => {
    const target = rejoinable;
    if (!target || phaseRef.current !== "idle") return;
    setRejoinable(null);

    callGenRef.current += 1;
    const gen = callGenRef.current;
    acceptedRef.current = true;
    isCallerRef.current = false; // rejoining never re-logs call history
    startedLoggedRef.current = true;
    groupRef.current = true;
    groupVideoRef.current = target.video;
    groupMembersRef.current = [];
    callIdRef.current = target.callId;
    roomIdRef.current = target.roomId;
    peerIdRef.current = null;
    // A fresh join, so the empty-room grace starts over and we wait for
    // others rather than ending immediately.
    hadPeersRef.current = false;
    setCall({
      callId: target.callId,
      roomId: target.roomId,
      peerId: "",
      peerName: target.roomName,
      video: target.video,
      group: true,
    });
    setPhase("in-call");
    setView("full");
    setStatusText("Rejoining…");
    const joined = await joinLiveKit(target.roomId, target.callId, target.video, gen);
    if (callGenRef.current !== gen) return;
    if (!joined) cleanup();
  }, [cleanup, joinLiveKit, rejoinable]);

  const dismissRejoin = useCallback(() => setRejoinable(null), []);

  // The offer to rejoin goes stale — by then the call is usually long over.
  useEffect(() => {
    if (!rejoinable) return;
    const t = setTimeout(() => setRejoinable(null), REJOIN_WINDOW_MS);
    return () => clearTimeout(t);
  }, [rejoinable]);

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
      setRejoinable(null);
      callGenRef.current += 1;
      const gen = callGenRef.current;

      const callId = crypto.randomUUID();
      callIdRef.current = callId;
      roomIdRef.current = roomId;
      peerIdRef.current = peer.id;
      acceptedRef.current = true;
      isCallerRef.current = true; // #2: this side logs call-history
      startedLoggedRef.current = false;
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

  /**
   * GROUP CALLS: start a full-mesh call inviting every other room member.
   * The initiator enters the call immediately (in-call, "Waiting for others…")
   * and rings each invitee; participants pair up via the presence handshake as
   * they accept. No-answer/decline from an invitee never ends the call.
   */
  const startGroupCall = useCallback(
    async (roomId: string, roomName: string, memberIds: string[], video: boolean) => {
      if (!signalReady) {
        showNotice("Still connecting — try again in a moment");
        return;
      }
      if (phaseRef.current !== "idle") return;

      // Ring EVERYONE currently in the room, not just the client-cached roster
      // the call button happened to hold. A member added after this tab last
      // synced its roster would otherwise be silently skipped — this is the
      // "call holds only N people, the next person's phone never rings" bug.
      // The fresh DB read is the source of truth; fall back to the passed list.
      let roster = memberIds;
      try {
        const { data } = await supabase
          .from("room_members")
          .select("user_id")
          .eq("room_id", roomId);
        if (data && data.length) {
          roster = [...memberIds, ...data.map((r) => r.user_id as string)];
        }
      } catch {
        /* network hiccup — keep the passed list rather than block the call */
      }
      const others = Array.from(
        new Set(roster.filter((id) => id && id !== userId)),
      );
      if (others.length === 0) {
        showNotice("No one else in this room to call");
        return;
      }

      setRejoinable(null);
      callGenRef.current += 1;
      const gen = callGenRef.current;

      const callId = crypto.randomUUID();
      const allMembers = [userId, ...others];
      callIdRef.current = callId;
      roomIdRef.current = roomId;
      peerIdRef.current = null;
      acceptedRef.current = true;
      isCallerRef.current = true; // logs call-history
      startedLoggedRef.current = false;
      groupRef.current = true;
      groupVideoRef.current = video;
      groupMembersRef.current = allMembers;
      setCall({
        callId,
        roomId,
        peerId: "",
        peerName: roomName,
        video,
        group: true,
        memberIds: allMembers,
      });
      // A group call is a room you are in from the moment you start it.
      setPhase("in-call");
      setView("full");
      setStatusText("Waiting for others…");

      try {
        // Join the SFU room first so we're present when people answer.
        const joined = await joinLiveKit(roomId, callId, video, gen);
        if (callGenRef.current !== gen) return; // FIX A
        if (!joined) {
          cleanup({ purge: true });
          return;
        }
        const invitePayload: SignalPayload = {
          group: true,
          video,
          roomName,
          fromName: userName,
          members: allMembers,
        };
        for (const id of others) {
          await send("invite", callId, id, roomId, invitePayload);
        }
        if (callGenRef.current !== gen) return; // FIX A

        // Re-ring until the window closes so a still-loading invitee still
        // hears it. Re-invites to someone already joined are harmless (they
        // return early). No hangup-on-timeout: the initiator waits.
        resendTimerRef.current = setInterval(() => {
          for (const id of others) void send("invite", callId, id, roomId, invitePayload);
        }, RESEND_MS);
        ringTimerRef.current = setTimeout(() => {
          if (resendTimerRef.current) {
            clearInterval(resendTimerRef.current);
            resendTimerRef.current = null;
          }
        }, RING_TIMEOUT_MS);
      } catch (err) {
        if (callGenRef.current !== gen) return; // FIX A: cleanup already ran
        showNotice(mediaErrorMessage(err));
        cleanup({ purge: true });
      }
    },
    [cleanup, joinLiveKit, send, showNotice, signalReady, supabase, userId, userName],
  );

  /** GROUP CALLS: accept a ringing group invite and join the call's room. */
  const groupAccept = useCallback(
    async (inc: IncomingCall) => {
      callGenRef.current += 1;
      const gen = callGenRef.current;
      acceptedRef.current = true;
      isCallerRef.current = false; // the callee never logs call-history
      startedLoggedRef.current = false;
      groupRef.current = true;
      groupVideoRef.current = inc.video;
      groupMembersRef.current = inc.memberIds ?? [];
      stopTones();
      void dismissNotifications("call");
      clearTimers();
      armConnectTimeout();
      callIdRef.current = inc.callId;
      roomIdRef.current = inc.roomId;
      peerIdRef.current = null;
      setCall({
        callId: inc.callId,
        roomId: inc.roomId,
        peerId: "",
        peerName: inc.roomName ?? "Group call",
        video: inc.video,
        group: true,
        memberIds: inc.memberIds,
      });
      setPhase("in-call");
      setView("full");
      setStatusText("Connecting…");
      setIncoming(null);
      try {
        // Joining the SFU room IS the whole handshake now — no presence
        // announcements, no per-peer offers. LiveKit surfaces whoever else
        // is already in the room.
        const joined = await joinLiveKit(inc.roomId, inc.callId, inc.video, gen);
        if (callGenRef.current !== gen) return; // FIX A
        if (!joined) {
          void send("decline", inc.callId, inc.peerId, inc.roomId, { group: true });
          cleanup();
        }
      } catch (err) {
        if (callGenRef.current !== gen) return; // FIX A: cleanup already ran
        const media = isMediaError(err);
        showNotice(mediaErrorMessage(err));
        // Tell the initiator (group-tagged so it's ignored, not treated as a
        // 1:1 hangup); the call continues for everyone else.
        void send(
          "decline",
          inc.callId,
          inc.peerId,
          inc.roomId,
          media ? { group: true, reason: "media" } : { group: true },
        );
        cleanup();
      }
    },
    [armConnectTimeout, cleanup, clearTimers, joinLiveKit, send, showNotice],
  );

  const accept = useCallback(async () => {
    const inc = incomingRef.current;
    if (!inc) return;
    // GROUP CALLS: a group invite takes the LiveKit accept path.
    if (inc.group) {
      await groupAccept(inc);
      return;
    }
    // FIX A: a new call begins here — bump the generation.
    callGenRef.current += 1;
    const gen = callGenRef.current;
    acceptedRef.current = true;
    isCallerRef.current = false; // #2: the callee never logs call-history
    startedLoggedRef.current = false;
    stopTones();
    // Clear the pushed "Incoming call" pop-up now that it's answered.
    void dismissNotifications("call");
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
  }, [answerOffer, armConnectTimeout, cleanup, clearTimers, getMedia, groupAccept, send, showNotice]);

  const decline = useCallback(() => {
    const inc = incomingRef.current;
    if (!inc) return;
    // GROUP CALLS: tag the decline so the initiator routes it to the group
    // handler (which ignores it) instead of the 1:1 path (which would end the
    // whole call). Declining a group call never ends it for the others.
    void send("decline", inc.callId, inc.peerId, inc.roomId, inc.group ? { group: true } : {});
    // Remember the refusal: a group initiator keeps re-inviting for the whole
    // ring window, which would otherwise ring us again seconds after we said no.
    declinedCallsRef.current.set(inc.callId, Date.now());
    pendingOfferRef.current = null;
    cleanup();
  }, [cleanup, send]);

  const prepareGroupCall = useCallback(
    (roomId: string, roomName: string, memberIds: string[]) => {
      if (phaseRef.current !== "idle") return;
      const next: GroupLobby = {
        intent: "outgoing",
        roomId,
        roomName,
        memberIds,
        video: true,
      };
      lobbyRef.current = next;
      setLobby(next);
    },
    [],
  );

  const openIncomingLobby = useCallback(() => {
    const inc = incomingRef.current;
    if (!inc?.group || !inc.video) {
      void accept();
      return;
    }
    const next: GroupLobby = {
      intent: "incoming",
      roomId: inc.roomId,
      roomName: inc.roomName ?? inc.peerName,
      memberIds: inc.memberIds ?? [],
      video: true,
    };
    lobbyRef.current = next;
    setLobby(next);
  }, [accept]);

  const cancelLobby = useCallback(() => {
    const L = lobbyRef.current;
    lobbyRef.current = null;
    joinPrefsRef.current = null;
    setLobby(null);
    if (L?.intent === "incoming") decline();
  }, [decline]);

  const confirmLobby = useCallback(
    async (prefs: { muted: boolean; camOff: boolean }) => {
      const L = lobbyRef.current;
      if (!L) return;
      joinPrefsRef.current = { mic: !prefs.muted, camera: !prefs.camOff };
      setMuted(prefs.muted);
      setCamOff(prefs.camOff);
      lobbyRef.current = null;
      setLobby(null);
      if (L.intent === "outgoing") {
        await startGroupCall(L.roomId, L.roomName, L.memberIds, true);
      } else {
        await accept();
      }
    },
    [accept, startGroupCall],
  );

  useEffect(() => {
    if (lobby?.intent === "incoming" && !incoming) {
      lobbyRef.current = null;
      joinPrefsRef.current = null;
      setLobby(null);
    }
  }, [lobby, incoming]);

  const toggleMic = useCallback(() => {
    const next = !muted;
    setMuted(next);
    // GROUP CALLS: LiveKit publishes its own capture — localStreamRef is
    // null there, so muting MUST go through the room or the microphone
    // keeps broadcasting while the UI claims it is muted.
    if (groupRef.current) {
      void lkRef.current?.setMic(!next);
    } else {
      localStreamRef.current?.getAudioTracks().forEach((t) => {
        t.enabled = !next;
      });
    }
  }, [muted]);

  const toggleCam = useCallback(() => {
    setCamOff((prev) => {
      const next = !prev;
      if (groupRef.current) {
        void lkRef.current?.setCamera(!next);
        return next;
      }
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
    // GROUP CALLS: LiveKit owns microphone capture and applies its own audio
    // processing, so re-acquiring the track here would fight it. The 1:1 path
    // below still hot-swaps its own track.
    if (groupRef.current) return;
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
        // Swap the fresh audio onto the outgoing sender (1:1 path only —
        // LiveKit owns capture for group calls, see the guard in toggleNoise).
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
    stopEncoderWatchRef.current?.();
    stopEncoderWatchRef.current = null;
    const screenParams = screenParamsRef.current;
    screenParamsRef.current = null;

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
          // replaceTrack keeps the sender's settings: without this the camera
          // would carry on at 15 fps / screen bitrate / maybe AV1.
          if (screenParams?.sender === videoSender) {
            await restoreSenderParams(videoSender, screenParams.saved);
          }
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
      // Capped at 2560×1440 / 15 fps (lib/call/screen-share explains why)
      // and still hinting "Entire Screen" in the browser's own picker.
      const screen = await navigator.mediaDevices.getDisplayMedia(
        displayMediaOptions(),
      );
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

      setSharing(true);
      refreshLocalPreview(screenTrack);

      const videoSender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (videoSender) {
        if (videoSender.track && videoSender.track !== cameraTrackRef.current) {
          // Keep the original camera for restore if we somehow replaced already.
        } else if (videoSender.track) {
          cameraTrackRef.current = videoSender.track;
        }
        // Screen settings BEFORE the swap, so the first screen keyframe is
        // already encoded with them.
        const saved = await applyScreenShareParams(
          videoSender,
          SCREEN_SHARE_PROFILE.p2pMaxBitrate,
        );
        if (saved) screenParamsRef.current = { sender: videoSender, saved };
        await videoSender.replaceTrack(screenTrack);
        stopEncoderWatchRef.current = watchScreenShareEncoder(
          videoSender,
          saved?.codec,
        );
        screenAddedSenderRef.current = false;
      } else {
        pc.addTrack(screenTrack, screen);
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
    } catch (err) {
      // User cancelled the picker — not an error worth surfacing.
      if (err instanceof DOMException && err.name === "NotAllowedError") return;
      showNotice(err instanceof Error ? err.message : "Could not share screen");
    }
  }, [refreshLocalPreview, send, showNotice, stopScreenShare]);

  // GROUP CALLS: screen share is one call on the LiveKit participant — the SFU
  // republishes it to everyone, so there is no per-peer renegotiation to do.
  // One shared screen at a time: a second share is unreadable next to the
  // first, and every extra share is another full-size stream for all ~40
  // viewers (big meetings used to crash when many people shared at once).
  const toggleScreenShare = useCallback(async () => {
    if (groupRef.current) {
      const handle = lkRef.current;
      if (!handle) return;
      if (!sharing) {
        const presenter = groupPeers.find((p) => p.sharing);
        if (presenter) {
          showNotice(`${presenter.name} is already sharing — one screen at a time.`);
          return;
        }
      }
      const on = await handle.setScreenShare(!sharing);
      setSharing(on);
      return;
    }
    if (screenStreamRef.current) {
      await stopScreenShare();
    } else {
      await startScreenShare();
    }
  }, [sharing, groupPeers, showNotice, startScreenShare, stopScreenShare]);

  // One global signaling channel for the whole session.
  useEffect(() => {
    installAutoResume();
    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    // FIX 1: releasing the camera/mic must never depend on a throttled timer
    // or a realtime signal arriving. Navigating away or closing the tab
    // always tears the call down so the OS device LEDs go off. NOTE: this is
    // pagehide/beforeunload only — deliberately NOT visibilitychange, since a
    // backgrounded tab is a normal ongoing call and must keep running.
    const releaseOnUnload = () => cleanup();
    window.addEventListener("pagehide", releaseOnUnload);
    window.addEventListener("beforeunload", releaseOnUnload);

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
      window.removeEventListener("pagehide", releaseOnUnload);
      window.removeEventListener("beforeunload", releaseOnUnload);
      if (channel) void supabase.removeChannel(channel);
      cleanup();
    };
    // Stable subscribe — handler goes through handlingRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, userId]);

  const value = useMemo<CallContextValue>(
    () => ({
      selfId: userId,
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
      groupPeers,
      canManageCall,
      addParticipant,
      removeParticipant,
      muteParticipant,
      rejoinable,
      rejoinCall,
      dismissRejoin,
      dial,
      startGroupCall,
      prepareGroupCall,
      openIncomingLobby,
      lobby,
      confirmLobby,
      cancelLobby,
      accept,
      decline,
      hangup,
      toggleMic,
      toggleCam,
      toggleNoise,
      toggleScreenShare,
      setView,
      setGroupLayout,
    }),
    [
      userId,
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
      groupPeers,
      canManageCall,
      addParticipant,
      removeParticipant,
      muteParticipant,
      rejoinable,
      rejoinCall,
      dismissRejoin,
      dial,
      startGroupCall,
      prepareGroupCall,
      openIncomingLobby,
      lobby,
      confirmLobby,
      cancelLobby,
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
          navigation and minimize/expand. (1:1 path.) */}
      <audio ref={remoteAudioRef} autoPlay className="hidden" />
      {/* GROUP CALLS: persistent per-peer audio sinks, same rationale. */}
      <PeerAudioSinks />
      {incoming && phase === "ringing" && !lobby && <IncomingCallOverlay />}
      {lobby && <CallLobby />}
      {onCall && (view === "full" ? <FullScreenCall /> : <FloatingCallTile />)}
      {notice && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-20 left-1/2 z-[130] -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-white shadow-lg"
        >
          {notice}
        </div>
      )}
      {/* Left a group call? The others may still be talking, so offer a way
          back in rather than making them ring you again. */}
      {rejoinable && phase === "idle" && (
        <div className="fixed bottom-24 left-1/2 z-[130] flex -translate-x-1/2 items-center gap-3 rounded-full border border-line/70 bg-paper px-3 py-2 shadow-lg sm:bottom-6">
          <span className="max-w-[40vw] truncate text-[13px] text-ink">
            Left {rejoinable.roomName}
          </span>
          <button
            type="button"
            onClick={() => void rejoinCall()}
            className="rounded-full bg-brand-600 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-brand-700"
          >
            Rejoin
          </button>
          <button
            type="button"
            onClick={dismissRejoin}
            aria-label="Dismiss"
            className="rounded-full p-1 text-muted hover:bg-mist"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </CallContext.Provider>
  );
}

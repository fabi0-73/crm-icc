"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { Avatar } from "@/components/Avatar";
import { ensureRealtimeAuth } from "@/lib/supabase/realtime";

type CallMember = {
  id: string;
  full_name: string;
};

type SignalPayload = {
  type: "invite" | "offer" | "answer" | "ice" | "hangup" | "decline";
  callId: string;
  from: string;
  to: string;
  fromName?: string;
  video?: boolean;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

function iceServers(): RTCIceServer[] {
  const turnHost = process.env.NEXT_PUBLIC_TURN_HOST || "72.62.42.52";
  const turnUser = process.env.NEXT_PUBLIC_TURN_USER || "icc";
  const turnPass = process.env.NEXT_PUBLIC_TURN_PASS || "IccTurn2026!";
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: [
        `turn:${turnHost}:3478?transport=udp`,
        `turn:${turnHost}:3478?transport=tcp`,
      ],
      username: turnUser,
      credential: turnPass,
    },
  ];
}

/** Wait until ICE candidates are in the local SDP (avoids lost trickle races). */
function waitForIceGathering(pc: RTCPeerConnection, timeoutMs = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    pc.addEventListener("icegatheringstatechange", onChange);
    setTimeout(done, timeoutMs);
  });
}

export function CallControls({
  supabase,
  roomId,
  currentUserId,
  currentUserName,
  members,
}: {
  supabase: SupabaseClient;
  roomId: string;
  currentUserId: string;
  currentUserName: string;
  members: CallMember[];
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [incoming, setIncoming] = useState<SignalPayload | null>(null);
  const [active, setActive] = useState<{
    callId: string;
    peerId: string;
    peerName: string;
    video: boolean;
  } | null>(null);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [noiseOff, setNoiseOff] = useState(false);
  const [status, setStatus] = useState("");
  const [signalReady, setSignalReady] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const callIdRef = useRef<string | null>(null);
  const pendingOfferRef = useRef<SignalPayload | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const acceptedRef = useRef(false);
  const remoteSetRef = useRef(false);
  const answeredCallIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const inviteTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const handlingRef = useRef<((msg: SignalPayload) => Promise<void>) | null>(
    null,
  );

  const others = members.filter((m) => m.id !== currentUserId);
  const secure =
    typeof window === "undefined" ||
    window.isSecureContext ||
    location.hostname === "localhost";

  const stopRinging = useCallback(() => {
    if (inviteTimerRef.current) {
      clearInterval(inviteTimerRef.current);
      inviteTimerRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    stopRinging();
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    callIdRef.current = null;
    peerIdRef.current = null;
    pendingOfferRef.current = null;
    pendingIceRef.current = [];
    acceptedRef.current = false;
    remoteSetRef.current = false;
    answeredCallIdRef.current = null;
    setActive(null);
    setIncoming(null);
    setStatus("");
    setMuted(false);
    setCamOff(false);
    setNoiseOff(false);
  }, [stopRinging]);

  /** Reliable signaling via Postgres + Realtime (same path as chat). */
  const send = useCallback(
    async (payload: SignalPayload) => {
      const { error } = await supabase.from("call_signals").insert({
        room_id: roomId,
        call_id: payload.callId,
        from_user: payload.from,
        to_user: payload.to,
        kind: payload.type,
        payload: {
          fromName: payload.fromName,
          video: payload.video,
          sdp: payload.sdp,
          candidate: payload.candidate,
        },
      });
      if (error) console.warn("call signal insert failed", error.message);
    },
    [roomId, supabase],
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
        .eq("to_user", currentUserId)
        .eq("kind", "ice")
        .order("created_at", { ascending: true });
      if (error || !data) return;
      for (const row of data) {
        const candidate = (row.payload as { candidate?: RTCIceCandidateInit })
          ?.candidate;
        if (candidate) pendingIceRef.current.push(candidate);
      }
      await flushIce();
    },
    [currentUserId, flushIce, supabase],
  );

  const ensurePc = useCallback(
    (peerId: string) => {
      if (pcRef.current) return pcRef.current;
      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      pc.onicecandidate = (e) => {
        if (!e.candidate || !callIdRef.current) return;
        void send({
          type: "ice",
          callId: callIdRef.current,
          from: currentUserId,
          to: peerId,
          candidate: e.candidate.toJSON(),
        });
      };
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = stream;
          void remoteVideoRef.current.play().catch(() => undefined);
        }
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = stream;
          void remoteAudioRef.current.play().catch(() => undefined);
        }
      };
      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        if (s === "connected" || s === "completed") {
          stopRinging();
          setStatus("Connected");
        } else if (s === "checking") {
          setStatus("Connecting…");
        } else if (s === "failed") {
          setStatus("Connection failed — hang up and retry");
        }
      };
      pcRef.current = pc;
      return pc;
    },
    [currentUserId, send, stopRinging],
  );

  const getMedia = useCallback(async (video: boolean) => {
    if (!window.isSecureContext && location.hostname !== "localhost") {
      throw new Error(
        "Calls need HTTPS. Open https://iccdesk.duckdns.org (accept the warning).",
      );
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
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    return stream;
  }, []);

  const answerOffer = useCallback(
    async (offerMsg: SignalPayload) => {
      if (!offerMsg.sdp) return;
      if (
        answeredCallIdRef.current === offerMsg.callId ||
        remoteSetRef.current
      ) {
        return;
      }
      const pc = ensurePc(offerMsg.from);
      if (pc.currentRemoteDescription || pc.signalingState !== "stable") return;

      const video = Boolean(offerMsg.video);
      if (!localStreamRef.current) await getMedia(video);
      const stream = localStreamRef.current!;
      for (const track of stream.getTracks()) {
        if (!pc.getSenders().some((s) => s.track?.id === track.id)) {
          pc.addTrack(track, stream);
        }
      }
      await pc.setRemoteDescription(offerMsg.sdp);
      remoteSetRef.current = true;
      answeredCallIdRef.current = offerMsg.callId;
      await loadMissedIce(offerMsg.callId);
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc);
      const finalAnswer = pc.localDescription ?? answer;
      await send({
        type: "answer",
        callId: offerMsg.callId,
        from: currentUserId,
        to: offerMsg.from,
        sdp: {
          type: finalAnswer.type,
          sdp: finalAnswer.sdp,
        },
      });
      setStatus("Connecting…");
      setIncoming(null);
    },
    [currentUserId, ensurePc, flushIce, getMedia, loadMissedIce, send],
  );

  const handleSignal = useCallback(
    async (msg: SignalPayload) => {
      if (msg.to !== currentUserId) return;

      if (msg.type === "invite") {
        if (!acceptedRef.current) setIncoming(msg);
        return;
      }
      if (msg.type === "decline" || msg.type === "hangup") {
        if (!callIdRef.current || callIdRef.current === msg.callId) cleanup();
        return;
      }
      if (msg.type === "offer" && msg.sdp) {
        if (answeredCallIdRef.current !== msg.callId) {
          pendingOfferRef.current = msg;
        }
        if (!acceptedRef.current) {
          setIncoming((prev) => prev ?? msg);
          return;
        }
        if (answeredCallIdRef.current === msg.callId || remoteSetRef.current) {
          return;
        }
        try {
          await answerOffer(msg);
        } catch (err) {
          setStatus(err instanceof Error ? err.message : "Call failed");
        }
        return;
      }
      if (msg.type === "answer" && msg.sdp && pcRef.current) {
        try {
          stopRinging();
          if (
            !remoteSetRef.current &&
            !pcRef.current.currentRemoteDescription &&
            pcRef.current.signalingState === "have-local-offer"
          ) {
            remoteSetRef.current = true;
            await pcRef.current.setRemoteDescription(msg.sdp);
            await loadMissedIce(msg.callId);
            await flushIce();
          }
          setStatus("Connecting…");
        } catch (err) {
          setStatus(err instanceof Error ? err.message : "Answer failed");
        }
        return;
      }
      if (msg.type === "ice" && msg.candidate) {
        if (pcRef.current?.remoteDescription) {
          try {
            await pcRef.current.addIceCandidate(msg.candidate);
          } catch {
            /* ignore */
          }
        } else {
          pendingIceRef.current.push(msg.candidate);
        }
      }
    },
    [answerOffer, cleanup, currentUserId, flushIce, loadMissedIce, stopRinging],
  );

  handlingRef.current = handleSignal;

  const hangup = useCallback(
    (notifyPeer = true) => {
      if (notifyPeer && callIdRef.current && peerIdRef.current) {
        void send({
          type: "hangup",
          callId: callIdRef.current,
          from: currentUserId,
          to: peerIdRef.current,
        });
      }
      cleanup();
    },
    [cleanup, currentUserId, send],
  );

  const startCall = useCallback(
    async (peer: CallMember, video: boolean) => {
      if (!signalReady) {
        setStatus("Still connecting…");
        return;
      }
      setPickerOpen(false);
      const callId = crypto.randomUUID();
      callIdRef.current = callId;
      peerIdRef.current = peer.id;
      acceptedRef.current = true;
      setActive({
        callId,
        peerId: peer.id,
        peerName: peer.full_name,
        video,
      });
      setStatus("Calling… (keep this chat open on both phones)");

      try {
        const stream = await getMedia(video);
        const pc = ensurePc(peer.id);
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));

        const invite: SignalPayload = {
          type: "invite",
          callId,
          from: currentUserId,
          to: peer.id,
          fromName: currentUserName,
          video,
        };
        await send(invite);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        // Embed candidates in SDP so late accept still has a full offer
        await waitForIceGathering(pc);
        const finalOffer = pc.localDescription ?? offer;
        const offerMsg: SignalPayload = {
          type: "offer",
          callId,
          from: currentUserId,
          to: peer.id,
          fromName: currentUserName,
          sdp: {
            type: finalOffer.type,
            sdp: finalOffer.sdp,
          },
          video,
        };
        await send(offerMsg);

        // Re-send invite + full offer until answered
        inviteTimerRef.current = setInterval(() => {
          if (remoteSetRef.current || pcRef.current?.connectionState === "connected") {
            stopRinging();
            return;
          }
          void send(invite);
          void send(offerMsg);
        }, 3000);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : "Could not start call");
        cleanup();
      }
    },
    [
      cleanup,
      currentUserId,
      currentUserName,
      ensurePc,
      getMedia,
      send,
      signalReady,
      stopRinging,
    ],
  );

  const acceptIncoming = useCallback(async () => {
    if (!incoming) return;
    acceptedRef.current = true;
    callIdRef.current = incoming.callId;
    peerIdRef.current = incoming.from;
    setActive({
      callId: incoming.callId,
      peerId: incoming.from,
      peerName: incoming.fromName ?? "Caller",
      video: Boolean(incoming.video),
    });
    setStatus("Connecting…");
    try {
      await getMedia(Boolean(incoming.video));
      const pending = pendingOfferRef.current;
      if (pending && pending.callId === incoming.callId) {
        await answerOffer(pending);
        pendingOfferRef.current = null;
      } else {
        setStatus("Waiting for call data…");
      }
      setIncoming(null);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Microphone blocked");
      void send({
        type: "decline",
        callId: incoming.callId,
        from: currentUserId,
        to: incoming.from,
      });
      cleanup();
    }
  }, [answerOffer, cleanup, currentUserId, getMedia, incoming, send]);

  const declineIncoming = useCallback(() => {
    if (!incoming) return;
    void send({
      type: "decline",
      callId: incoming.callId,
      from: currentUserId,
      to: incoming.from,
    });
    pendingOfferRef.current = null;
    setIncoming(null);
  }, [currentUserId, incoming, send]);

  useEffect(() => {
    let cancelled = false;
    let channel: RealtimeChannel | null = null;

    (async () => {
      await ensureRealtimeAuth(supabase);
      if (cancelled) return;

      channel = supabase
        .channel(`call-db:${roomId}:${currentUserId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "call_signals",
            filter: `to_user=eq.${currentUserId}`,
          },
          (payload) => {
            const row = payload.new as {
              call_id: string;
              from_user: string;
              to_user: string;
              kind: SignalPayload["type"];
              payload: {
                fromName?: string;
                video?: boolean;
                sdp?: RTCSessionDescriptionInit;
                candidate?: RTCIceCandidateInit;
              };
            };
            // Only handle signals for this room
            const room = (payload.new as { room_id?: string }).room_id;
            if (room && room !== roomId) return;

            const msg: SignalPayload = {
              type: row.kind,
              callId: row.call_id,
              from: row.from_user,
              to: row.to_user,
              fromName: row.payload?.fromName,
              video: row.payload?.video,
              sdp: row.payload?.sdp,
              candidate: row.payload?.candidate,
            };
            void handlingRef.current?.(msg);
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") setSignalReady(true);
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            setSignalReady(false);
            setStatus("Call link lost — refresh the page");
          }
        });

      channelRef.current = channel;
    })();

    return () => {
      cancelled = true;
      setSignalReady(false);
      if (channel) void supabase.removeChannel(channel);
      channelRef.current = null;
      cleanup();
    };
    // Stable subscribe — handlers via ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, currentUserId, supabase]);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    localStreamRef.current?.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
  }

  function toggleCam() {
    const next = !camOff;
    setCamOff(next);
    localStreamRef.current?.getVideoTracks().forEach((t) => {
      t.enabled = !next;
    });
  }

  async function toggleNoise() {
    const next = !noiseOff;
    setNoiseOff(next);
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        echoCancellation: true,
        noiseSuppression: !next,
        autoGainControl: true,
      });
    } catch {
      // Some browsers only honor these at getUserMedia time
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className="rounded-full p-2 text-muted hover:bg-black/5"
        aria-label="Call"
        title={signalReady ? "Call" : "Connecting…"}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1L6.6 10.8z" />
        </svg>
      </button>

      {pickerOpen && (
        <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close"
            onClick={() => setPickerOpen(false)}
          />
          <div className="relative z-10 w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-[16px] font-semibold text-ink">Call</h2>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="text-sm text-muted"
              >
                Close
              </button>
            </div>
            {!secure && (
              <p className="mx-4 mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
                Use{" "}
                <a className="underline font-medium" href="https://iccdesk.duckdns.org">
                  https://iccdesk.duckdns.org
                </a>{" "}
                for calls (mic blocked on HTTP).
              </p>
            )}
            <p className="px-4 pt-3 text-[12px] text-muted">
              Both must have this same chat open, then call.
            </p>
            <ul className="max-h-[60vh] overflow-y-auto py-1">
              {others.map((m) => (
                <li
                  key={m.id}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-mist"
                >
                  <Avatar name={m.full_name} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">
                    {m.full_name}
                  </span>
                  <button
                    type="button"
                    disabled={!signalReady || !secure}
                    onClick={() => void startCall(m, false)}
                    className="rounded-full bg-brand-600 p-2.5 text-white disabled:opacity-40"
                    aria-label={`Voice call ${m.full_name}`}
                    title="Voice"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1L6.6 10.8z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    disabled={!signalReady || !secure}
                    onClick={() => void startCall(m, true)}
                    className="rounded-full bg-ink-soft p-2.5 text-white disabled:opacity-40"
                    aria-label={`Video call ${m.full_name}`}
                    title="Video"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17 10.5V7c0-.6-.4-1-1-1H4c-.6 0-1 .4-1 1v10c0 .6.4 1 1 1h12c.6 0 1-.4 1-1v-3.5l4 4v-11l-4 4z" />
                    </svg>
                  </button>
                </li>
              ))}
              {others.length === 0 && (
                <li className="px-4 py-8 text-center text-sm text-muted">
                  No one else in this room
                </li>
              )}
            </ul>
          </div>
        </div>
      )}

      {incoming && !active && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-xs rounded-2xl bg-white p-6 text-center shadow-xl">
            <Avatar name={incoming.fromName ?? "Caller"} size="lg" className="mx-auto" />
            <p className="mt-3 text-lg font-semibold text-ink">
              {incoming.fromName ?? "Someone"}
            </p>
            <p className="text-sm text-muted">
              Incoming {incoming.video ? "video" : "voice"} call
            </p>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={declineIncoming}
                className="flex-1 rounded-full bg-red-500 py-2.5 text-sm font-semibold text-white"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => void acceptIncoming()}
                className="flex-1 rounded-full bg-brand-600 py-2.5 text-sm font-semibold text-white"
              >
                Accept
              </button>
            </div>
          </div>
        </div>
      )}

      {active && (
        <div className="fixed inset-0 z-[110] flex flex-col bg-ink text-white">
          <div className="flex items-center justify-between px-4 py-4">
            <div>
              <p className="text-xs text-white/50">
                {active.video ? "Video" : "Voice"} · {status || "…"}
              </p>
              <p className="text-xl font-semibold">{active.peerName}</p>
            </div>
            <button
              type="button"
              onClick={() => hangup(true)}
              className="rounded-full bg-red-500 px-4 py-2 text-sm font-semibold"
            >
              End
            </button>
          </div>

          <div className="relative flex-1 min-h-0 bg-ink-soft">
            {active.video ? (
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
                  className="absolute bottom-4 right-4 h-36 w-28 rounded-xl object-cover border border-white/20"
                />
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3">
                <Avatar name={active.peerName} size="lg" />
                <p className="text-white/70">{status || "Connecting…"}</p>
                <audio ref={remoteAudioRef} autoPlay />
              </div>
            )}
            {!active.video && (
              <video ref={localVideoRef} className="hidden" muted autoPlay playsInline />
            )}
            {active.video && (
              <audio ref={remoteAudioRef} autoPlay className="hidden" />
            )}
          </div>

          <div className="flex items-center justify-center gap-5 px-4 py-6">
            <button
              type="button"
              onClick={toggleMute}
              className={`rounded-full px-4 py-3 text-sm font-medium ${muted ? "bg-white text-ink" : "bg-white/15"}`}
            >
              {muted ? "Unmute" : "Mute"}
            </button>
            <button
              type="button"
              onClick={() => void toggleNoise()}
              className={`rounded-full px-4 py-3 text-sm font-medium ${noiseOff ? "bg-white/15" : "bg-white text-ink"}`}
              title="Noise cancellation"
            >
              {noiseOff ? "Noise off" : "Noise on"}
            </button>
            {active.video && (
              <button
                type="button"
                onClick={toggleCam}
                className={`rounded-full px-4 py-3 text-sm font-medium ${camOff ? "bg-white text-ink" : "bg-white/15"}`}
              >
                {camOff ? "Cam on" : "Cam off"}
              </button>
            )}
            <button
              type="button"
              onClick={() => hangup(true)}
              className="rounded-full bg-red-500 px-5 py-3 text-sm font-semibold"
            >
              Hang up
            </button>
          </div>
        </div>
      )}
    </>
  );
}

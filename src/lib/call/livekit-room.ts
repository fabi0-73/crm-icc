"use client";

/**
 * LiveKit group-call transport.
 *
 * Replaces the hand-rolled full mesh for group calls: every participant sends
 * one copy of their media to LiveKit's SFU and receives the others back,
 * instead of building a peer connection to every other person. That removes
 * the O(n²) uplink ceiling and the whole class of "one pair never connected"
 * failures — there are no pairings left to fail.
 *
 * Ringing/invites are NOT handled here; those stay on call_signals so the
 * incoming-call UX, notifications and permissions are unchanged. This module
 * only moves the media.
 *
 * Participants are surfaced as { id, name, stream, hasVideo, muted, sharing }
 * — the shape CallGrid renders — and each participant keeps a STABLE
 * MediaStream across updates so <video> elements aren't torn down and
 * re-bound on every track change.
 */

import {
  Room,
  RoomEvent,
  Track,
  VideoQuality,
  type ParticipantTrackPermission,
  type RemoteParticipant,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
} from "livekit-client";
import {
  SCREEN_SHARE_PROFILE,
  capsBreakCapture,
  planGroupVideo,
  type GroupView,
  type LayerChoice,
} from "@/lib/call/screen-share";

export type LiveKitParticipant = {
  id: string;
  name: string;
  stream: MediaStream;
  hasVideo: boolean;
  muted: boolean;
  sharing: boolean;
};

export type CallRoomHandle = {
  room: Room;
  setMic: (on: boolean) => Promise<void>;
  setCamera: (on: boolean) => Promise<void>;
  /** Returns the resulting state (false if the user cancelled the picker). */
  setScreenShare: (on: boolean) => Promise<boolean>;
  /** What the viewer's screen shows, so each video is fetched at the size
   *  it is displayed (see planGroupVideo). */
  setView: (view: GroupView) => void;
  /** This person's microphone, for mixing into a local recording. */
  micTrack: () => MediaStreamTrack | null;
  /** Tell everyone in the call (and anyone who joins) that we record. */
  setRecording: (on: boolean) => void;
  disconnect: () => Promise<void>;
};

type UpdatePayload = {
  participants: LiveKitParticipant[];
  localStream: MediaStream | null;
  localSharing: boolean;
};

type Pub = {
  kind: Track.Kind;
  source?: Track.Source;
  isMuted: boolean;
  track?: { mediaStreamTrack?: MediaStreamTrack };
};

/** Mirror a participant's published tracks into one long-lived MediaStream. */
function syncStream(
  key: string,
  publications: Pub[],
  cache: Map<string, MediaStream>,
): { stream: MediaStream; hasVideo: boolean; muted: boolean; sharing: boolean } {
  let stream = cache.get(key);
  if (!stream) {
    stream = new MediaStream();
    cache.set(key, stream);
  }

  const wanted = new Map<string, MediaStreamTrack>();
  const audioPubs = publications.filter((p) => p.kind === Track.Kind.Audio);
  const muted =
    audioPubs.length > 0 && audioPubs.every((p) => p.isMuted);
  const sharing = publications.some(
    (p) =>
      p.source === Track.Source.ScreenShare &&
      p.track?.mediaStreamTrack?.readyState === "live",
  );

  for (const pub of publications) {
    if (pub.kind !== Track.Kind.Audio) continue;
    const mst = pub.track?.mediaStreamTrack;
    if (!mst) continue;
    wanted.set(mst.id, mst);
  }

  const videos = publications.filter(
    (p) => p.kind === Track.Kind.Video && p.track?.mediaStreamTrack,
  );
  const screen = videos.find((p) => p.source === Track.Source.ScreenShare);
  const liveCam = videos.find(
    (p) =>
      p.source !== Track.Source.ScreenShare &&
      p.track?.mediaStreamTrack?.readyState === "live",
  );
  // Screen wins so the <video> element is not stuck on the camera track.
  // A live screen counts even while LiveKit still reports the pub muted
  // (common until the first frame).
  const display = screen ?? liveCam ?? videos[0];
  if (display?.track?.mediaStreamTrack) {
    wanted.set(
      display.track.mediaStreamTrack.id,
      display.track.mediaStreamTrack,
    );
  }
  const hasVideo = Boolean(
    display?.track?.mediaStreamTrack &&
      display.track.mediaStreamTrack.readyState === "live",
  );

  for (const t of stream.getTracks()) {
    if (!wanted.has(t.id)) stream.removeTrack(t);
  }
  for (const t of wanted.values()) {
    if (!stream.getTracks().some((x) => x.id === t.id)) stream.addTrack(t);
  }
  return { stream, hasVideo, muted, sharing };
}

function publicationsOf(p: RemoteParticipant): Pub[] {
  const out: Pub[] = [];
  p.trackPublications.forEach((pub) => {
    out.push({
      kind: pub.kind,
      source: pub.source,
      isMuted: pub.isMuted,
      track: pub.track
        ? { mediaStreamTrack: pub.track.mediaStreamTrack }
        : undefined,
    });
  });
  return out;
}

/**
 * Screen-share capture: the shared profile, as LiveKit options. "detail"
 * tells the encoder this is text/UI, not motion.
 */
export function screenShareCaptureOptions(): ScreenShareCaptureOptions {
  const p = SCREEN_SHARE_PROFILE;
  return {
    ...(capsBreakCapture()
      ? {}
      : {
          resolution: {
            width: p.maxWidth,
            height: p.maxHeight,
            frameRate: p.maxFramerate,
          },
        }),
    contentHint: "detail",
    audio: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
  };
}

/**
 * Screen-share publishing: ONE layer in H.264, small until someone
 * enlarges it.
 *
 * Small by default (SCREEN_SMALL: half size, 8 fps, ≤0.6 Mbps): a wall of
 * screens shows each one a few hundred pixels wide, and every sharer
 * sending full 1080p at up to 4 Mbps saturated the office upload — the
 * server logged dozens of upload-loss events in one call, and voices broke
 * up with it — while weak laptops spent their processor encoding it. When
 * an admin or manager enlarges a screen, their browser asks that sharer for
 * full size (see the "screen-stage" messages in connectCallRoom), and the
 * same single layer is switched up in place.
 *
 * One layer because the ask is a constant 1080p: with simulcast the browser
 * fills the small layers first, so a sharer whose uplink or CPU could not
 * carry all three starved the 1080p one for everybody at once.
 *
 * H.264 because of what it costs everyone else. The 1080p change went out
 * in VP8, and a day later people reported 100% CPU and "Aw, Snap!" crashes:
 * almost no PC decodes VP8 on its graphics chip, so every visible 1080p
 * share was a software decode (~17 ms of CPU a frame, measured), multiplied
 * by every screen on the wall. H.264 is decoded in hardware on nearly every
 * PC and phone (~1 ms a frame), came out sharper for text at the same
 * ceiling, and needs no SVC mode (livekit-client forces VP9/AV1 into one
 * that overrides the "detail" content hint). Under pressure the encoder
 * sheds frames, not pixels (maintain-resolution), so text stays sharp.
 */
export function screenSharePublishOptions(): TrackPublishOptions {
  return {
    videoCodec: "h264",
    simulcast: false,
    // Starts small; applyScreenQuality sets the size, and raises all three
    // while anyone has this screen enlarged.
    screenShareEncoding: {
      maxBitrate: SCREEN_SMALL.maxBitrate,
      maxFramerate: SCREEN_SMALL.maxFramerate,
    },
    degradationPreference: "maintain-resolution",
  };
}

/** How a shared screen is sent while nobody has it enlarged. */
const SCREEN_SMALL = {
  scaleResolutionDownBy: 2,
  maxBitrate: 600_000,
  maxFramerate: 8,
} as const;
/** …and while an admin or manager has it enlarged. */
const SCREEN_FULL = {
  scaleResolutionDownBy: 1,
  maxBitrate: SCREEN_SHARE_PROFILE.sfuMaxBitrate,
  maxFramerate: SCREEN_SHARE_PROFILE.maxFramerate,
} as const;
/** "I have your screen enlarged" — repeated while true, forgotten if not. */
const STAGE_TOPIC = "screen-stage";
const STAGE_PING_MS = 10_000;
const STAGE_TTL_MS = 25_000;

/** The only roles that see shared screens. Everyone else (the dialers)
 *  sees no one's screen but their own. */
const SCREEN_SUPERVISORS = new Set(["admin", "manager"]);
const isSupervisor = (p: { attributes?: Record<string, string> }) =>
  SCREEN_SUPERVISORS.has(p.attributes?.role ?? "");

const QUALITY: Record<Exclude<LayerChoice, "off">, VideoQuality> = {
  low: VideoQuality.LOW,
  medium: VideoQuality.MEDIUM,
  high: VideoQuality.HIGH,
};

/**
 * Join a call's LiveKit room and keep `onUpdate` fed with the current
 * participants and local preview stream.
 */
export async function connectCallRoom(opts: {
  url: string;
  token: string;
  video: boolean;
  /** Publish microphone on join. Defaults to true. */
  micEnabled?: boolean;
  /** Publish camera on join when `video` is true. Defaults to true. */
  cameraEnabled?: boolean;
  onUpdate: (payload: UpdatePayload) => void;
  onDisconnected: () => void;
  onLocalMic?: (muted: boolean) => void;
  /** Names of the other participants recording this call right now. */
  onRecorders?: (names: string[]) => void;
}): Promise<CallRoomHandle> {
  const {
    url,
    token,
    video,
    micEnabled = true,
    cameraEnabled = true,
    onUpdate,
    onDisconnected,
    onLocalMic,
    onRecorders,
  } = opts;

  const room = new Room({
    // adaptiveStream sizes each subscription from elements passed to
    // track.attach(). We render raw MediaStreams instead, so it never saw an
    // element: every viewer asked for every top layer, and after any
    // congestion pause it switched the video off for good (livekit-client
    // 2.22 RemoteVideoTrack.setStreamState → no visible element → disabled).
    // Layers are chosen explicitly instead — see applyVideoPlan.
    adaptiveStream: false,
    // Publishers stop encoding layers nobody is subscribed to.
    dynacast: true,
    videoCaptureDefaults: {
      // Match the 1:1 path: a 16:9 source so widescreen tiles don't have to
      // crop into the middle of the picture.
      // 540p at 15 fps: camera tiles are small, and encoding 720p at 24 fps
      // (plus its simulcast layers) is real work for a weak laptop.
      resolution: { width: 960, height: 540, frameRate: 15 },
      facingMode: "user",
    },
  });

  const remoteStreams = new Map<string, MediaStream>();
  const localCache = new Map<string, MediaStream>();
  let view: GroupView = { layout: "grid" };
  let lastPeers: { id: string; sharing: boolean }[] = [];

  /** Ask the SFU for exactly the layer each video is displayed at. The
   *  setters are no-ops when nothing changed, so this runs on every update. */
  // The screen this viewer has enlarged; its sharer sends full size while
  // we (or another admin/manager) keep it there.
  let stageTarget: string | null = null;
  const sendStage = (id: string, on: boolean) => {
    const payload = new TextEncoder().encode(JSON.stringify({ on }));
    void room.localParticipant
      .publishData(payload, { reliable: true, topic: STAGE_TOPIC, destinationIdentities: [id] })
      .catch(() => undefined);
  };
  const updateStage = (peers: { id: string; sharing: boolean }[]) => {
    const focus = view.layout === "focus" ? view.focusId : null;
    const target =
      focus && peers.some((p) => p.id === focus && p.sharing) ? focus : null;
    if (target === stageTarget) return;
    if (stageTarget) sendStage(stageTarget, false);
    stageTarget = target;
    if (target) sendStage(target, true);
  };
  const stagePing = setInterval(() => {
    if (stageTarget) sendStage(stageTarget, true);
  }, STAGE_PING_MS);

  const applyVideoPlan = (peers: { id: string; sharing: boolean }[]) => {
    lastPeers = peers;
    updateStage(peers);
    const plan = planGroupVideo(peers, view);
    room.remoteParticipants.forEach((participant) => {
      const choice = plan.get(participant.identity);
      if (!choice) return;
      participant.videoTrackPublications.forEach((pub) => {
        if (!pub.isSubscribed) return;
        const layer =
          pub.source === Track.Source.ScreenShare ? choice.screen : choice.camera;
        if (layer === "off") {
          pub.setEnabled(false);
          return;
        }
        pub.setEnabled(true);
        pub.setVideoQuality(QUALITY[layer]);
      });
    });
  };

  /**
   * Screen privacy: a shared screen — whoever shares it, admins and
   * managers included — is visible to admins and managers only; dialers
   * watch no one's screen. Enforced by the SFU (subscription permissions),
   * not by hiding tiles, so a modified browser cannot watch either; the role
   * comes from each person's server-issued token (createCallToken).
   *
   * Restricted only while this participant is sharing: everyone else keeps
   * every other track (microphone, camera) by name, and the list is redone
   * whenever someone joins or a track of ours comes or goes. Outside a share
   * everything is open, so a slip here can never cost anyone the audio.
   */
  let screenRestricted = false;
  const applyScreenPrivacy = (sharingNow: boolean) => {
    const me = room.localParticipant;
    if (!sharingNow) {
      if (screenRestricted) me.setTrackSubscriptionPermissions(true);
      screenRestricted = false;
      return;
    }
    const open: string[] = [];
    me.trackPublications.forEach((pub) => {
      if (pub.source !== Track.Source.ScreenShare && pub.trackSid) {
        open.push(pub.trackSid);
      }
    });
    const perms: ParticipantTrackPermission[] = [];
    room.remoteParticipants.forEach((p) => {
      perms.push(
        isSupervisor(p)
          ? { participantIdentity: p.identity, allowAll: true }
          : { participantIdentity: p.identity, allowedTrackSids: open },
      );
    });
    me.setTrackSubscriptionPermissions(false, perms);
    screenRestricted = true;
  };
  const localSharing = () =>
    Boolean(room.localParticipant.getTrackPublication(Track.Source.ScreenShare));

  // Admins/managers who have our screen enlarged, with when that lapses.
  const stageWatchers = new Map<string, number>();
  let appliedSender: RTCRtpSender | null = null;
  let appliedFull: boolean | null = null;
  let qualityChain: Promise<void> = Promise.resolve();
  const applyScreenQuality = () => {
    qualityChain = qualityChain.then(async () => {
      const now = Date.now();
      for (const [id, until] of stageWatchers) {
        if (until <= now) stageWatchers.delete(id);
      }
      const full = stageWatchers.size > 0;
      const sender =
        room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track
          ?.sender ?? null;
      if (!sender || (sender === appliedSender && full === appliedFull)) return;
      try {
        const params = sender.getParameters();
        const enc = params.encodings?.[0];
        if (!enc) return;
        // Only these three: LiveKit's dynacast owns `active` and keeps them.
        Object.assign(enc, full ? SCREEN_FULL : SCREEN_SMALL);
        await sender.setParameters(params);
        appliedSender = sender;
        appliedFull = full;
      } catch {
        /* the share ended meanwhile */
      }
    });
  };
  const stageExpiry = setInterval(() => {
    if (stageWatchers.size > 0) applyScreenQuality();
  }, 5_000);

  const emit = () => {
    const participants: LiveKitParticipant[] = [];
    room.remoteParticipants.forEach((p) => {
      const { stream, hasVideo, muted, sharing } = syncStream(
        p.identity,
        publicationsOf(p),
        remoteStreams,
      );
      participants.push({
        id: p.identity,
        name: p.name || "Participant",
        stream,
        hasVideo,
        muted,
        sharing,
      });
    });

    // Drop caches for participants who have left so streams don't leak.
    for (const key of [...remoteStreams.keys()]) {
      if (!room.remoteParticipants.has(key)) remoteStreams.delete(key);
    }

    const localPubs: Pub[] = [];
    room.localParticipant.trackPublications.forEach((pub) => {
      if (pub.kind !== Track.Kind.Video) return;
      localPubs.push({
        kind: pub.kind,
        source: pub.source,
        isMuted: pub.isMuted,
        track: pub.track
          ? { mediaStreamTrack: pub.track.mediaStreamTrack }
          : undefined,
      });
    });
    const local = syncStream("self", localPubs, localCache);

    applyVideoPlan(participants);

    onUpdate({
      participants,
      localStream: local.stream.getTracks().length > 0 ? local.stream : null,
      localSharing: local.sharing,
    });
  };

  // ── Recording notices ─────────────────────────────────────────────
  // Recording is known to admins and managers only. The notice is a
  // reliable data message addressed to their identities alone — never
  // broadcast — so nobody else's browser receives it at all. Resent to each
  // admin or manager who joins mid-recording. Kept as a map of identity →
  // name so a recorder who leaves drops off the list.
  const RECORDING_TOPIC = "recording";
  let recordingOn = false;
  const recorders = new Map<string, string>();
  const sendRecording = (only?: string[]) => {
    const to = only ?? [];
    if (!only) {
      room.remoteParticipants.forEach((p) => {
        if (isSupervisor(p)) to.push(p.identity);
      });
    }
    if (to.length === 0) return;
    const payload = new TextEncoder().encode(JSON.stringify({ on: recordingOn }));
    void room.localParticipant
      .publishData(payload, {
        reliable: true,
        topic: RECORDING_TOPIC,
        destinationIdentities: to,
      })
      .catch(() => undefined);
  };
  const reportRecorders = () => onRecorders?.([...recorders.values()]);

  const onMuteChange = (
    pub: { kind: Track.Kind; isMuted: boolean },
    participant: { isLocal?: boolean },
  ) => {
    emit();
    if (participant.isLocal && pub.kind === Track.Kind.Audio) {
      onLocalMic?.(pub.isMuted);
    }
  };

  room
    .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
      if (screenRestricted) applyScreenPrivacy(true);
      if (recordingOn && isSupervisor(p)) sendRecording([p.identity]);
      emit();
    })
    .on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      if (recorders.delete(p.identity)) reportRecorders();
      if (stageWatchers.delete(p.identity)) applyScreenQuality();
      emit();
    })
    .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      // Only an admin or manager may ask for a full-size screen.
      if (topic === STAGE_TOPIC && participant && isSupervisor(participant)) {
        try {
          const { on } = JSON.parse(new TextDecoder().decode(payload)) as { on?: boolean };
          if (on) stageWatchers.set(participant.identity, Date.now() + STAGE_TTL_MS);
          else stageWatchers.delete(participant.identity);
          applyScreenQuality();
        } catch {
          /* not ours */
        }
        return;
      }
      // Only an admin or manager may raise the badge.
      if (topic !== RECORDING_TOPIC || !participant || !isSupervisor(participant)) return;
      try {
        const { on } = JSON.parse(new TextDecoder().decode(payload)) as { on?: boolean };
        if (on) recorders.set(participant.identity, participant.name || "Someone");
        else recorders.delete(participant.identity);
        reportRecorders();
      } catch {
        /* not ours */
      }
    })
    .on(RoomEvent.TrackSubscribed, emit)
    .on(RoomEvent.TrackUnsubscribed, emit)
    .on(RoomEvent.TrackMuted, onMuteChange)
    .on(RoomEvent.TrackUnmuted, onMuteChange)
    .on(RoomEvent.LocalTrackPublished, () => {
      if (screenRestricted) applyScreenPrivacy(localSharing());
      emit();
    })
    .on(RoomEvent.LocalTrackUnpublished, () => {
      if (screenRestricted) applyScreenPrivacy(localSharing());
      emit();
    })
    .on(RoomEvent.Disconnected, () => {
      clearInterval(stagePing);
      clearInterval(stageExpiry);
      remoteStreams.clear();
      localCache.clear();
      onDisconnected();
    });

  await room.connect(url, token);

  // Publish our media using the lobby (or default) choices so the user is
  // not live unmuted / on-camera before they opted in.
  await room.localParticipant.setMicrophoneEnabled(micEnabled);
  if (video && cameraEnabled) {
    await room.localParticipant.setCameraEnabled(true);
  }

  // Browsers can hold remote audio until a gesture; joining is one.
  try {
    await room.startAudio();
  } catch {
    /* best-effort */
  }

  emit();

  return {
    room,
    async setMic(on: boolean) {
      await room.localParticipant.setMicrophoneEnabled(on);
      emit();
    },
    async setCamera(on: boolean) {
      await room.localParticipant.setCameraEnabled(on);
      emit();
    },
    async setScreenShare(on: boolean) {
      // Before publishing: the screen's own track is not in the allowed list,
      // so it is restricted from its very first frame.
      if (on) applyScreenPrivacy(true);
      try {
        await room.localParticipant.setScreenShareEnabled(
          on,
          screenShareCaptureOptions(),
          screenSharePublishOptions(),
        );
        applyScreenPrivacy(on);
        if (!on) stageWatchers.clear();
        applyScreenQuality();
        emit();
        return on;
      } catch {
        // User dismissed the picker, or the browser refused.
        applyScreenPrivacy(localSharing());
        emit();
        return false;
      }
    },
    micTrack() {
      const pub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
      return pub?.track?.mediaStreamTrack ?? null;
    },
    setRecording(on: boolean) {
      recordingOn = on;
      sendRecording();
    },
    setView(next: GroupView) {
      view = next;
      // Not emit(): that would feed React new state, and the caller runs
      // from a React effect.
      applyVideoPlan(lastPeers);
    },
    async disconnect() {
      clearInterval(stagePing);
      clearInterval(stageExpiry);
      try {
        await room.disconnect();
      } catch {
        /* ignore */
      }
      remoteStreams.clear();
      localCache.clear();
    },
  };
}

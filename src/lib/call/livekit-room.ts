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
  VideoPreset,
  VideoQuality,
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
 * Screen-share publishing. Three layers so every viewer gets what their
 * view needs: full size for the big focus view, 720p for grid tiles, 360p at
 * 5 fps for thumbnails and a minimized call. VP8 on purpose: livekit-client
 * forces VP9/AV1 into an SVC mode that overrides the "detail" content hint
 * and drops the smaller layers, and every browser can encode and decode VP8.
 */
export function screenSharePublishOptions(): TrackPublishOptions {
  const p = SCREEN_SHARE_PROFILE;
  return {
    videoCodec: "vp8",
    simulcast: true,
    screenShareEncoding: {
      maxBitrate: p.sfuMaxBitrate,
      maxFramerate: p.maxFramerate,
    },
    screenShareSimulcastLayers: [
      new VideoPreset(640, 360, 300_000, 5),
      new VideoPreset(1280, 720, 1_000_000, p.maxFramerate),
    ],
    degradationPreference: "maintain-resolution",
  };
}

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
      resolution: { width: 1280, height: 720, frameRate: 24 },
      facingMode: "user",
    },
  });

  const remoteStreams = new Map<string, MediaStream>();
  const localCache = new Map<string, MediaStream>();
  let view: GroupView = { layout: "grid" };
  let lastPeers: { id: string; sharing: boolean }[] = [];

  /** Ask the SFU for exactly the layer each video is displayed at. The
   *  setters are no-ops when nothing changed, so this runs on every update. */
  const applyVideoPlan = (peers: { id: string; sharing: boolean }[]) => {
    lastPeers = peers;
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
    .on(RoomEvent.ParticipantConnected, emit)
    .on(RoomEvent.ParticipantDisconnected, emit)
    .on(RoomEvent.TrackSubscribed, emit)
    .on(RoomEvent.TrackUnsubscribed, emit)
    .on(RoomEvent.TrackMuted, onMuteChange)
    .on(RoomEvent.TrackUnmuted, onMuteChange)
    .on(RoomEvent.LocalTrackPublished, emit)
    .on(RoomEvent.LocalTrackUnpublished, emit)
    .on(RoomEvent.Disconnected, () => {
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
      try {
        await room.localParticipant.setScreenShareEnabled(
          on,
          screenShareCaptureOptions(),
          screenSharePublishOptions(),
        );
        emit();
        return on;
      } catch {
        // User dismissed the picker, or the browser refused.
        emit();
        return false;
      }
    },
    setView(next: GroupView) {
      view = next;
      // Not emit(): that would feed React new state, and the caller runs
      // from a React effect.
      applyVideoPlan(lastPeers);
    },
    async disconnect() {
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

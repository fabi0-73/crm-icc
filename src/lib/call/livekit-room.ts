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
 * Participants are surfaced as { id, name, stream, hasVideo } — the exact
 * shape the existing CallGrid already renders — and each participant keeps a
 * STABLE MediaStream across updates so <video> elements aren't torn down and
 * re-bound on every track change.
 */

import { Room, RoomEvent, Track, type RemoteParticipant } from "livekit-client";

export type LiveKitParticipant = {
  id: string;
  name: string;
  stream: MediaStream;
  hasVideo: boolean;
};

export type CallRoomHandle = {
  room: Room;
  setMic: (on: boolean) => Promise<void>;
  setCamera: (on: boolean) => Promise<void>;
  /** Returns the resulting state (false if the user cancelled the picker). */
  setScreenShare: (on: boolean) => Promise<boolean>;
  disconnect: () => Promise<void>;
};

type UpdatePayload = {
  participants: LiveKitParticipant[];
  localStream: MediaStream | null;
};

/** Mirror a participant's published tracks into one long-lived MediaStream. */
function syncStream(
  key: string,
  publications: { kind: Track.Kind; isMuted: boolean; track?: { mediaStreamTrack?: MediaStreamTrack } }[],
  cache: Map<string, MediaStream>,
): { stream: MediaStream; hasVideo: boolean } {
  let stream = cache.get(key);
  if (!stream) {
    stream = new MediaStream();
    cache.set(key, stream);
  }

  const wanted = new Map<string, MediaStreamTrack>();
  let hasVideo = false;
  for (const pub of publications) {
    const mst = pub.track?.mediaStreamTrack;
    if (!mst) continue;
    wanted.set(mst.id, mst);
    if (pub.kind === Track.Kind.Video && !pub.isMuted && mst.readyState === "live") {
      hasVideo = true;
    }
  }

  for (const t of stream.getTracks()) {
    if (!wanted.has(t.id)) stream.removeTrack(t);
  }
  for (const t of wanted.values()) {
    if (!stream.getTracks().some((x) => x.id === t.id)) stream.addTrack(t);
  }
  return { stream, hasVideo };
}

function publicationsOf(p: RemoteParticipant) {
  const out: {
    kind: Track.Kind;
    isMuted: boolean;
    track?: { mediaStreamTrack?: MediaStreamTrack };
  }[] = [];
  p.trackPublications.forEach((pub) => {
    out.push({
      kind: pub.kind,
      isMuted: pub.isMuted,
      track: pub.track ? { mediaStreamTrack: pub.track.mediaStreamTrack } : undefined,
    });
  });
  return out;
}

/**
 * Join a call's LiveKit room and keep `onUpdate` fed with the current
 * participants and local preview stream.
 */
export async function connectCallRoom(opts: {
  url: string;
  token: string;
  video: boolean;
  onUpdate: (payload: UpdatePayload) => void;
  onDisconnected: () => void;
}): Promise<CallRoomHandle> {
  const { url, token, video, onUpdate, onDisconnected } = opts;

  const room = new Room({
    // Only send/receive what each tile actually needs — this is what keeps a
    // 10-person call sane on ordinary connections.
    adaptiveStream: true,
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

  const emit = () => {
    const participants: LiveKitParticipant[] = [];
    room.remoteParticipants.forEach((p) => {
      const { stream, hasVideo } = syncStream(
        p.identity,
        publicationsOf(p),
        remoteStreams,
      );
      participants.push({
        id: p.identity,
        name: p.name || "Participant",
        stream,
        hasVideo,
      });
    });

    // Drop caches for participants who have left so streams don't leak.
    for (const key of [...remoteStreams.keys()]) {
      if (!room.remoteParticipants.has(key)) remoteStreams.delete(key);
    }

    const localPubs: {
      kind: Track.Kind;
      isMuted: boolean;
      track?: { mediaStreamTrack?: MediaStreamTrack };
    }[] = [];
    room.localParticipant.trackPublications.forEach((pub) => {
      if (pub.kind !== Track.Kind.Video) return;
      localPubs.push({
        kind: pub.kind,
        isMuted: pub.isMuted,
        track: pub.track ? { mediaStreamTrack: pub.track.mediaStreamTrack } : undefined,
      });
    });
    const local = syncStream("self", localPubs, localCache);

    onUpdate({
      participants,
      localStream: local.stream.getTracks().length > 0 ? local.stream : null,
    });
  };

  room
    .on(RoomEvent.ParticipantConnected, emit)
    .on(RoomEvent.ParticipantDisconnected, emit)
    .on(RoomEvent.TrackSubscribed, emit)
    .on(RoomEvent.TrackUnsubscribed, emit)
    .on(RoomEvent.TrackMuted, emit)
    .on(RoomEvent.TrackUnmuted, emit)
    .on(RoomEvent.LocalTrackPublished, emit)
    .on(RoomEvent.LocalTrackUnpublished, emit)
    .on(RoomEvent.Disconnected, () => {
      remoteStreams.clear();
      localCache.clear();
      onDisconnected();
    });

  await room.connect(url, token);

  // Publish our media. Mic always; camera only for a video call.
  await room.localParticipant.setMicrophoneEnabled(true);
  if (video) await room.localParticipant.setCameraEnabled(true);

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
        await room.localParticipant.setScreenShareEnabled(on);
        emit();
        return on;
      } catch {
        // User dismissed the picker, or the browser refused.
        emit();
        return false;
      }
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

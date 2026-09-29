"use client";

/**
 * Call recording, saved on the recorder's own computer.
 *
 * Records the call's browser tab — exactly what this person sees, with the
 * other participants' audio, which plays in this tab — and mixes in their own
 * microphone, which a tab capture never contains. Nothing is uploaded: the
 * file is offered as a download when the recording stops or the call ends.
 *
 * Chrome keeps large Blobs on disk rather than in memory, so an hours-long
 * recording collected as one-second chunks does not grow the tab's memory.
 */

/** Cheapest container the browser records natively: MP4/H.264 (Chrome 126+,
 *  Safari) can use the graphics chip, WebM/VP8 is the universal fallback. */
const MIME_TYPES = [
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=h264,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function recordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator.mediaDevices?.getDisplayMedia)
  );
}

export type CallRecording = {
  /** Stop and hand the file to the browser as a download. */
  stop: () => void;
};

export async function startCallRecording(opts: {
  /** This person's microphone, mixed in (tab audio has only the others). */
  micTrack: MediaStreamTrack | null;
  /** File name without extension. */
  fileName: string;
  /** Called once the recording has ended, however it ended. */
  onEnded: () => void;
}): Promise<CallRecording> {
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: {
      width: { max: 1920 },
      height: { max: 1080 },
      frameRate: { max: 15 },
    },
    audio: true,
    // Chrome: offer "this tab" straight away rather than the full picker.
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
  } as DisplayMediaStreamOptions);

  const audio = new AudioContext();
  const mix = audio.createMediaStreamDestination();
  const tabAudio = display.getAudioTracks();
  if (tabAudio.length) {
    audio.createMediaStreamSource(new MediaStream(tabAudio)).connect(mix);
  }
  if (opts.micTrack && opts.micTrack.readyState === "live") {
    audio
      .createMediaStreamSource(new MediaStream([opts.micTrack]))
      .connect(mix);
  }

  const stream = new MediaStream([
    ...display.getVideoTracks(),
    ...mix.stream.getAudioTracks(),
  ]);
  const mimeType =
    MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    // Calls are mostly screens and faces; this keeps an hour near 550 MB.
    videoBitsPerSecond: 1_200_000,
    audioBitsPerSecond: 96_000,
  });

  const chunks: Blob[] = [];
  let finished = false;
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  recorder.onstop = () => {
    display.getTracks().forEach((t) => t.stop());
    void audio.close().catch(() => undefined);
    if (chunks.length) {
      const type = recorder.mimeType || mimeType || "video/webm";
      const ext = type.startsWith("video/mp4") ? "mp4" : "webm";
      const url = URL.createObjectURL(new Blob(chunks, { type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${opts.fileName}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Long enough for the download to take the file.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    opts.onEnded();
  };

  const stop = () => {
    if (finished) return;
    finished = true;
    if (recorder.state !== "inactive") recorder.stop();
    else recorder.onstop?.(new Event("stop"));
  };
  // "Stop sharing" in the browser's own bar ends the recording too.
  display.getVideoTracks()[0]?.addEventListener("ended", stop);

  recorder.start(1000);
  return { stop };
}

/** "ICC call – Sales team – 2026-09-29 18-40" (no characters Windows forbids). */
export function recordingFileName(title: string, at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}`;
  const safe = title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60);
  return `ICC call – ${safe || "call"} – ${stamp}`;
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Pause, Play, SendHorizontal, Square, Trash2 } from "lucide-react";

const MAX_SECONDS = 60;

type Mode = "idle" | "recording" | "preview" | "sending";

function pickMime() {
  if (typeof MediaRecorder === "undefined") return "";
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

function extensionFor(mime: string) {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

function formatClock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function VoiceRecorder({
  disabled,
  callActive,
  onBusyChange,
  onSend,
  onError,
}: {
  disabled?: boolean;
  callActive?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onSend: (file: File, duration: number) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const cancelledRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const mimeRef = useRef("");
  const startedAtRef = useRef(0);
  const elapsedRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const modeRef = useRef<Mode>("idle");

  modeRef.current = mode;

  const busy = mode !== "idle";

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    return () => {
      teardown(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopTick() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  function teardown(full: boolean) {
    stopTick();
    try {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (full) {
      blobRef.current = null;
      chunksRef.current = [];
    }
  }

  function cancel() {
    cancelledRef.current = true;
    teardown(true);
    setPreviewUrl(null);
    setPlaying(false);
    setProgress(0);
    setElapsed(0);
    elapsedRef.current = 0;
    setMode("idle");
  }

  async function start() {
    if (disabled || callActive) {
      onError(
        callActive
          ? "Finish the call before recording a voice message."
          : "Can't record right now.",
      );
      return;
    }
    if (!window.isSecureContext && location.hostname !== "localhost") {
      onError("Voice messages need HTTPS.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError("This browser cannot record audio.");
      return;
    }

    try {
      cancelledRef.current = false;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const mime = pickMime();
      mimeRef.current = mime;
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
      chunksRef.current = [];
      recorderRef.current = recorder;
      streamRef.current = stream;
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        if (cancelledRef.current) return;
        const type = recorder.mimeType || mime || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        blobRef.current = blob;
        const url = URL.createObjectURL(blob);
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setMode("preview");
      };
      recorder.start(100);
      startedAtRef.current = Date.now();
      elapsedRef.current = 0;
      setElapsed(0);
      setMode("recording");
      tickRef.current = setInterval(() => {
        const next = (Date.now() - startedAtRef.current) / 1000;
        elapsedRef.current = next;
        setElapsed(next);
        if (next >= MAX_SECONDS) stopRecording();
      }, 200);
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        onError("Microphone permission was blocked.");
        return;
      }
      onError(err instanceof Error ? err.message : "Could not start recording.");
    }
  }

  function stopRecording() {
    stopTick();
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recorderRef.current = null;
  }

  function togglePreview() {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      return;
    }
    void el.play().catch(() => undefined);
    setPlaying(true);
  }

  async function send() {
    const blob = blobRef.current;
    if (!blob) return;
    const duration = Math.max(1, Math.round(elapsedRef.current));
    const ext = extensionFor(blob.type || mimeRef.current);
    const file = new File([blob], `voice-message.${ext}`, {
      type: blob.type || mimeRef.current || "audio/webm",
    });
    setMode("sending");
    try {
      await onSend(file, duration);
      cancel();
    } catch (err) {
      setMode("preview");
      onError(err instanceof Error ? err.message : "Could not send voice message.");
    }
  }

  if (mode === "idle") {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => void start()}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mist active:bg-mist disabled:opacity-40"
        aria-label={callActive ? "Unavailable during a call" : "Record voice message"}
        title={callActive ? "Finish the call before recording" : "Voice message"}
      >
        <Mic className="size-[21px]" />
      </button>
    );
  }

  return (
    <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-3xl bg-secondary px-3 py-1.5">
      <button
        type="button"
        onClick={cancel}
        disabled={mode === "sending"}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-red-600 hover:bg-paper disabled:opacity-40"
        aria-label="Cancel recording"
      >
        <Trash2 className="size-4" />
      </button>

      {mode === "recording" ? (
        <>
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
          <span className="flex-1 text-[13px] font-medium tabular-nums text-ink">
            {formatClock(elapsed)} / {formatClock(MAX_SECONDS)}
          </span>
          <button
            type="button"
            onClick={stopRecording}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-white"
            aria-label="Stop recording"
          >
            <Square className="size-3.5 fill-current" />
          </button>
        </>
      ) : (
        <>
          {previewUrl && (
            <audio
              ref={audioRef}
              src={previewUrl}
              onTimeUpdate={(e) => {
                const el = e.currentTarget;
                if (el.duration) setProgress(el.currentTime / el.duration);
              }}
              onEnded={() => {
                setPlaying(false);
                setProgress(0);
              }}
            />
          )}
          <button
            type="button"
            onClick={togglePreview}
            disabled={mode === "sending"}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white disabled:opacity-40"
            aria-label={playing ? "Pause preview" : "Play preview"}
          >
            {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="h-1 overflow-hidden rounded-full bg-line">
              <div
                className="h-full bg-brand-500"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <p className="mt-0.5 text-[11px] tabular-nums text-muted">
              {formatClock(elapsed)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void send()}
            disabled={mode === "sending"}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white disabled:opacity-40"
            aria-label="Send voice message"
          >
            <SendHorizontal className="size-4" />
          </button>
        </>
      )}
    </div>
  );
}

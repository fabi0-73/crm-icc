"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { Message } from "@/lib/types";

export type SignFn = (path: string) => Promise<string | null>;

export function isVoiceMessage(msg: Message) {
  if (msg.kind !== "file") return false;
  const meta = msg.metadata as { voice?: unknown } | null;
  if (meta && meta.voice === true) return true;
  const mime = msg.attachment_mime ?? "";
  if (mime.startsWith("audio/")) return true;
  const name = msg.attachment_name ?? msg.body ?? "";
  return /\.(webm|ogg|opus|m4a|mp3|wav|aac)$/i.test(name);
}

function voiceDurationSeconds(msg: Message) {
  const raw = (msg.metadata as { duration?: unknown } | null)?.duration;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}

function formatClock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function useSignedUrl(path: string | null, sign: SignFn) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setFailed(false);
    void sign(path)
      .then((signed) => {
        if (cancelled) return;
        if (signed) setUrl(signed);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, sign]);

  return { url, failed };
}

let activeId: string | null = null;
const listeners = new Set<() => void>();

export function VoiceMessageBubble({
  msg,
  mine,
  shape,
  surface,
  sign,
}: {
  msg: Message;
  mine: boolean;
  shape: string;
  surface: string;
  sign: SignFn;
}) {
  const { url, failed } = useSignedUrl(msg.attachment_path, sign);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(voiceDurationSeconds(msg) ?? 0);

  useEffect(() => {
    const pauseIfOther = () => {
      if (activeId === msg.id) return;
      const el = audioRef.current;
      if (!el) return;
      el.pause();
      setPlaying(false);
    };
    listeners.add(pauseIfOther);
    return () => {
      listeners.delete(pauseIfOther);
      if (activeId === msg.id) activeId = null;
    };
  }, [msg.id]);

  function toggle() {
    const el = audioRef.current;
    if (!el || !url) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      if (activeId === msg.id) activeId = null;
      return;
    }
    activeId = msg.id;
    listeners.forEach((fn) => fn());
    void el.play().catch(() => undefined);
    setPlaying(true);
  }

  function seek(value: number) {
    const el = audioRef.current;
    if (!el || !el.duration) return;
    el.currentTime = value * el.duration;
    setCurrent(el.currentTime);
  }

  const total = duration || voiceDurationSeconds(msg) || 0;
  const ratio = total > 0 ? Math.min(1, current / total) : 0;

  return (
    <div
      className={`flex min-w-[220px] max-w-full items-center gap-2 px-3 py-2.5 ${shape} ${surface}`}
    >
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d) && d > 0) setDuration(d);
          }}
          onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
          onEnded={() => {
            setPlaying(false);
            setCurrent(0);
            if (activeId === msg.id) activeId = null;
          }}
        />
      )}
      <button
        type="button"
        onClick={toggle}
        disabled={!url || failed}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full disabled:opacity-40 ${
          mine ? "bg-white/20 text-white" : "bg-brand-600 text-white"
        }`}
        aria-label={playing ? "Pause voice message" : "Play voice message"}
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </button>
      <div className="min-w-0 flex-1">
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(ratio * 1000)}
          onChange={(e) => seek(Number(e.target.value) / 1000)}
          disabled={!url || failed}
          className="h-1.5 w-full cursor-pointer accent-current"
          aria-label="Voice message progress"
        />
        <p
          className={`mt-0.5 text-[11px] tabular-nums ${
            mine ? "text-white/75" : "text-muted"
          }`}
        >
          {failed
            ? "Unavailable"
            : `${formatClock(current)} / ${formatClock(total)}`}
        </p>
      </div>
    </div>
  );
}

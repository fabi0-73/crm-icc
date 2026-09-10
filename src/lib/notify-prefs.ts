"use client";

import { useEffect, useState } from "react";

/**
 * Per-device notification preferences. Muting is granular: silencing the
 * general message sound must not silence a call coming in, and vice
 * versa. Stored in localStorage (a per-browser convenience, not shared
 * state) and mirrored across a tab's components via a custom event.
 */
export type NotifyPrefs = {
  /** New-message sound for rooms you are not looking at. */
  messages: boolean;
  /** Sound when someone @mentions you (kept independent of `messages`). */
  mentions: boolean;
  /** Incoming-call ringtone / meeting alert. */
  calls: boolean;
};

const KEY = "icc.notify.prefs.v1";
const MUTED_KEY = "icc.notify.muted-rooms.v1";
const EVENT = "icc-notify-prefs-change";
const DEFAULTS: NotifyPrefs = { messages: true, mentions: true, calls: true };

/**
 * Per-conversation mute: a set of room ids the user has silenced. This is
 * targeted muting (a noisy group, one person's DM) and is independent of
 * the global sound switches above — muting one room never mutes the rest.
 */
function readMutedRooms(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(MUTED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export function isRoomMuted(roomId: string): boolean {
  return readMutedRooms().has(roomId);
}

export function setRoomMuted(roomId: string, muted: boolean) {
  if (typeof window === "undefined") return;
  const set = readMutedRooms();
  if (muted) set.add(roomId);
  else set.delete(roomId);
  try {
    window.localStorage.setItem(MUTED_KEY, JSON.stringify([...set]));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Live boolean for whether a specific room is muted. */
export function useRoomMuted(roomId: string): boolean {
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    const update = () => setMuted(isRoomMuted(roomId));
    update();
    window.addEventListener(EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, [roomId]);
  return muted;
}

export function readNotifyPrefs(): NotifyPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<NotifyPrefs>;
    return {
      messages: parsed.messages ?? true,
      mentions: parsed.mentions ?? true,
      calls: parsed.calls ?? true,
    };
  } catch {
    return DEFAULTS;
  }
}

export function setNotifyPref(key: keyof NotifyPrefs, value: boolean) {
  if (typeof window === "undefined") return;
  const next = { ...readNotifyPrefs(), [key]: value };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode / disabled storage — the toggle still applies in-tab */
  }
  window.dispatchEvent(new CustomEvent<NotifyPrefs>(EVENT, { detail: next }));
}

/** Live view of the preferences, updating when any component changes them. */
export function useNotifyPrefs(): NotifyPrefs {
  const [prefs, setPrefs] = useState<NotifyPrefs>(DEFAULTS);
  useEffect(() => {
    setPrefs(readNotifyPrefs());
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<NotifyPrefs>).detail;
      setPrefs(detail ?? readNotifyPrefs());
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setPrefs(readNotifyPrefs());
    };
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return prefs;
}

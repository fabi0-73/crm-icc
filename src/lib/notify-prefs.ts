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
const EVENT = "icc-notify-prefs-change";
const DEFAULTS: NotifyPrefs = { messages: true, mentions: true, calls: true };

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

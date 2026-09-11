"use client";

import { useEffect, useState } from "react";
import { AtSign, Bell, MonitorSmartphone, Phone, SunMoon } from "lucide-react";
import {
  useNotifyPrefs,
  setNotifyPref,
  type NotifyPrefs,
} from "@/lib/notify-prefs";
import {
  ensureNotifyPermission,
  notificationPermission,
  notificationsSupported,
  registerServiceWorker,
} from "@/lib/notify";
import { savePushSubscription } from "@/lib/push/client";
import { ThemeToggle } from "@/components/ThemeToggle";

const ROWS: {
  key: keyof NotifyPrefs;
  label: string;
  hint: string;
  icon: React.ReactNode;
}[] = [
  {
    key: "messages",
    label: "Message sounds",
    hint: "A soft chime when a new message lands in a chat you're not reading.",
    icon: <Bell className="size-[18px]" />,
  },
  {
    key: "mentions",
    label: "Mentions",
    hint: "Play a sound when someone @mentions you, even if message sounds are off.",
    icon: <AtSign className="size-[18px]" />,
  },
  {
    key: "calls",
    label: "Call ringtone",
    hint: "Ring for incoming voice and video calls.",
    icon: <Phone className="size-[18px]" />,
  },
];

/** A small toggle switch styled to match the app's accent. */
function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
        on ? "bg-brand-600" : "bg-line-strong"
      }`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
          on ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

type PermState = NotificationPermission | "unsupported";

/** Row that requests/reports desktop + mobile pop-up permission. */
function DesktopNotificationsRow() {
  const [perm, setPerm] = useState<PermState>("default");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!notificationsSupported()) {
      setPerm("unsupported");
      return;
    }
    setPerm(notificationPermission());
  }, []);

  async function enable() {
    setBusy(true);
    try {
      const granted = await ensureNotifyPermission();
      setPerm(notificationsSupported() ? notificationPermission() : "unsupported");
      if (granted) {
        // Register the SW (click routing + Web Push readiness), then subscribe
        // this device and persist it server-side so closed-app pushes work.
        // Both are no-ops if a VAPID key isn't configured, so this is safe.
        await registerServiceWorker();
        await savePushSubscription();
      }
    } finally {
      setBusy(false);
    }
  }

  let control: React.ReactNode;
  if (perm === "granted") {
    control = (
      <span className="inline-flex shrink-0 items-center rounded-full bg-brand-50 px-2.5 py-1 text-[12px] font-semibold text-brand-700">
        On
      </span>
    );
  } else if (perm === "denied") {
    control = (
      <span className="shrink-0 text-right text-[12px] font-medium text-muted">
        Blocked
      </span>
    );
  } else if (perm === "unsupported") {
    control = (
      <span className="shrink-0 text-right text-[12px] font-medium text-muted">
        Unavailable
      </span>
    );
  } else {
    control = (
      <button
        type="button"
        onClick={enable}
        disabled={busy}
        className="shrink-0 rounded-full bg-brand-600 px-3.5 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
      >
        {busy ? "Enabling…" : "Enable"}
      </button>
    );
  }

  const hint =
    perm === "denied"
      ? "Blocked for this site. Re-enable notifications in your browser's site settings, then reload."
      : perm === "unsupported"
        ? "This browser can't show pop-up notifications."
        : "Pop up new messages and calls even when the app is in another tab or the background.";

  return (
    <li className="flex items-center gap-3 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
        <MonitorSmartphone className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-medium text-ink">Desktop notifications</p>
        <p className="text-[12px] leading-snug text-muted">{hint}</p>
      </div>
      {control}
    </li>
  );
}

export function NotificationSettings() {
  const prefs = useNotifyPrefs();
  return (
    <div className="rounded-2xl border border-line bg-paper p-4 shadow-xs">
      <h2 className="text-[15px] font-semibold text-ink">Notifications</h2>
      <p className="mb-3 mt-1 text-[13px] text-muted">
        Mute each sound on its own. Muting messages still lets mentions and
        calls through.
      </p>
      <ul className="divide-y divide-line/70">
        <DesktopNotificationsRow />
        {ROWS.map((row) => (
          <li key={row.key} className="flex items-center gap-3 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
              {row.icon}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium text-ink">{row.label}</p>
              <p className="text-[12px] leading-snug text-muted">{row.hint}</p>
            </div>
            <Toggle
              on={prefs[row.key]}
              label={row.label}
              onChange={(v) => setNotifyPref(row.key, v)}
            />
          </li>
        ))}
        <li className="flex items-center gap-3 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
            <SunMoon className="size-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-medium text-ink">Appearance</p>
            <p className="text-[12px] leading-snug text-muted">
              Match your system, or force light or dark for this device.
            </p>
          </div>
          <ThemeToggle />
        </li>
      </ul>
    </div>
  );
}

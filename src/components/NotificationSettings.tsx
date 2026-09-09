"use client";

import { Bell, AtSign, Phone } from "lucide-react";
import {
  useNotifyPrefs,
  setNotifyPref,
  type NotifyPrefs,
} from "@/lib/notify-prefs";

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
      </ul>
    </div>
  );
}

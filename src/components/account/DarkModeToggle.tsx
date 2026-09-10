"use client";

import { useTheme } from "@/components/theme/ThemeProvider";

export function DarkModeToggle() {
  const { dark, setDark } = useTheme();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      onClick={() => setDark(!dark)}
      className="flex w-full items-center justify-between rounded-2xl border border-line bg-paper px-4 py-3.5 text-left shadow-xs active:bg-mist"
    >
      <span>
        <span className="block text-[15px] font-medium text-ink">Dark mode</span>
        <span className="block text-[13px] text-muted">
          {dark ? "On — saved on this device" : "Off"}
        </span>
      </span>
      <span
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
          dark ? "bg-brand-600" : "bg-line-strong"
        }`}
      >
        <span
          className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-xs transition-transform ${
            dark ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}

"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import type { Theme } from "@/lib/theme";

const OPTIONS: { value: Theme; label: string; icon: React.ReactNode }[] = [
  { value: "system", label: "System", icon: <Monitor className="size-4" /> },
  { value: "light", label: "Light", icon: <Sun className="size-4" /> },
  { value: "dark", label: "Dark", icon: <Moon className="size-4" /> },
];

/**
 * A compact light / dark / system segmented control, styled to sit alongside
 * the notification toggles. Uses the shared theme tokens so it looks right in
 * either mode.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-mist p-1 ring-1 ring-line"
    >
      {OPTIONS.map((opt) => {
        const active = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.label}
            title={opt.label}
            onClick={() => setTheme(opt.value)}
            className={`inline-flex h-7 w-8 items-center justify-center rounded-full transition-colors ${
              active
                ? "bg-paper text-brand-600 shadow-xs ring-1 ring-line"
                : "text-muted hover:text-ink"
            }`}
          >
            {opt.icon}
          </button>
        );
      })}
    </div>
  );
}

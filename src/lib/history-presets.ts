import type { HistoryPreset } from "@/lib/types";

export const HISTORY_PRESET_OPTIONS: {
  value: HistoryPreset;
  label: string;
}[] = [
  { value: "full", label: "Full history" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "from_today", label: "From today" },
  { value: "none", label: "No previous history" },
];

/** Maps a UI preset to the timestamp stored on room_members.can_view_history_from. */
export function historyFromPreset(preset: HistoryPreset): string | null {
  const now = new Date();
  switch (preset) {
    case "full":
      return null;
    case "last_30_days": {
      const d = new Date(now);
      d.setDate(d.getDate() - 30);
      return d.toISOString();
    }
    case "last_7_days": {
      const d = new Date(now);
      d.setDate(d.getDate() - 7);
      return d.toISOString();
    }
    case "from_today": {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case "none":
      return now.toISOString();
  }
}

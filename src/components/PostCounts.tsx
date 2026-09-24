"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Row = { user_id: string; person: string; posts: number };
type Period = "today" | "week" | "month" | "all";

/** Local YYYY-MM-DD. toISOString() would answer in UTC and, at UTC+2,
 *  put anything after midnight on the wrong day. */
function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function rangeFor(period: Period): { from: string; to: string } {
  const now = new Date();
  const to = ymd(now);
  if (period === "today") return { from: to, to };
  if (period === "week") {
    const d = new Date(now);
    // Monday as the first day, the way a work week is counted here.
    const back = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - back);
    return { from: ymd(d), to };
  }
  if (period === "month") {
    return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  }
  return { from: "2000-01-01", to };
}

const LABELS: Record<Period, string> = {
  today: "Today",
  week: "This week",
  month: "This month",
  all: "All time",
};

/**
 * How many each person posted over a period. In a drop box (one message =
 * one appointment) this is the appointment count, which is otherwise only
 * obtainable by scrolling several hundred messages a day.
 *
 * The server decides what comes back: a supervisor gets the whole team,
 * anyone else gets their own line only.
 */
export function PostCounts({ roomId }: { roomId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [period, setPeriod] = useState<Period>("today");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    const { from, to } = rangeFor(period);
    const { data, error: rpcError } = await supabase.rpc("room_post_counts", {
      p_room: roomId,
      p_from: from,
      p_to: to,
    });
    setLoading(false);
    if (rpcError) {
      setError(true);
      return;
    }
    setRows((data ?? []) as Row[]);
  }, [supabase, roomId, period]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = (rows ?? []).reduce((n, r) => n + Number(r.posts), 0);

  const copy = async () => {
    if (!rows) return;
    const { from, to } = rangeFor(period);
    const header =
      from === to ? `Appointments — ${from}` : `Appointments — ${from} to ${to}`;
    const body = rows
      .filter((r) => Number(r.posts) > 0)
      .map((r) => `${r.person}: ${r.posts}`)
      .join("\n");
    const text = `${header}\n${body}\n\nTotal: ${total}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked — the numbers are on screen anyway */
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-1 px-2 pt-2">
        {(Object.keys(LABELS) as Period[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPeriod(p)}
            aria-pressed={period === p}
            className={`h-7 flex-1 rounded-lg text-[12px] font-semibold transition-colors ${
              period === p
                ? "bg-brand-600 text-white"
                : "bg-mist text-muted hover:text-ink"
            }`}
          >
            {LABELS[p]}
          </button>
        ))}
      </div>

      <div className="flex shrink-0 items-center justify-between px-3 py-2.5">
        <p className="text-[13px] text-muted">
          {loading ? "Counting…" : `${total} in total`}
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void load()}
            aria-label="Recount"
            className="rounded-full p-1.5 text-muted hover:bg-mist hover:text-ink"
          >
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={() => void copy()}
            disabled={!rows || total === 0}
            className="flex items-center gap-1.5 rounded-full bg-mist px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-line disabled:opacity-40"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      {error && (
        <p className="px-3 pb-3 text-[13px] text-muted">
          Couldn&apos;t load the counts. Try again.
        </p>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {(rows ?? []).map((r) => (
          <li
            key={r.user_id}
            className="flex items-center justify-between gap-3 rounded-xl px-2.5 py-2"
          >
            <span className="truncate text-[14px] text-ink">{r.person}</span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[13px] font-semibold tabular-nums ${
                Number(r.posts) > 0
                  ? "bg-brand-50 text-brand-700"
                  : "bg-mist text-muted"
              }`}
            >
              {r.posts}
            </span>
          </li>
        ))}
        {rows !== null && rows.length === 0 && !error && (
          <li className="px-2.5 py-6 text-center text-[13px] text-muted">
            Nothing posted in this period.
          </li>
        )}
      </ul>
    </div>
  );
}

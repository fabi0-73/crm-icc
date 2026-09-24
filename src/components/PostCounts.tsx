"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Row = {
  user_id: string;
  person: string;
  appointments: number;
  other_posts: number;
  from_day: string;
  to_day: string;
};
type Period = "today" | "week" | "month" | "all";

const LABELS: Record<Period, string> = {
  today: "Shift",
  week: "Week",
  month: "Month",
  all: "All",
};

/**
 * Appointments per person over a shift, week or month.
 *
 * Two things here are deliberate and easy to get wrong:
 *
 * The period is named, not dated — the server works out the range in
 * Tirane time, so a phone set to the wrong timezone cannot move anybody's
 * numbers. A "day" turns over at NOON, because the shift runs 15:00 to
 * 06:00 and a calendar day would cut every one of them in half.
 *
 * Appointments are counted, not messages. Most of what is posted in that
 * group is conversation; counting all of it overstated the real figure
 * roughly threefold. The server decides what looks like a record — see
 * private.looks_like_appointment.
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
    const { data, error: rpcError } = await supabase.rpc("room_post_counts", {
      p_room: roomId,
      p_period: period,
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

  const totalAppts = (rows ?? []).reduce(
    (n, r) => n + Number(r.appointments),
    0,
  );
  const span = rows?.[0];

  const copy = async () => {
    if (!rows) return;
    const head =
      span && span.from_day === span.to_day
        ? `Appointments — ${span.from_day}`
        : `Appointments — ${span?.from_day} to ${span?.to_day}`;
    const body = rows
      .filter((r) => Number(r.appointments) > 0)
      .map((r) => `${r.person}: ${r.appointments}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(
        `${head}\n${body}\n\nTotal: ${totalAppts}`,
      );
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

      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink">
            {loading ? "Counting…" : `${totalAppts} appointments`}
          </p>
          {span && !loading && (
            <p className="truncate text-[11px] text-muted">
              {span.from_day === span.to_day
                ? `Shift of ${span.from_day} · noon to noon`
                : `${span.from_day} → ${span.to_day}`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
            disabled={!rows || totalAppts === 0}
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
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
              {r.person}
            </span>
            {Number(r.other_posts) > 0 && (
              <span
                className="shrink-0 text-[11px] text-muted"
                title="Other messages — conversation, not counted as appointments"
              >
                +{r.other_posts}
              </span>
            )}
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[13px] font-semibold tabular-nums ${
                Number(r.appointments) > 0
                  ? "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                  : "bg-mist text-muted"
              }`}
            >
              {r.appointments}
            </span>
          </li>
        ))}
        {rows !== null && rows.length === 0 && !error && (
          <li className="px-2.5 py-6 text-center text-[13px] text-muted">
            Nothing in this period.
          </li>
        )}
      </ul>
    </div>
  );
}

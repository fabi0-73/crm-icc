"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, FileSpreadsheet, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Row = {
  user_id: string;
  person: string;
  reports: number;
  pick_ups: number;
  appts: number;
  callbacks: number;
  hung_ups: number;
  others: number;
  wrong_numbers: number;
  from_day: string;
  to_day: string;
};
type Period = "today" | "week" | "month" | "all" | "range";
type NumKey = "pick_ups" | "appts" | "callbacks" | "hung_ups" | "others" | "wrong_numbers";

const LABELS: Record<Period, string> = {
  today: "Shift",
  week: "Week",
  month: "Month",
  all: "All",
  range: "Dates",
};

/** The report template's numbers, in its order and its words. */
const NUMBERS: { key: NumKey; label: string }[] = [
  { key: "pick_ups", label: "Pick ups" },
  { key: "appts", label: "Appt" },
  { key: "callbacks", label: "Callbacks" },
  { key: "hung_ups", label: "Hung ups" },
  { key: "others", label: "Others" },
  { key: "wrong_numbers", label: "Wrong number" },
];

function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The Counts tab of a report group (rooms.report_form, 0027): each person's
 * reports added up over a shift, week, month or chosen shift days, the same
 * periods as the appointments group's PostCounts (noon-to-noon days, worked
 * out on the server). Everyone in the group is listed, so a 0 shows who has
 * not reported. A dialer sees only their own line.
 */
export function ReportTotals({ roomId }: { roomId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const [period, setPeriod] = useState<Period>("today");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [from, setFrom] = useState(localToday);
  const [to, setTo] = useState(localToday);
  const rangeOk = period !== "range" || (Boolean(from) && Boolean(to) && from <= to);

  const load = useCallback(async () => {
    if (period === "range" && !(from && to && from <= to)) return;
    setLoading(true);
    setError(false);
    const { data, error: rpcError } =
      period === "range"
        ? await supabase.rpc("shift_report_totals_range", {
            p_room: roomId,
            p_from: from,
            p_to: to,
          })
        : await supabase.rpc("shift_report_totals", {
            p_room: roomId,
            p_period: period,
          });
    setLoading(false);
    if (rpcError) {
      setError(true);
      return;
    }
    setRows((data ?? []) as Row[]);
  }, [supabase, roomId, period, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const exportQuery =
    period === "range"
      ? `room=${roomId}&from=${from}&to=${to}`
      : `room=${roomId}&period=${period}`;
  const total = useMemo(() => {
    const t = { reports: 0 } as Record<NumKey | "reports", number>;
    for (const n of NUMBERS) t[n.key] = 0;
    for (const r of rows ?? []) {
      t.reports += Number(r.reports);
      for (const n of NUMBERS) t[n.key] += Number(r[n.key]);
    }
    return t;
  }, [rows]);
  const span = rows?.[0];

  const copy = async () => {
    if (!rows) return;
    const head =
      span && span.from_day === span.to_day
        ? `Reports — ${span.from_day}`
        : `Reports — ${span?.from_day} to ${span?.to_day}`;
    const line = (src: Record<NumKey, number>) =>
      NUMBERS.map((n) => `${n.label} ${Number(src[n.key])}`).join(" · ");
    const body = rows
      .filter((r) => Number(r.reports) > 0)
      .map((r) => `${r.person}: ${line(r)}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(`${head}\n${body}\n\nTotal: ${line(total)}`);
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
              period === p ? "bg-brand-600 text-white" : "bg-mist text-muted hover:text-ink"
            }`}
          >
            {LABELS[p]}
          </button>
        ))}
      </div>

      {period === "range" && (
        <div className="flex shrink-0 items-end gap-2 px-3 pt-2.5">
          <label className="min-w-0 flex-1 text-[11px] font-medium text-muted">
            From
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-line-strong bg-paper px-2 py-1.5 text-[13px] text-ink"
            />
          </label>
          <label className="min-w-0 flex-1 text-[11px] font-medium text-muted">
            To
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-line-strong bg-paper px-2 py-1.5 text-[13px] text-ink"
            />
          </label>
        </div>
      )}

      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-ink">
            {loading ? "Counting…" : `${total.reports} report${total.reports === 1 ? "" : "s"}`}
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
            disabled={!rows || total.reports === 0}
            className="flex items-center gap-1.5 rounded-full bg-mist px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-line disabled:opacity-40"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <a
            href={`/api/reports/export?${exportQuery}`}
            download
            title="The reports as an Excel file"
            aria-disabled={!rangeOk}
            className={`flex items-center gap-1.5 rounded-full bg-brand-600 px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-brand-700 ${
              rangeOk ? "" : "pointer-events-none opacity-40"
            }`}
          >
            <FileSpreadsheet className="size-3.5" />
            Excel
          </a>
          <a
            href={`/api/reports/export?${exportQuery}&format=csv`}
            download
            title="The same reports as a CSV file"
            aria-disabled={!rangeOk}
            className={`flex items-center rounded-full bg-mist px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-line ${
              rangeOk ? "" : "pointer-events-none opacity-40"
            }`}
          >
            CSV
          </a>
        </div>
      </div>

      {error && (
        <p className="px-3 pb-3 text-[13px] text-muted">
          Couldn&apos;t load the totals. Try again.
        </p>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {rows !== null && rows.length > 1 && total.reports > 0 && (
          <PersonRow name="Total" reports={total.reports} values={total} strong />
        )}
        {(rows ?? []).map((r) => (
          <PersonRow key={r.user_id} name={r.person} reports={Number(r.reports)} values={r} />
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

function PersonRow({
  name,
  reports,
  values,
  strong = false,
}: {
  name: string;
  reports: number;
  values: Record<NumKey, number>;
  strong?: boolean;
}) {
  return (
    <li className={`rounded-xl px-2.5 py-2 ${strong ? "bg-mist/60" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <span className={`min-w-0 flex-1 truncate text-[14px] text-ink ${strong ? "font-semibold" : ""}`}>
          {name}
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[12px] font-semibold tabular-nums ${
            reports > 0
              ? "bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
              : "bg-mist text-muted"
          }`}
          title="Reports sent"
        >
          {reports} {reports === 1 ? "report" : "reports"}
        </span>
      </div>
      {reports > 0 && (
        <dl className="mt-1.5 grid grid-cols-3 gap-x-2 gap-y-1">
          {NUMBERS.map((n) => (
            <div key={n.key} className="min-w-0">
              <dt className="truncate text-[10px] uppercase tracking-wide text-muted">{n.label}</dt>
              <dd className="text-[13px] font-semibold tabular-nums text-ink">
                {Number(values[n.key])}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

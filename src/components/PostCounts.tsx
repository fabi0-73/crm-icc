"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, FileSpreadsheet, RefreshCw } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Row = {
  user_id: string;
  person: string;
  appointments: number;
  other_posts: number;
  from_day: string;
  to_day: string;
};
type Period = "today" | "week" | "month" | "all" | "range";
/** One dialer × agent cell of the form appointments (0032). */
type Cell = {
  dialer_id: string;
  dialer_name: string;
  agent_name: string;
  appointments: number;
};

const LABELS: Record<Period, string> = {
  today: "Shift",
  week: "Week",
  month: "Month",
  all: "All",
  range: "Dates",
};

/** Today's date on this device, YYYY-MM-DD — only a starting value for
 *  the date pickers; the person chooses the days themselves. */
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Appointments per person over a shift, week or month.
 *
 * Two things here are deliberate and easy to get wrong:
 *
 * The presets are named, not dated — the server works out the range in
 * Tirane time, so a phone set to the wrong timezone cannot move anybody's
 * numbers. "Dates" takes explicit shift days (from, to) instead. A "day" turns over at NOON, because the shift runs 15:00 to
 * 06:00 and a calendar day would cut every one of them in half.
 *
 * Appointments are counted, not messages. Most of what is posted in that
 * group is conversation; counting all of it overstated the real figure
 * roughly threefold. The server decides what looks like a record — see
 * private.looks_like_appointment.
 */
export function PostCounts({
  roomId,
  excel = false,
  reviewer = false,
}: {
  roomId: string;
  /** Offer the form-entered appointments as an Excel file (0023). */
  excel?: boolean;
  /** Admins and managers: filter by agent and dialer, or count per agent. */
  reviewer?: boolean;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [period, setPeriod] = useState<Period>("today");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [from, setFrom] = useState(localToday);
  const [to, setTo] = useState(localToday);
  const rangeOk = period !== "range" || (Boolean(from) && Boolean(to) && from <= to);
  const filters = excel && reviewer;
  const [cells, setCells] = useState<Cell[] | null>(null);
  const [groupBy, setGroupBy] = useState<"dialer" | "agent">("dialer");
  const [agent, setAgent] = useState("");
  const [dialer, setDialer] = useState("");
  /** The filtered view counts form appointments per dialer or per agent;
   *  the plain view is the original per-person count. */
  const filtered = filters && (groupBy === "agent" || Boolean(agent) || Boolean(dialer));

  const load = useCallback(async () => {
    if (period === "range" && !(from && to && from <= to)) return;
    setLoading(true);
    setError(false);
    if (filters) {
      const { data: cellData } =
        period === "range"
          ? await supabase.rpc("appointment_breakdown_range", {
              p_room: roomId,
              p_from: from,
              p_to: to,
            })
          : await supabase.rpc("appointment_breakdown", {
              p_room: roomId,
              p_period: period,
            });
      setCells((cellData ?? []) as Cell[]);
    }
    const { data, error: rpcError } =
      period === "range"
        ? await supabase.rpc("room_post_counts_range", {
            p_room: roomId,
            p_from: from,
            p_to: to,
          })
        : await supabase.rpc("room_post_counts", {
            p_room: roomId,
            p_period: period,
          });
    setLoading(false);
    if (rpcError) {
      setError(true);
      return;
    }
    setRows((data ?? []) as Row[]);
  }, [supabase, roomId, period, from, to, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  // The filter choices: everyone with an appointment in the period, plus
  // a choice already made (so changing the period never drops it).
  const dialerNames = useMemo(() => {
    const m = new Map<string, string>();
    (cells ?? []).forEach((c) => m.set(c.dialer_id, c.dialer_name));
    return m;
  }, [cells]);
  const dialerOptions = [...dialerNames.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const agentOptions = [...new Set((cells ?? []).map((c) => c.agent_name)).add(agent)]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const dialerLabel = dialer ? (dialerNames.get(dialer) ?? "") : "";

  /** The filtered view's lines: name → appointments, most first. */
  const lines = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of cells ?? []) {
      if (agent && c.agent_name !== agent) continue;
      if (dialer && c.dialer_id !== dialer) continue;
      const key = groupBy === "agent" ? c.agent_name : c.dialer_name;
      m.set(key, (m.get(key) ?? 0) + Number(c.appointments));
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [cells, agent, dialer, groupBy]);

  const exportQuery =
    (period === "range"
      ? `room=${roomId}&from=${from}&to=${to}`
      : `room=${roomId}&period=${period}`) +
    (filters && agent ? `&agent=${encodeURIComponent(agent)}` : "") +
    (filters && dialerLabel ? `&dialer=${encodeURIComponent(dialerLabel)}` : "");
  const totalAppts = filtered
    ? lines.reduce((n, [, v]) => n + v, 0)
    : (rows ?? []).reduce((n, r) => n + Number(r.appointments), 0);
  const span = rows?.[0];

  const copy = async () => {
    if (!rows) return;
    const head =
      (span && span.from_day === span.to_day
        ? `Appointments — ${span.from_day}`
        : `Appointments — ${span?.from_day} to ${span?.to_day}`) +
      (filtered && agent ? ` · agent ${agent}` : "") +
      (filtered && dialerLabel ? ` · dialer ${dialerLabel}` : "");
    const body = filtered
      ? lines.map(([name, n]) => `${name}: ${n}`).join("\n")
      : rows
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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

      {filters && (
        <div className="shrink-0 space-y-2 px-3 pt-2.5">
          <div className="flex gap-1 rounded-lg bg-mist p-0.5">
            {(["dialer", "agent"] as const).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => setGroupBy(g)}
                aria-pressed={groupBy === g}
                className={`h-7 flex-1 rounded-md text-[12px] font-semibold transition-colors ${
                  groupBy === g ? "bg-paper text-ink shadow-xs" : "text-muted hover:text-ink"
                }`}
              >
                {g === "dialer" ? "Per dialer" : "Per agent"}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <select
              aria-label="Filter by dialer"
              value={dialer}
              onChange={(e) => setDialer(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-line-strong bg-paper px-2 py-1.5 text-[13px] text-ink"
            >
              <option value="">All dialers</option>
              {dialer && !dialerNames.has(dialer) && <option value={dialer}>(no appointments)</option>}
              {dialerOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by agent"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-line-strong bg-paper px-2 py-1.5 text-[13px] text-ink"
            >
              <option value="">All agents</option>
              {agentOptions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

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
              {filtered && " · form entries"}
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
          {excel && (
            // A plain link: the route answers with the file itself, named
            // for the period, and runs as whoever clicks it.
            <a
              href={`/api/appointments/export?${exportQuery}`}
              download
              title="Appointments entered with the form, as an Excel file"
              aria-disabled={!rangeOk}
              className={`flex items-center gap-1.5 rounded-full bg-brand-600 px-2.5 py-1.5 text-[12px] font-semibold text-white hover:bg-brand-700 ${
                rangeOk ? "" : "pointer-events-none opacity-40"
              }`}
            >
              <FileSpreadsheet className="size-3.5" />
              Excel
            </a>
          )}
          {excel && (
            <a
              href={`/api/appointments/export?${exportQuery}&format=csv`}
              download
              title="The same appointments as a CSV file"
              aria-disabled={!rangeOk}
              className={`flex items-center rounded-full bg-mist px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:bg-line ${
                rangeOk ? "" : "pointer-events-none opacity-40"
              }`}
            >
              CSV
            </a>
          )}
        </div>
      </div>

      {error && (
        <p className="px-3 pb-3 text-[13px] text-muted">
          Couldn&apos;t load the counts. Try again.
        </p>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {filtered &&
          lines.map(([name, n]) => (
            <li
              key={name}
              className="flex items-center justify-between gap-3 rounded-xl px-2.5 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{name}</span>
              <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[13px] font-semibold tabular-nums text-brand-700 dark:bg-brand-950 dark:text-brand-300">
                {n}
              </span>
            </li>
          ))}
        {filtered && cells !== null && lines.length === 0 && !error && (
          <li className="px-2.5 py-6 text-center text-[13px] text-muted">
            No appointments match.
          </li>
        )}
        {!filtered && (rows ?? []).map((r) => (
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
        {!filtered && rows !== null && rows.length === 0 && !error && (
          <li className="px-2.5 py-6 text-center text-[13px] text-muted">
            Nothing in this period.
          </li>
        )}
      </ul>
    </div>
  );
}

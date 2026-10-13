import { createClient } from "@/lib/supabase/server";
import { buildXlsx, type Cell } from "@/lib/xlsx";
import { toCsv } from "@/lib/csv";

/**
 * A report group's reports (rooms.report_form, 0027) as an Excel file, or
 * CSV with `format=csv`, for a named period or for chosen shift days — the
 * same parameters as the appointments export. The Excel file has a second
 * sheet with each dialer's totals over the same days.
 *
 * Runs as the signed-in person: shift_reports_export returns only their own
 * reports, or everyone's for an admin or manager.
 */
export const dynamic = "force-dynamic";

const PERIODS = new Set(["today", "week", "month", "all"]);

type Row = {
  shift_day: string;
  dialer_name: string;
  pick_ups: number;
  appts: number;
  callbacks: number;
  hung_ups: number;
  others: number;
  wrong_numbers: number;
  comments: string | null;
  from_day: string;
  to_day: string;
};

const NUMBERS = [
  ["pick_ups", "Pick ups"],
  ["appts", "Appt"],
  ["callbacks", "Callbacks"],
  ["hung_ups", "Hung ups"],
  ["others", "Others"],
  ["wrong_numbers", "Wrong number"],
] as const;

/** "2026-10-02" as a date cell, kept on that calendar day. */
const day = (iso: string): Cell => new Date(`${iso}T00:00:00Z`);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const room = url.searchParams.get("room") ?? "";
  const period = url.searchParams.get("period") ?? "today";
  const csv = url.searchParams.get("format") === "csv";
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const isDay = (d: string | null) => d !== null && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const ranged = isDay(from) && isDay(to);
  if (!/^[0-9a-f-]{36}$/i.test(room) || (!ranged && !PERIODS.has(period))) {
    return new Response("Bad request", { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Sign in first", { status: 401 });

  const { data, error } = ranged
    ? await supabase.rpc("shift_reports_export_range", {
        p_room: room,
        p_from: from,
        p_to: to,
      })
    : await supabase.rpc("shift_reports_export", {
        p_room: room,
        p_period: period,
      });
  if (error) return new Response("Could not load reports", { status: 500 });
  const rows = (data ?? []) as Row[];

  const columns = [
    { header: "Data", width: 12 },
    { header: "Dialer", width: 22 },
    ...NUMBERS.map(([, label]) => ({ header: label, width: 13 })),
    { header: "Comments", width: 50 },
  ];
  const cells: Cell[][] = rows.map((r) => [
    day(r.shift_day),
    r.dialer_name,
    ...NUMBERS.map(([k]) => Number(r[k])),
    r.comments,
  ]);

  const first = rows[0];
  const span = ranged
    ? from === to
      ? from
      : `${from} to ${to}`
    : !first
      ? period
      : period === "all"
        ? `all to ${first.to_day}`
        : first.from_day === first.to_day
          ? first.to_day
          : `${first.from_day} to ${first.to_day}`;
  if (csv) {
    const name = `Raportet ${span}.csv`;
    return new Response(toCsv(columns.map((c) => c.header), cells), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      },
    });
  }

  // Per dialer: reports sent and each number added up, most pick ups first.
  const perDialer = new Map<string, number[]>();
  for (const r of rows) {
    const t = perDialer.get(r.dialer_name) ?? new Array(NUMBERS.length + 1).fill(0);
    t[0] += 1;
    NUMBERS.forEach(([k], i) => (t[i + 1] += Number(r[k])));
    perDialer.set(r.dialer_name, t);
  }
  const summary = [...perDialer.entries()].sort(
    (a, b) => b[1][1] - a[1][1] || a[0].localeCompare(b[0]),
  );
  const totals = new Array(NUMBERS.length + 1).fill(0);
  for (const [, t] of summary) t.forEach((n, i) => (totals[i] += n));

  const file = buildXlsx([
    { name: "Raportet", columns, rows: cells },
    {
      name: "Sipas dialerit",
      columns: [
        { header: "Dialer", width: 24 },
        { header: "Raporte", width: 10 },
        ...NUMBERS.map(([, label]) => ({ header: label, width: 13 })),
      ],
      rows: [
        ...summary.map(([dialer, t]): Cell[] => [dialer, ...t]),
        ["Totali", ...totals],
      ],
    },
  ]);
  const name = `Raportet ${span}.xlsx`;
  return new Response(file as BodyInit, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}

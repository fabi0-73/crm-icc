import { createClient } from "@/lib/supabase/server";
import { buildXlsx, type Cell } from "@/lib/xlsx";

/**
 * The appointments of a group as an Excel file (or CSV, `format=csv`), for
 * a named period (the same Shift / Week / Month / All as the counts tab,
 * worked out on the server in Tirane time) or for chosen shift days (`from`
 * and `to`, YYYY-MM-DD). The Excel file has a second sheet with each
 * dialer's total over the same days.
 *
 * Runs as the signed-in person: appointments_export returns only their own
 * appointments, or everyone's for an admin or manager, so this route adds
 * no rule of its own.
 */
export const dynamic = "force-dynamic";

const PERIODS = new Set(["today", "week", "month", "all"]);

type Row = {
  shift_day: string;
  dialer_name: string;
  agent_name: string;
  policy_number: string | null;
  client_name: string;
  phone: string;
  appt_date: string;
  appt_time: string;
  appt_tz: string | null;
  from_day: string;
  to_day: string;
};

/** "2026-10-02" as a date cell, kept on that calendar day. */
const day = (iso: string): Cell => new Date(`${iso}T00:00:00Z`);

/** "15:00:00" + "EST" → "3:00 PM EST". */
function clock(time: string, tz: string | null): string {
  const [h, m] = time.split(":").map(Number);
  const hour = ((h + 11) % 12) + 1;
  return `${hour}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}${tz ? ` ${tz}` : ""}`;
}

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
    ? await supabase.rpc("appointments_export_range", {
        p_room: room,
        p_from: from,
        p_to: to,
      })
    : await supabase.rpc("appointments_export", {
        p_room: room,
        p_period: period,
      });
  if (error) return new Response("Could not load appointments", { status: 500 });
  const rows = (data ?? []) as Row[];

  // The columns the team asked for, in their order and their words.
  const columns = [
    { header: "Data sotme", width: 12 },
    { header: "Emri i dialerit", width: 20 },
    { header: "Agjenti", width: 20 },
    { header: "Policy #", width: 16 },
    { header: "Emri klientit", width: 24 },
    { header: "Phone number", width: 17 },
    { header: "Data e takimit", width: 14 },
    { header: "Ora e takimit", width: 14 },
  ];
  const cells: Cell[][] = rows.map((r) => [
    day(r.shift_day),
    r.dialer_name,
    r.agent_name,
    r.policy_number,
    r.client_name,
    r.phone,
    day(r.appt_date),
    clock(r.appt_time, r.appt_tz),
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
    const name = `Takimet ${span}.csv`;
    return new Response(toCsv(columns.map((c) => c.header), cells), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Cache-Control": "no-store",
      },
    });
  }

  // Per dialer, most first: what each person booked over the same days.
  const perDialer = new Map<string, number>();
  for (const r of rows) {
    perDialer.set(r.dialer_name, (perDialer.get(r.dialer_name) ?? 0) + 1);
  }
  const summary = [...perDialer.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  const file = buildXlsx([
    { name: "Takimet", columns, rows: cells },
    {
      name: "Sipas dialerit",
      columns: [
        { header: "Emri i dialerit", width: 24 },
        { header: "Takime", width: 10 },
      ],
      rows: [
        ...summary.map(([dialer, n]): Cell[] => [dialer, n]),
        ["Totali", rows.length],
      ],
    },
  ]);
  const name = `Takimet ${span}.xlsx`;
  return new Response(file as BodyInit, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}

/**
 * The same sheet as CSV. A byte-order mark so Excel reads the letters
 * (ë, ç) as UTF-8, CRLF line ends, dates as dd/mm/yyyy like the Excel file,
 * and every value quoted, so a phone number keeps its formatting and a
 * comma in a name cannot shift the columns.
 */
function toCsv(headers: string[], rows: Cell[][]): string {
  const text = (v: Cell) => {
    if (v === null) return "";
    if (v instanceof Date) {
      const dd = String(v.getUTCDate()).padStart(2, "0");
      const mm = String(v.getUTCMonth() + 1).padStart(2, "0");
      return `${dd}/${mm}/${v.getUTCFullYear()}`;
    }
    return String(v);
  };
  const quote = (v: Cell) => `"${text(v).replace(/"/g, '""')}"`;
  return (
    "\uFEFF" +
    [headers, ...rows].map((r) => r.map(quote).join(",")).join("\r\n") +
    "\r\n"
  );
}

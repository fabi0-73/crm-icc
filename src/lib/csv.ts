import type { Cell } from "@/lib/xlsx";

/**
 * A sheet as CSV. A byte-order mark so Excel reads the letters
 * (ë, ç) as UTF-8, CRLF line ends, dates as dd/mm/yyyy like the Excel file,
 * and every value quoted, so a phone number keeps its formatting and a
 * comma in a name cannot shift the columns.
 */
export function toCsv(headers: string[], rows: Cell[][]): string {
  const text = (v: Cell) => {
    if (v === null) return "";
    if (v instanceof Date) {
      const dd = String(v.getUTCDate()).padStart(2, "0");
      const mm = String(v.getUTCMonth() + 1).padStart(2, "0");
      return `${dd}/${mm}/${v.getUTCFullYear()}`;
    }
    return String(v);
  };
  // Quoting does not stop Excel evaluating a cell that starts with = + - @
  // (a client name like =HYPERLINK(...) would run): such a value gets a
  // leading apostrophe, which Excel shows as plain text. A phone number's
  // leading "+" followed by digits is left alone.
  const safe = (s: string) =>
    /^[=+\-@\t\r]/.test(s) && !/^\+[\d\s()-]+$/.test(s) ? `'${s}` : s;
  const quote = (v: Cell) => `"${safe(text(v)).replace(/"/g, '""')}"`;
  return (
    "\uFEFF" +
    [headers, ...rows].map((r) => r.map(quote).join(",")).join("\r\n") +
    "\r\n"
  );
}

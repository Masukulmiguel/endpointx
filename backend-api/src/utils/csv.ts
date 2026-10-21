/**
 * CSV cell formatting shared by the CSV exports.
 *
 * Two concerns, both load-bearing:
 *
 * 1. Quoting — a value may contain commas, quotes or newlines, so every cell
 *    is wrapped in double quotes and inner quotes are doubled (RFC 4180).
 *
 * 2. Formula injection — export rows carry third-party content (device
 *    hostnames, alert titles, analysed artifact findings). A cell starting
 *    with `=`, `+`, `-`, `@`, TAB or CR is evaluated as a formula by Excel
 *    and Sheets, so opening the file can execute a crafted expression. The
 *    canonical mitigation is to prefix the value with a single quote, which
 *    spreadsheets treat as "literal text" — the cell then displays the
 *    original characters without the leading quote.
 */

const DANGEROUS_CELL_PREFIX = /^[=+\-@\t\r]/;

/** Format one cell: quoted, inner quotes doubled, formula-leading values neutralised. */
export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (DANGEROUS_CELL_PREFIX.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Format a whole document: one row per array, CRLF-free line breaks. */
export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

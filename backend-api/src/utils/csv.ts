/**
 * CSV cell formatting shared by the CSV exports.
 *
 * Three concerns, all load-bearing:
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
 *
 * 3. Not neutralising what cannot be a formula — a real number is never a
 *    formula, so a negative metric must not be turned into text. Values that
 *    are numeric by construction are marked with `csvLiteral` (or passed as
 *    an actual number) and skip the neutralisation.
 *
 * Null and undefined render as an empty cell, never as the text "null".
 */

const DANGEROUS_CELL_PREFIX = /^[=+\-@\t\r]/;

const SAFE_LITERAL = Symbol('csvSafeLiteral');

/** A pre-formatted value that is known not to be attacker-controlled text. */
export interface CsvLiteral {
  readonly [SAFE_LITERAL]: true;
  readonly text: string;
}

/**
 * Mark a pre-formatted value (an already-rounded number, a fixed enum) as a
 * safe literal: it is quoted like any other cell but never neutralised, so a
 * negative metric stays a number instead of becoming text.
 */
export function csvLiteral(text: string | number): CsvLiteral {
  return { [SAFE_LITERAL]: true, text: String(text) };
}

const isCsvLiteral = (value: unknown): value is CsvLiteral =>
  typeof value === 'object' && value !== null && SAFE_LITERAL in value;

/** Format one cell: quoted, inner quotes doubled, formula-leading text neutralised. */
export function csvCell(value: unknown): string {
  let text: string;
  let neutralise = true;
  if (isCsvLiteral(value)) {
    text = value.text;
    neutralise = false;
  } else if (typeof value === 'number') {
    // A real number cannot be a formula.
    text = String(value);
    neutralise = false;
  } else {
    text = String(value ?? '');
  }
  if (neutralise && DANGEROUS_CELL_PREFIX.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** Format a whole document: one row per array, CRLF-free line breaks. */
export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

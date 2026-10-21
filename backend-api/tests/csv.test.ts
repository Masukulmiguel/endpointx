/**
 * Unit tests for the shared CSV formatter.
 *
 * The formatter has two jobs that must both hold: RFC 4180 quoting and
 * formula-injection neutralisation. The injection half is a security
 * property — exported rows carry third-party content (hostnames, alert
 * titles, analysed artifact findings) and Excel/Sheets evaluate a cell
 * starting with =, +, -, @, TAB or CR as a formula, so opening the file can
 * execute a crafted expression.
 *
 * Run: npx tsx tests/csv.test.ts
 */
import './testEnv';
import assert from 'assert';
import { csvCell, csvLiteral, toCsv } from '../src/utils/csv';

let failed = 0;
const check = (label: string, fn: () => void): void => {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${(error as Error).message}`);
  }
};

console.log('\nCSV formatter\n');

// ---- Quoting (RFC 4180) ---------------------------------------------------
check('csvCell quotes a plain value', () => {
  assert.strictEqual(csvCell('admin'), '"admin"');
});

check('csvCell doubles inner quotes', () => {
  assert.strictEqual(csvCell('Open port 8080, "admin" panel'), '"Open port 8080, ""admin"" panel"');
});

check('csvCell renders null and undefined as empty strings', () => {
  assert.strictEqual(csvCell(null), '""', 'null must be an empty cell, never the text "null"');
  assert.strictEqual(csvCell(undefined), '""');
});

check('csvCell keeps a zero (falsy but meaningful) value', () => {
  assert.strictEqual(csvCell(0), '"0"');
});

// ---- Formula injection ----------------------------------------------------
const DANGEROUS = [
  ['=HYPERLINK("http://evil.local","click")', '='],
  ['+cmd|calc', '+'],
  ['-1+1', '-'],
  ['@SUM(A1:A2)', '@'],
  ['\tvalue', 'TAB'],
  ['\rvalue', 'CR'],
] as const;

for (const [value, label] of DANGEROUS) {
  check(`csvCell neutralises a leading ${label}`, () => {
    const cell = csvCell(value);
    const inner = cell.slice(1, -1); // strip the surrounding quotes
    assert.ok(
      inner.startsWith("'"),
      `the value must be prefixed with a single quote, got ${JSON.stringify(inner)}`
    );
    assert.ok(
      !/^[=+\-@\t\r]/.test(inner),
      `no formula character may lead the cell, got ${JSON.stringify(inner)}`
    );
  });
}

check('csvCell leaves a safe value untouched', () => {
  assert.strictEqual(csvCell('hostname.example.local'), '"hostname.example.local"');
  assert.strictEqual(csvCell('a-b-c'), '"a-b-c"', 'a dash inside the value is harmless');
  assert.strictEqual(csvCell('total=10'), '"total=10"', 'an equals sign inside the value is harmless');
});

// ---- Values that cannot be formulas ---------------------------------------
check('csvCell does not neutralise a real number', () => {
  assert.strictEqual(csvCell(-3.25), '"-3.25"', 'a negative metric must stay a number, not text');
  assert.strictEqual(csvCell(42), '"42"');
});

check('csvCell does not neutralise a value marked as a literal', () => {
  assert.strictEqual(csvLiteral(-3.25) && csvCell(csvLiteral(-3.25)), '"-3.25"');
  assert.strictEqual(csvCell(csvLiteral('-3.25')), '"-3.25"');
});

check('csvCell still quotes a literal that contains a comma', () => {
  assert.strictEqual(csvCell(csvLiteral('1,234')), '"1,234"');
});

// ---- Document assembly -----------------------------------------------------
check('toCsv renders one line per row', () => {
  const csv = toCsv([
    ['Hostname', 'Status'],
    ['pc-01', 'online'],
  ]);
  assert.strictEqual(csv, '"Hostname","Status"\n"pc-01","online"');
});

check('toCsv keeps the header row unneutralised', () => {
  const csv = toCsv([['ID', 'Job ID'], ['a', 'b']]);
  assert.strictEqual(csv.split('\n')[0], '"ID","Job ID"');
});

check('toCsv neutralises a dangerous cell anywhere in the document', () => {
  const csv = toCsv([
    ['Hostname'],
    ['=1+1'],
  ]);
  const lines = csv.split('\n');
  assert.strictEqual(lines[1], '"\'=1+1"');
});

check('toCsv handles an empty document', () => {
  assert.strictEqual(toCsv([]), '');
});

console.log(failed === 0 ? '\nALL PASS\n' : `\n${failed} test(s) FAILED\n`);
if (failed > 0) process.exit(1);

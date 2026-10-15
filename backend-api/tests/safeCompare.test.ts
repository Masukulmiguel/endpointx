/**
 * safeCompare must only return true for two equal strings; headers arrive as
 * string | string[] | undefined, so non-strings and length mismatches must
 * fail closed. Run: npx tsx tests/safeCompare.test.ts
 */
import './testEnv';
import assert from 'assert';
import { safeCompare } from '../src/utils/helpers';

let failed = 0;
const check = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${(error as Error).message}`);
  }
};

check('equal strings match', () => {
  assert.strictEqual(safeCompare('abc', 'abc'), true);
});

check('different strings do not match', () => {
  assert.strictEqual(safeCompare('abc', 'abd'), false);
});

check('different lengths do not match', () => {
  assert.strictEqual(safeCompare('abc', 'abcd'), false);
});

check('undefined header fails closed', () => {
  assert.strictEqual(safeCompare(undefined, 'x'), false);
});

check('repeated header (string[]) fails closed', () => {
  assert.strictEqual(safeCompare(['x'], 'x'), false);
});

check('AGENT_SECRET compared against itself', () => {
  assert.strictEqual(
    safeCompare(process.env.AGENT_SECRET, process.env.AGENT_SECRET),
    true
  );
});

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;

/**
 * OUI vendor lookup: IEEE oui-data prefix matching + sanitization.
 * Run: npx tsx tests/ouiLookup.test.ts
 */
import assert from 'assert';
import { vendorFromMac } from '../src/utils/oui';

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

// Fixtures pinned against oui-data@2.1.39 (verified via node -e at plan time)

check('B827EB resolves Raspberry Pi Foundation (colon-separated)', () => {
  const v = vendorFromMac('B8:27:EB:00:00:01');
  assert.ok(v, 'vendor should not be null');
  assert.ok(v!.includes('Raspberry Pi Foundation'), `got: ${v}`);
});

check('B827EB resolves (dash-separated)', () => {
  const v = vendorFromMac('B8-27-EB-AA-BB-CC');
  assert.ok(v!.includes('Raspberry Pi Foundation'), `got: ${v}`);
});

check('B827EB resolves (bare hex, lowercase)', () => {
  const v = vendorFromMac('b827eb112233');
  assert.ok(v!.includes('Raspberry Pi Foundation'), `got: ${v}`);
});

check('F4F5D8 resolves Google, Inc.', () => {
  const v = vendorFromMac('F4:F5:D8:11:22:33');
  assert.ok(v!.includes('Google, Inc.'), `got: ${v}`);
});

check('005056 resolves VMware, Inc.', () => {
  const v = vendorFromMac('00:50:56:AA:BB:CC');
  assert.ok(v!.includes('VMware, Inc.'), `got: ${v}`);
});

check('unregistered OUI FFFF99 returns null', () => {
  assert.strictEqual(vendorFromMac('FF:FF:F9:00:00:01'), null);
});

check('garbage input returns null', () => {
  assert.strictEqual(vendorFromMac('not-a-mac'), null);
});

check('empty string returns null', () => {
  assert.strictEqual(vendorFromMac(''), null);
});

check('null returns null', () => {
  assert.strictEqual(vendorFromMac(null), null);
});

check('undefined returns null', () => {
  assert.strictEqual(vendorFromMac(undefined), null);
});

check('too-short hex returns null', () => {
  assert.strictEqual(vendorFromMac('B8:27'), null);
});

check('vendor value is whitespace-collapsed (no newlines) and <= 150 chars', () => {
  const v = vendorFromMac('B8:27:EB:00:00:01');
  assert.ok(v, 'vendor should not be null');
  assert.ok(!v!.includes('\n'), 'vendor must not contain newlines');
  assert.ok(v!.length <= 150, `vendor too long: ${v!.length}`);
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log('\nALL PASS ouiLookup');

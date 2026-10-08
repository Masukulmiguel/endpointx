/**
 * RED->GREEN gate for Task 4: credentials must never reach notification_log,
 * and the free "user" role must not carry logs.view.
 * Run: npx tsx tests/emailRedaction.test.ts
 */
import './testEnv';
import assert from 'assert';
import * as emailService from '../src/services/emailService';
import * as database from '../src/config/database';

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

const redact = (body: string): string => {
  const fn = (emailService as { redactEmailBody?: unknown }).redactEmailBody;
  if (typeof fn !== 'function') throw new Error('redactEmailBody not exported');
  return (fn as (b: string) => string)(body);
};

const seedPerms = (): Record<string, string[]> | undefined =>
  (database as { SEED_ROLE_PERMISSIONS?: Record<string, string[]> }).SEED_ROLE_PERMISSIONS;

const RESET_HTML = '<p>Click <a href="https://app.endpointx.io/reset-password?token=SECRET123abc">here</a> to reset.</p>';
const INVITE_HTML = '<p><strong>Temporary Password:</strong> Ab3!xyzPw </p><p>Sign in and change it.</p>';
const ALERT_HTML = '<p>CPU on workstation-7 is above 90% for 5 minutes.</p>';

check('redactEmailBody is exported', () => {
  assert.strictEqual(typeof (emailService as { redactEmailBody?: unknown }).redactEmailBody, 'function');
});

check('reset link token redacted', () => {
  const out = redact(RESET_HTML);
  assert.ok(!out.includes('SECRET123abc'), 'token still present');
  assert.ok(/token=\[REDACTED\]/.test(out), `expected ?token=[REDACTED], got: ${out}`);
});

check('temporary password redacted, structure intact', () => {
  const out = redact(INVITE_HTML);
  assert.ok(!out.includes('Ab3!xyzPw'), 'password still present');
  assert.ok(out.includes('<strong>Temporary Password:</strong>'), 'strong tag lost');
  assert.ok(out.includes('</p>'), 'paragraph structure lost');
  assert.ok(out.includes('[REDACTED]'), 'redaction marker missing');
});

check('ordinary body passes through byte-identical', () => {
  assert.strictEqual(redact(ALERT_HTML), ALERT_HTML);
});

check('SEED_ROLE_PERMISSIONS exported', () => {
  assert.strictEqual(typeof seedPerms(), 'object');
  assert.ok(seedPerms(), 'SEED_ROLE_PERMISSIONS undefined');
});

check('free user role has no logs.view', () => {
  const perms = seedPerms();
  assert.ok(perms && Array.isArray(perms.user), 'user role missing');
  assert.ok(!perms!.user.includes('logs.view'), 'user role still grants logs.view');
});

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;

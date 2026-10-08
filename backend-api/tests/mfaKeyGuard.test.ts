/**
 * RED->GREEN gate for Task 6b: crypto keys must come from the environment
 * (32 chars, no hardcoded fallbacks) and the route files must no longer
 * ship the published defaults.
 * Run: npx tsx tests/mfaKeyGuard.test.ts
 */
import './testEnv';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import * as helpers from '../src/utils/helpers';

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

const getRequired = (envName: string, ...fallbacks: string[]): string => {
  const fn = (helpers as { getRequiredEncryptionKey?: unknown }).getRequiredEncryptionKey;
  if (typeof fn !== 'function') throw new Error('getRequiredEncryptionKey not exported');
  return (fn as (a: string, ...b: string[]) => string)(envName, ...fallbacks);
};

check('getRequiredEncryptionKey is exported', () => {
  assert.strictEqual(typeof (helpers as { getRequiredEncryptionKey?: unknown }).getRequiredEncryptionKey, 'function');
});

check('missing env -> throws', () => {
  delete process.env.MFA_ENCRYPTION_KEY;
  delete process.env.SSO_ENCRYPTION_KEY;
  assert.throws(() => getRequired('MFA_ENCRYPTION_KEY'), /must be set to a 32-character key/);
});

check('too-short env -> throws', () => {
  process.env.MFA_ENCRYPTION_KEY = 'short-key';
  assert.throws(() => getRequired('MFA_ENCRYPTION_KEY'), /must be set to a 32-character key/);
});

check('too-long env -> throws', () => {
  process.env.MFA_ENCRYPTION_KEY = 'x'.repeat(33);
  assert.throws(() => getRequired('MFA_ENCRYPTION_KEY'), /must be set to a 32-character key/);
});

check('32-char env -> returned', () => {
  process.env.MFA_ENCRYPTION_KEY = 'a'.repeat(32);
  assert.strictEqual(getRequired('MFA_ENCRYPTION_KEY'), 'a'.repeat(32));
});

check('fallback env name used when primary missing', () => {
  delete process.env.MFA_ENCRYPTION_KEY;
  process.env.SSO_ENCRYPTION_KEY = 'b'.repeat(32);
  assert.strictEqual(getRequired('SSO_ENCRYPTION_KEY', 'MFA_ENCRYPTION_KEY'), 'b'.repeat(32));
  delete process.env.SSO_ENCRYPTION_KEY;
});

check('mfa.ts no longer ships hardcoded key', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'mfa.ts'), 'utf-8');
  assert.ok(!src.includes('endpointx-mfa-key-change'), 'mfa.ts still contains the published default key');
});

check('sso.ts no longer ships hardcoded key', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'sso.ts'), 'utf-8');
  assert.ok(!src.includes('endpointx-sso-key-change'), 'sso.ts still contains the published default key');
});

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;

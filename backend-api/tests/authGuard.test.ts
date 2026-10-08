/**
 * RED->GREEN gate for Task 6a: session middleware must reject MFA temp
 * tokens and tokens without a role binding.
 * Run: npx tsx tests/authGuard.test.ts
 */
import './testEnv';
import assert from 'assert';
import { generateToken } from '../src/utils/helpers';
import { JWT } from '../src/config/constants';
import { authenticate, verifyAccessToken } from '../src/middleware/auth';

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

const mockRes = () => {
  const res = {
    statusCode: 200 as number,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
};

const callAuthenticate = async (token: string) => {
  const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} } as any;
  const res = mockRes();
  let nextCalls = 0;
  let nextError: unknown = 'not-called';
  await authenticate(req, res, (error?: unknown) => {
    nextCalls++;
    nextError = error;
  });
  return { req, res, nextCalls, nextError };
};

async function main(): Promise<void> {
  const mfaTemp = generateToken(
    { id: 'user-1', email: 'a@b.c', role_id: 'role-1', role_name: 'user', type: 'mfa_temp' },
    JWT.ACCESS_SECRET
  );
  const noRole = generateToken({ id: 'user-1', email: 'a@b.c' }, JWT.ACCESS_SECRET);
  const valid = generateToken(
    {
      id: 'user-1',
      email: 'a@b.c',
      role_id: 'role-1',
      role_name: 'user',
      permissions: ['x'],
    },
    JWT.ACCESS_SECRET
  );

  // 1. mfa_temp payload -> 401 even though signature/iss/aud are valid.
  {
    const { res, nextCalls } = await callAuthenticate(mfaTemp);
    check('authenticate rejects mfa_temp token -> 401', () => {
      assert.strictEqual(nextCalls, 0, 'next() was called for mfa_temp');
      assert.strictEqual(res.statusCode, 401, `got ${res.statusCode}`);
    });
  }

  // 2. token without role_id -> 401.
  {
    const { res, nextCalls } = await callAuthenticate(noRole);
    check('authenticate rejects token without role_id -> 401', () => {
      assert.strictEqual(nextCalls, 0, 'next() was called without role_id');
      assert.strictEqual(res.statusCode, 401, `got ${res.statusCode}`);
    });
  }

  // 3. valid session token still passes (guards against over-blocking).
  {
    const { req, res, nextCalls, nextError } = await callAuthenticate(valid);
    check('authenticate accepts valid session token', () => {
      assert.strictEqual(nextCalls, 1, `next() not called once (${String(nextError)})`);
      assert.strictEqual(nextError, undefined, 'next() received an error');
      assert.strictEqual(res.statusCode, 200, 'response was written instead of next()');
      assert.ok(req.user, 'req.user not set');
      assert.deepStrictEqual(req.user.permissions, ['x'], 'token permissions not preserved offline');
    });
  }

  // 4. verifyAccessToken also refuses mfa_temp.
  {
    const user = await verifyAccessToken(mfaTemp);
    check('verifyAccessToken returns null for mfa_temp', () => {
      assert.strictEqual(user, null, `got ${JSON.stringify(user)}`);
    });
  }

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

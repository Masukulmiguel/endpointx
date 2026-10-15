/**
 * RED->GREEN gate for Task 3: authenticate/verifyAccessToken must require a
 * live session row (sid claim -> user_sessions JOIN users) and reject revoked
 * sessions, inactive accounts, expired sessions, and tokens without sid.
 * FakePool is installed before middleware/auth is required, so the gate query
 * is scriptable per check. Existing checks 1-4 (mfa_temp, no role, valid
 * passes, verifyAccessToken mfa_temp) are preserved.
 * Run: npx tsx tests/authGuard.test.ts
 */
import './testEnv';
import assert from 'assert';
import { JWT } from '../src/config/constants';

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

// ---- Fake pg (installed before config/database is first required) --------
type ScriptedRow = { match: string; rows?: Record<string, unknown>[]; error?: Error };
const scripts: ScriptedRow[] = [];
const setScripts = (next: ScriptedRow[]): void => {
  scripts.length = 0;
  scripts.push(...next);
};

const respond = (sql: string, _params: unknown[] = []) => {
  for (const s of scripts) {
    if (sql.includes(s.match)) {
      if (s.error) throw s.error;
      const rows = s.rows ?? [];
      return { rows, rowCount: rows.length };
    }
  }
  return { rows: [], rowCount: 0 };
};

const record = (sql: string, params?: unknown[]) => respond(sql, params ?? []);

class FakeClient {
  query(sql: string, params?: unknown[]) {
    return Promise.resolve(record(sql, params));
  }
  release(): void {
    /* noop */
  }
}

class FakePool {
  constructor(_cfg: unknown) {}
  query(sql: string, params?: unknown[]) {
    return Promise.resolve(record(sql, params));
  }
  connect(): Promise<FakeClient> {
    return Promise.resolve(new FakeClient());
  }
  on(): this {
    return this;
  }
  end(): Promise<void> {
    return Promise.resolve();
  }
}

const pgPath = require.resolve('pg');
const realPg = require(pgPath) as Record<string, unknown>;
require.cache[pgPath]!.exports = { ...realPg, Pool: FakePool };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDatabase } = require('../src/config/database') as {
  initDatabase: () => Promise<void>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateToken } = require('../src/utils/helpers') as typeof import('../src/utils/helpers');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { authenticate, verifyAccessToken } = require('../src/middleware/auth') as typeof import('../src/middleware/auth');

const FUTURE = new Date(Date.now() + 3600e3).toISOString();
const PAST = new Date(Date.now() - 3600e3).toISOString();
const SID = '11111111-1111-4111-8111-111111111111';
const GATE_MATCH = 'JOIN users u ON u.id = s.user_id';
const PERMS_MATCH = 'JOIN role_permissions';

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

// Live-session scripts used by the "valid token" checks.
const liveSessionScripts = [
  { match: GATE_MATCH, rows: [{ expires_at: FUTURE, is_active: true }] },
  { match: PERMS_MATCH, rows: [{ code: 'x' }] },
];

async function main(): Promise<void> {
  await initDatabase();

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
      sid: SID,
    },
    JWT.ACCESS_SECRET
  );
  const noSid = generateToken(
    { id: 'user-1', email: 'a@b.c', role_id: 'role-1', role_name: 'user', permissions: ['x'] },
    JWT.ACCESS_SECRET
  );

  // 1. mfa_temp payload -> 401 even though signature/iss/aud are valid.
  {
    setScripts([]);
    const { res, nextCalls } = await callAuthenticate(mfaTemp);
    check('authenticate rejects mfa_temp token -> 401', () => {
      assert.strictEqual(nextCalls, 0, 'next() was called for mfa_temp');
      assert.strictEqual(res.statusCode, 401, `got ${res.statusCode}`);
    });
  }

  // 2. token without role_id -> 401.
  {
    setScripts([]);
    const { res, nextCalls } = await callAuthenticate(noRole);
    check('authenticate rejects token without role_id -> 401', () => {
      assert.strictEqual(nextCalls, 0, 'next() was called without role_id');
      assert.strictEqual(res.statusCode, 401, `got ${res.statusCode}`);
    });
  }

  // 3. valid session token (with sid + live session) still passes.
  {
    setScripts(liveSessionScripts);
    const { req, res, nextCalls, nextError } = await callAuthenticate(valid);
    check('authenticate accepts valid session token with live session', () => {
      assert.strictEqual(nextCalls, 1, `next() not called once (${String(nextError)})`);
      assert.strictEqual(nextError, undefined, 'next() received an error');
      assert.strictEqual(res.statusCode, 200, 'response was written instead of next()');
      assert.ok(req.user, 'req.user not set');
      assert.deepStrictEqual(req.user.permissions, ['x'], 'token permissions not preserved');
      assert.strictEqual(req.user.sid, SID, 'req.user.sid not populated');
    });
  }

  // 4. verifyAccessToken also refuses mfa_temp.
  {
    setScripts([]);
    const user = await verifyAccessToken(mfaTemp);
    check('verifyAccessToken returns null for mfa_temp', () => {
      assert.strictEqual(user, null, `got ${JSON.stringify(user)}`);
    });
  }

  // 5. token without sid -> 401 (RED before the gate: used to pass).
  {
    setScripts([]);
    const { res, nextCalls } = await callAuthenticate(noSid);
    check('authenticate rejects token without sid -> 401', () => {
      assert.strictEqual(nextCalls, 0, 'next() was called without sid');
      assert.strictEqual(res.statusCode, 401, `got ${res.statusCode}`);
    });
  }

  // 6. valid session token passes with sid claim + live session row.
  {
    setScripts(liveSessionScripts);
    const { req, nextCalls } = await callAuthenticate(valid);
    check('valid session token passes with sid claim and live row', () => {
      assert.strictEqual(nextCalls, 1, 'next() not called');
      assert.strictEqual(req.user.sid, SID, 'sid not on req.user');
      assert.deepStrictEqual(req.user.permissions, ['x'], 'permissions not loaded');
    });
  }

  // 7. revoked session (no row) -> 401 with AUTH_SESSION_INVALID.
  {
    setScripts([{ match: GATE_MATCH, rows: [] }]);
    const { res, nextCalls } = await callAuthenticate(valid);
    check('revoked session (no row) -> 401 AUTH_SESSION_INVALID', () => {
      assert.strictEqual(nextCalls, 0, 'next() was called for revoked session');
      assert.strictEqual(res.statusCode, 401, `got ${res.statusCode}`);
      const body = res.body as { error?: { code?: string } };
      assert.strictEqual(body.error?.code, 'AUTH_SESSION_INVALID', `code: ${String(body.error?.code)}`);
    });
  }

  // 8. inactive account -> 401.
  {
    setScripts([{ match: GATE_MATCH, rows: [{ expires_at: FUTURE, is_active: false }] }]);
    const { res, nextCalls } = await callAuthenticate(valid);
    check('inactive account -> 401', () => {
      assert.strictEqual(nextCalls, 0, 'next() was called for inactive account');
      assert.strictEqual(res.statusCode, 401, `got ${res.statusCode}`);
    });
  }

  // 9. expired session -> 401.
  {
    setScripts([{ match: GATE_MATCH, rows: [{ expires_at: PAST, is_active: true }] }]);
    const { res, nextCalls } = await callAuthenticate(valid);
    check('expired session -> 401', () => {
      assert.strictEqual(nextCalls, 0, 'next() was called for expired session');
      assert.strictEqual(res.statusCode, 401, `got ${res.statusCode}`);
    });
  }

  // 10. session lookup DB error fails closed (500, next not called).
  {
    setScripts([{ match: GATE_MATCH, error: new Error('db down') }]);
    const { res, nextCalls } = await callAuthenticate(valid);
    check('session lookup DB error fails closed (500, next not called)', () => {
      assert.strictEqual(nextCalls, 0, 'next() was called on DB error');
      assert.strictEqual(res.statusCode, 500, `got ${res.statusCode}`);
    });
  }

  // 11. verifyAccessToken returns null for revoked session.
  {
    setScripts([{ match: GATE_MATCH, rows: [] }]);
    const user = await verifyAccessToken(valid);
    check('verifyAccessToken returns null for revoked session', () => {
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

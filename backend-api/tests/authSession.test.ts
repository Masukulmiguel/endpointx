/**
 * RED->GREEN gate for Task 2: access tokens must carry a `sid` claim bound to
 * a real user_sessions row, and refresh must preserve that row (UPDATE, not
 * DELETE+INSERT). Runs against the real local DB via initDatabase() — no
 * FakePool; schema is created inline on init.
 * Run: npx tsx tests/authSession.test.ts
 * Exit code 0 = every assertion held, 1 = at least one failed.
 */
import './testEnv';
import assert from 'assert';
import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { JWT } from '../src/config/constants';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const speakeasy = require('speakeasy') as {
  generateSecret: () => { base32: string };
  totp: (opts: { secret: string; encoding: string }) => string;
};

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

const checkAsync = async (label: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${(error as Error).message}`);
  }
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDatabase, query } = require('../src/config/database') as {
  initDatabase: () => Promise<void>;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const decode = (token: string): Record<string, unknown> =>
  jwt.verify(token, JWT.ACCESS_SECRET, {
    issuer: JWT.ISSUER,
    audience: JWT.AUDIENCE,
  }) as Record<string, unknown>;

const runId = Date.now();
const PASSWORD = 'FaseC!Test2026';
let userSeq = 0;
const nextEmail = (): string => `fasec-${runId}-${++userSeq}@t.pt`;

async function main(): Promise<void> {
  await initDatabase();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { default: authRouter } = require('../src/routes/auth') as { default: express.Router };

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/auth`;

  const email1 = nextEmail();
  let accessToken1 = '';
  let refreshToken1 = '';
  let preRotationRefresh = '';
  let userId1 = '';

  try {
    // 1. register issues sid claim
    await checkAsync('register issues sid claim bound to a real session row', async () => {
      const res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email1, password: PASSWORD, full_name: 'Fase C One' }),
      });
      assert.strictEqual(res.status, 201, `register got ${res.status}`);
      const body = (await res.json()) as { data: { accessToken: string; refreshToken: string; user: { id: string } } };
      const sid = decode(body.data.accessToken).sid;
      assert.ok(typeof sid === 'string' && UUID_RE.test(sid as string), `sid not a UUID: ${String(sid)}`);
      const q = await query('SELECT id FROM user_sessions WHERE user_id = $1', [body.data.user.id]);
      assert.strictEqual(q.rows[0]?.id, sid, 'sid claim does not match the sessions row');
      accessToken1 = body.data.accessToken;
      refreshToken1 = body.data.refreshToken;
      userId1 = body.data.user.id;
    });

    // 2. login issues sid claim
    await checkAsync('login issues sid claim', async () => {
      const res = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email1, password: PASSWORD }),
      });
      assert.strictEqual(res.status, 200, `login got ${res.status}`);
      const body = (await res.json()) as { data: { accessToken: string; refreshToken: string } };
      const sid = decode(body.data.accessToken).sid;
      assert.ok(typeof sid === 'string' && UUID_RE.test(sid as string), `sid not a UUID: ${String(sid)}`);
      accessToken1 = body.data.accessToken;
      refreshToken1 = body.data.refreshToken;
    });

    // 3. mfa_verify issues sid claim (separate user)
    await checkAsync('mfa-verify issues sid claim', async () => {
      const email2 = nextEmail();
      const reg = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email2, password: PASSWORD, full_name: 'Fase C Two' }),
      });
      assert.strictEqual(reg.status, 201, `register user2 got ${reg.status}`);
      const regBody = (await reg.json()) as { data: { user: { id: string } } };
      const secret = speakeasy.generateSecret().base32;
      await query(
        'INSERT INTO user_mfa (user_id, mfa_secret, enabled) VALUES ($1, $2, true)',
        [regBody.data.user.id, Buffer.from(secret, 'utf8').toString('hex')]
      );
      const login = await fetch(`${base}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email2, password: PASSWORD }),
      });
      assert.strictEqual(login.status, 200, `mfa login got ${login.status}`);
      const loginBody = (await login.json()) as { data: { requiresMfa: boolean; tempToken: string } };
      assert.strictEqual(loginBody.data.requiresMfa, true, 'expected requiresMfa');
      const verify = await fetch(`${base}/mfa-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempToken: loginBody.data.tempToken,
          token: speakeasy.totp({ secret, encoding: 'base32' }),
        }),
      });
      assert.strictEqual(verify.status, 200, `mfa-verify got ${verify.status}`);
      const verifyBody = (await verify.json()) as { data: { accessToken: string } };
      const sid = decode(verifyBody.data.accessToken).sid;
      assert.ok(typeof sid === 'string' && UUID_RE.test(sid as string), `sid not a UUID: ${String(sid)}`);
    });

    // 4. refresh keeps sid stable (same row preserved)
    await checkAsync('refresh keeps sid stable', async () => {
      const sidBefore = decode(accessToken1).sid;
      preRotationRefresh = refreshToken1;
      const res = await fetch(`${base}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: refreshToken1 }),
      });
      assert.strictEqual(res.status, 200, `refresh got ${res.status}`);
      const body = (await res.json()) as { data: { accessToken: string; refreshToken: string } };
      assert.strictEqual(decode(body.data.accessToken).sid, sidBefore, 'sid changed across refresh');
      accessToken1 = body.data.accessToken;
      refreshToken1 = body.data.refreshToken;
    });

    // 5. old refresh token rejected after rotation
    await checkAsync('old refresh token rejected after rotation', async () => {
      const res = await fetch(`${base}/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: preRotationRefresh }),
      });
      assert.strictEqual(res.status, 401, `replay of pre-rotation token got ${res.status}`);
      void userId1;
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  }

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

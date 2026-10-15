/**
 * RED->GREEN gate for Task 5: mobile heartbeat requires a per-device
 * x-heartbeat-token (HMAC of endpointx:remote:<agent_id>), while mobile
 * register keeps minting remote_token for the same derivation.
 * Run: npx tsx tests/mobileHeartbeat.test.ts
 */
import './testEnv';
import assert from 'assert';
import crypto from 'crypto';
import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
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
type ScriptedRow = { match: string; rows: Record<string, unknown>[] };
const scripts: ScriptedRow[] = [];
const setScripts = (next: ScriptedRow[]): void => {
  scripts.length = 0;
  scripts.push(...next);
};

const respond = (sql: string) => {
  for (const s of scripts) {
    if (sql.includes(s.match)) return { rows: s.rows, rowCount: s.rows.length };
  }
  return { rows: [], rowCount: 0 };
};

class FakeClient {
  query(sql: string, params?: unknown[]) {
    void params;
    return Promise.resolve(respond(sql));
  }
  release(): void {
    /* noop */
  }
}

class FakePool {
  constructor(_cfg: unknown) {}
  query(sql: string, params?: unknown[]) {
    void params;
    return Promise.resolve(respond(sql));
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
const devicesRouter = require('../src/routes/devices').default as express.Router;

const DEV = 'd3a1f000000000000000000000000001';
const hmacFor = (agentId: string): string =>
  crypto
    .createHmac('sha256', process.env.AGENT_SECRET!)
    .update(`endpointx:remote:${agentId}`)
    .digest('hex');

const enrollToken = jwt.sign(
  { sub: '3ccbf05c-3ead-4f92-8da3-b22476aeb16', typ: 'enroll' },
  JWT.ACCESS_SECRET,
  { expiresIn: '1h' }
);

async function main(): Promise<void> {
  await initDatabase();
  const app = express();
  app.use(express.json());
  app.use('/api/devices', devicesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/devices`;

  try {
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    // 1. register mints remote_token equal to the per-device HMAC (existing row branch).
    {
      setScripts([
        { match: 'SELECT id, approval_status FROM devices WHERE agent_id', rows: [{ id: DEV, approval_status: 'pending' }] },
        { match: 'UPDATE devices SET', rows: [] },
      ]);
      const res = await post('/mobile/register', { device_name: 'Pixel FaseC', enroll_token: enrollToken });
      const body = (await res.json()) as { success: boolean; data: { agent_id: string; remote_token: string } };
      check('mobile register returns remote_token equal to per-device HMAC', () => {
        assert.strictEqual(res.status, 200, `got ${res.status}`);
        assert.ok(body.success, 'success flag');
        assert.match(body.data.remote_token, /^[0-9a-f]{64}$/, `not hex64: ${body.data.remote_token}`);
        assert.strictEqual(
          body.data.remote_token,
          hmacFor(body.data.agent_id),
          'remote_token != HMAC(endpointx:remote:<agent_id>)'
        );
      });
    }

    // 2. wrong heartbeat token rejected before the device lookup.
    {
      setScripts([
        { match: 'SELECT id, status FROM devices WHERE agent_id', rows: [{ id: DEV, status: 'online' }] },
      ]);
      const res = await post('/mobile/heartbeat', { agent_id: 'mobile-aa' }, { 'x-heartbeat-token': 'nope' });
      check('wrong heartbeat token on enrolled device -> 401', () => {
        assert.strictEqual(res.status, 401, `got ${res.status}`);
      });
    }

    // 3. correct heartbeat token persists telemetry -> 200.
    {
      setScripts([
        { match: 'SELECT id, status FROM devices WHERE agent_id', rows: [{ id: DEV, status: 'offline' }] },
        { match: 'UPDATE devices', rows: [] },
        { match: 'INSERT INTO device_heartbeats', rows: [] },
        { match: 'SELECT COUNT(*)::int AS count FROM device_software', rows: [{ count: 1 }] },
      ]);
      const res = await post(
        '/mobile/heartbeat',
        { agent_id: 'mobile-aa', battery_level: 88 },
        { 'x-heartbeat-token': hmacFor('mobile-aa') }
      );
      const body = (await res.json()) as { success: boolean; data: { status: string } };
      check('correct heartbeat token persists telemetry -> 200 online', () => {
        assert.strictEqual(res.status, 200, `got ${res.status}`);
        assert.ok(body.success, 'success flag');
        assert.strictEqual(body.data.status, 'online', `status: ${body.data.status}`);
      });
    }
  } finally {
    setScripts([]);
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

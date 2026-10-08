/**
 * RED->GREEN gate for Task 9: /api/network/stats must not produce SQL whose
 * placeholder indexes exceed (or leave holes in) the supplied params array -
 * postgres rejects such bind messages, which 500s the Network page.
 *
 * Design notes: config/database exports are immutable under tsx (getter-only,
 * configurable:false), so the fake lives one level lower - a stubbed pg.Pool
 * installed in require.cache before the module loads, plus initDatabase()
 * against it. All query() calls funnel through `record()`.
 * Run: npx tsx tests/networkStats.test.ts
 */
import './testEnv';
import assert from 'assert';
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
let capturing = false;
const calls: Array<{ sql: string; params: unknown[] }> = [];

const respond = (sql: string) =>
  sql.includes('FROM permissions')
    ? { rows: [{ code: 'network.view' }, { code: 'devices.view' }], rowCount: 2 }
    : { rows: [], rowCount: 0 };

const record = (sql: string, params?: unknown[]) => {
  if (capturing) calls.push({ sql, params: params ?? [] });
  return respond(sql);
};

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

async function main(): Promise<void> {
  await initDatabase();
  const { default: networkRouter } = await import('../src/routes/network');

  const token = jwt.sign(
    {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'viewer@endpointx.local',
      role_id: '22222222-2222-4222-8222-222222222222',
      role_name: 'user',
      permissions: ['network.view'],
    },
    JWT.ACCESS_SECRET,
    { issuer: JWT.ISSUER, audience: JWT.AUDIENCE, expiresIn: '1h' }
  );

  const app = express();
  app.use('/api/network', networkRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  try {
    capturing = true;
    const res = await fetch(`http://127.0.0.1:${port}/api/network/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    check('GET /network/stats -> 200', () => {
      assert.strictEqual(res.status, 200, `got ${res.status}`);
    });

    check(`captured SQL calls (${calls.length}) have aligned params`, () => {
      assert.ok(calls.length > 0, 'no SQL captured - handler never ran');
      calls.forEach(({ sql, params }, index) => {
        const refs = Array.from(sql.matchAll(/\$(\d+)/g), (m) => Number(m[1]));
        const maxRef = refs.length ? Math.max(...refs) : 0;
        const head = sql.replace(/\s+/g, ' ').slice(0, 140);
        assert.ok(
          maxRef <= params.length,
          `call #${index}: references $${maxRef} but only ${params.length} param(s) supplied: ${head}`
        );
        for (let i = 1; i <= params.length; i++) {
          assert.ok(
            refs.includes(i),
            `call #${index}: param $${i} supplied but never referenced (holes or extras confuse postgres): ${head}`
          );
        }
      });
    });
  } finally {
    capturing = false;
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

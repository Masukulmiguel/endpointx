/**
 * RED->GREEN gate for Task 3: the redesigned marketing site's public API.
 * GET /api/public/stats must feed the homepage stat blocks (version, counts,
 * updated_at) and POST /api/public/contact must persist + audit a message,
 * answering 400 through the repo's zod validation middleware.
 * Run: npx tsx tests/publicApi.test.ts
 * Exit code 0 = every assertion held, 1 = at least one failed.
 */
import './testEnv';
import assert from 'assert';
import http from 'http';
import express from 'express';

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
// Stats runs four COUNT queries, contact inserts into contacts then
// audit_logs; the inline schema and seed statements answer empty.
// Every statement is also appended to `calls` (sql + bound params) so the
// contact assertions can pin real SQL side effects, not just the response.
const calls: Array<{ sql: string; params?: unknown[] }> = [];

const respond = (sql: string) =>
  sql.includes('INSERT INTO contacts')
    ? { rows: [{ id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }], rowCount: 1 }
    : sql.includes('INSERT INTO audit_logs')
      ? { rows: [], rowCount: 1 }
      : sql.includes('COUNT')
        ? { rows: [{ count: 42 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };

class FakeClient {
  query(sql: string, params?: unknown[]) {
    calls.push({ sql, params });
    return Promise.resolve(respond(sql));
  }
  release(): void {
    /* noop */
  }
}

class FakePool {
  constructor(_cfg: unknown) {}
  query(sql: string, params?: unknown[]) {
    calls.push({ sql, params });
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

// Before routes/public.ts exists the module cannot load: mount an empty
// router instead so every assertion observes the 404s of the RED phase.
let publicRouter: express.Router;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  publicRouter = (require('../src/routes/public') as { default: express.Router }).default;
} catch (error) {
  const firstLine = (error as Error).message.split('\n')[0];
  console.log(`  (routes/public.ts not loadable yet: ${firstLine} - empty router mounted, expecting 404s)`);
  publicRouter = express.Router();
}

const backendPkg = require('../package.json') as { version: string };

async function main(): Promise<void> {
  await initDatabase();
  const app = express();
  // Same proxy posture as src/index.ts: rate-limit keys must follow
  // X-Forwarded-For so the three POSTs below never share a bucket.
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api/public', publicRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/public`;

  try {
    // 1. Stats: 200 + payload contract consumed by site/src/js/main.js
    {
      const res = await fetch(`${base}/stats`, { headers: { Accept: 'application/json' } });
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        data?: Record<string, unknown>;
      } | null;
      check('GET /api/public/stats -> 200 + contract', () => {
        assert.strictEqual(res.status, 200, `got ${res.status}`);
        assert.strictEqual(body?.success, true, `success flag missing: ${JSON.stringify(body)}`);
        const data = body!.data!;
        assert.strictEqual(data.version, backendPkg.version, `version must be ${backendPkg.version}, got ${String(data.version)}`);
        // Every counter must be the FakePool COUNT result: anything else
        // means the route bypassed the SQL path and invented the value.
        for (const key of ['devices', 'online', 'users', 'downloads']) {
          assert.strictEqual(data[key], 42, `${key} must be the SQL COUNT result (42), got ${String(data[key])}`);
        }
        assert.ok(!Number.isNaN(Date.parse(String(data.updated_at))), `updated_at must be parseable, got ${String(data.updated_at)}`);
      });
    }

    // 2. Valid contact message -> 201 + UUID id (FakePool's fixed uuid)
    {
      const logMark = calls.length;
      const res = await fetch(`${base}/contact`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '1.1.1.1',
          'User-Agent': 'Task3TestAgent/1.0',
        },
        body: JSON.stringify({
          name: 'Site Visitor',
          email: 'visitor@example.com',
          message: 'Hello, I would like a demo of EndpointX for our fleet.',
        }),
      });
      const body = (await res.json().catch(() => null)) as { success?: boolean; data?: { id?: unknown } } | null;
      check('POST /api/public/contact valid -> 201 + UUID id', () => {
        assert.strictEqual(res.status, 201, `got ${res.status}: ${JSON.stringify(body)}`);
        assert.strictEqual(body?.success, true, `success flag missing: ${JSON.stringify(body)}`);
        assert.match(
          String(body!.data?.id),
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          `id must be a UUID, got ${String(body!.data?.id)}`
        );
      });

      // 2b. The response alone must not go green: the write path has to hit
      // the SQL the brief mandates (ip/agent bindings + audit trail).
      const contactCalls = calls.slice(logMark);
      check('valid contact binds ip/agent and writes audit_logs', () => {
        const insertContact = contactCalls.find((c) => c.sql.includes('INSERT INTO contacts'));
        assert.ok(
          insertContact,
          `INSERT INTO contacts not executed: ${JSON.stringify(contactCalls.map((c) => c.sql))}`
        );
        assert.strictEqual(
          insertContact.params?.[3],
          '1.1.1.1',
          `contacts.ip_address must bind the X-Forwarded-For client ip, got ${String(insertContact.params?.[3])}`
        );
        assert.strictEqual(
          insertContact.params?.[4],
          'Task3TestAgent/1.0',
          `contacts.user_agent must bind the request user-agent, got ${String(insertContact.params?.[4])}`
        );
        const insertAudit = contactCalls.find((c) => c.sql.includes('INSERT INTO audit_logs'));
        assert.ok(
          insertAudit,
          `INSERT INTO audit_logs not executed: ${JSON.stringify(contactCalls.map((c) => c.sql))}`
        );
      });
    }

    // 3. Invalid email -> 400 through the zod validation middleware
    {
      const res = await fetch(`${base}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.1.1.2' },
        body: JSON.stringify({
          name: 'Site Visitor',
          email: 'not-an-email',
          message: 'Hello, I would like a demo of EndpointX for our fleet.',
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: { message?: string; code?: string };
      } | null;
      check('POST /api/public/contact invalid email -> 400', () => {
        assert.strictEqual(res.status, 400, `got ${res.status}: ${JSON.stringify(body)}`);
        assert.strictEqual(body?.success, false, `expected success false: ${JSON.stringify(body)}`);
        assert.strictEqual(body?.error?.code, 'VALIDATION_ERROR', `expected VALIDATION_ERROR: ${JSON.stringify(body)}`);
      });
    }

    // 4. Missing / too-short fields -> 400
    {
      const res = await fetch(`${base}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.1.1.3' },
        body: JSON.stringify({ email: 'ok@example.com', message: 'hi' }),
      });
      const body = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: { message?: string; code?: string };
      } | null;
      check('POST /api/public/contact missing/short fields -> 400', () => {
        assert.strictEqual(res.status, 400, `got ${res.status}: ${JSON.stringify(body)}`);
        assert.strictEqual(body?.success, false, `expected success false: ${JSON.stringify(body)}`);
        assert.strictEqual(body?.error?.code, 'VALIDATION_ERROR', `expected VALIDATION_ERROR: ${JSON.stringify(body)}`);
      });
    }
  } finally {
    // Close the listener AND the keep-alive sockets, then let the process
    // drain naturally: process.exit() while handles are closing trips a
    // libuv assertion on Windows (exit code 0xC0000409 instead of 0/1).
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

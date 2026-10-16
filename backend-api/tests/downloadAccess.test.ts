/**
 * RED->GREEN gate for Task 4 (Fase D): the public binary downloads are gated
 * and counted, and the site's .html URLs permanently redirect to canonical.
 *  - /public/endpointx.exe needs ?t= (enrolment token) or a session holding
 *    devices.manage; every denial is 403 DOWNLOAD_FORBIDDEN and never counts.
 *  - Authorised downloads INSERT into download_events (kind + client ip).
 *  - canonicalHtmlRedirect: /index.html -> 301 /, /docs/faq.html?x=1 ->
 *    301 /docs/faq?x=1, extension-less paths fall through untouched.
 * Run: npx tsx tests/downloadAccess.test.ts
 * Exit code 0 = every assertion held, 1 = at least one failed.
 */
import './testEnv';
import assert from 'assert';
import http from 'http';
import express, { RequestHandler } from 'express';
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
// authenticate() queries user_sessions JOIN users (live row keeps the session
// valid) and role_permissions for the DB-backed permission list; every
// statement is appended to `calls` so the gate assertions can pin real SQL
// side effects (download_events INSERTs), not just the response.
const calls: Array<{ sql: string; params?: unknown[] }> = [];

const ROLE_PERMS: Record<string, string[]> = {
  '22222222-2222-4222-8222-222222222222': ['devices.view'],
  '33333333-3333-4333-8333-333333333333': ['devices.manage'],
};

const respond = (sql: string, params?: unknown[]) => {
  if (sql.includes('JOIN users u ON u.id = s.user_id')) {
    return {
      rows: [{ expires_at: new Date(Date.now() + 3600e3).toISOString(), is_active: true }],
      rowCount: 1,
    };
  }
  if (sql.includes('FROM permissions p JOIN role_permissions')) {
    const codes = ROLE_PERMS[String(params?.[0])] || [];
    return { rows: codes.map((code) => ({ code })), rowCount: codes.length };
  }
  if (sql.includes('INSERT INTO download_events')) return { rows: [], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};

class FakeClient {
  query(sql: string, params?: unknown[]) {
    calls.push({ sql, params });
    return Promise.resolve(respond(sql, params));
  }
  release(): void {
    /* noop */
  }
}

class FakePool {
  constructor(_cfg: unknown) {}
  query(sql: string, params?: unknown[]) {
    calls.push({ sql, params });
    return Promise.resolve(respond(sql, params));
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

// Before src/middleware/canonicalRedirects.ts exists the module cannot load:
// stub next() so the two 301 assertions observe the RED phase (200, not 301).
let canonicalHtmlRedirect: RequestHandler = (_req, _res, next) => next();
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../src/middleware/canonicalRedirects') as {
    canonicalHtmlRedirect?: RequestHandler;
  };
  if (typeof mod.canonicalHtmlRedirect === 'function') {
    canonicalHtmlRedirect = mod.canonicalHtmlRedirect;
  } else {
    console.log('  (canonicalRedirects.ts exports no canonicalHtmlRedirect yet - stubbed, 301 assertions will fail)');
  }
} catch (error) {
  const firstLine = (error as Error).message.split('\n')[0];
  console.log(`  (canonicalRedirects.ts not loadable yet: ${firstLine} - stubbed, 301 assertions will fail)`);
}

const enrollToken = jwt.sign(
  { sub: '3ccbf05c-3ead-4f92-8da3-b22476aeb16', typ: 'enroll' },
  JWT.ACCESS_SECRET,
  { expiresIn: '1h' }
);

const sessionToken = (permissions: string[], roleId: string) =>
  jwt.sign(
    {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'user@endpointx.local',
      role_id: roleId,
      role_name: 'user',
      permissions,
      sid: '11111111-1111-4111-8111-111111111111',
    },
    JWT.ACCESS_SECRET,
    { issuer: JWT.ISSUER, audience: JWT.AUDIENCE, expiresIn: '1h' }
  );

const VIEW_ROLE = '22222222-2222-4222-8222-222222222222';
const MANAGE_ROLE = '33333333-3333-4333-8333-333333333333';

const downloadInserts = (since: number) =>
  calls.slice(since).filter((c) => c.sql.includes('INSERT INTO download_events'));

async function main(): Promise<void> {
  await initDatabase();
  const app = express();
  app.use(express.json());
  app.use('/api/devices', devicesRouter);
  // Same mount position as src/index.ts: after the routes, right where
  // express.static would take over - so the redirect wins over the file.
  app.use(canonicalHtmlRedirect);
  app.use((_req, res) => res.status(200).type('text/plain').send('fell-through'));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const base = `${origin}/api/devices`;

  try {
    // 1. exe without ?t= and without a session -> 403, no binary bytes leak
    {
      const mark = calls.length;
      const res = await fetch(`${base}/public/endpointx.exe`);
      const body = await res.text();
      check('exe without ?t= -> 403 DOWNLOAD_FORBIDDEN, no binary bytes', () => {
        assert.strictEqual(res.status, 403, `got ${res.status}`);
        assert.ok(body.length < 512, `body is ${body.length} bytes - binary leaked`);
        const parsed = JSON.parse(body) as { success?: boolean; error?: { message?: string; code?: string } };
        assert.strictEqual(parsed.success, false, `expected success false: ${body}`);
        assert.strictEqual(parsed.error?.code, 'DOWNLOAD_FORBIDDEN', `expected DOWNLOAD_FORBIDDEN: ${body}`);
        assert.strictEqual(
          parsed.error?.message,
          'Download requires an enrolment token or an authorised session',
          `unexpected message: ${body}`
        );
        assert.strictEqual(res.headers.get('content-disposition'), null, 'attachment headers must not be set');
      });
      check('exe without ?t= is never counted in download_events', () => {
        assert.strictEqual(downloadInserts(mark).length, 0, 'denied download must not INSERT');
      });
    }

    // 2. Invalid enrolment token + invalid session token -> same unified 403
    {
      const mark = calls.length;
      const res = await fetch(`${base}/public/endpointx.exe?t=not-a-jwt`, {
        headers: { Authorization: 'Bearer also-not-a-jwt' },
      });
      const body = await res.text();
      check('exe with garbage ?t= and garbage bearer -> 403 DOWNLOAD_FORBIDDEN', () => {
        assert.strictEqual(res.status, 403, `got ${res.status}`);
        const parsed = JSON.parse(body) as { error?: { code?: string } };
        assert.strictEqual(parsed.error?.code, 'DOWNLOAD_FORBIDDEN', `expected DOWNLOAD_FORBIDDEN: ${body}`);
      });
      check('exe with invalid tokens is never counted in download_events', () => {
        assert.strictEqual(downloadInserts(mark).length, 0, 'denied download must not INSERT');
      });
    }

    // 3. Valid enrolment token -> 200 + attachment + counted (kind + ip)
    {
      const mark = calls.length;
      const res = await fetch(`${base}/public/endpointx.exe?t=${enrollToken}`, {
        headers: { 'X-Forwarded-For': '203.0.113.10' },
      });
      check('exe with valid ?t= -> 200 + attachment headers', () => {
        assert.strictEqual(res.status, 200, `got ${res.status}`);
        assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream');
        assert.ok(
          (res.headers.get('content-disposition') || '').includes('filename="endpointx.exe"'),
          `got disposition ${res.headers.get('content-disposition')}`
        );
      });
      await res.body?.cancel();
      check('exe download with ?t= counted in download_events (kind + ip)', () => {
        const insert = downloadInserts(mark).find((c) => c.params?.[0] === 'windows-exe');
        assert.ok(
          insert,
          `INSERT INTO download_events not executed: ${JSON.stringify(downloadInserts(mark))}`
        );
        assert.strictEqual(insert.params?.[1], '203.0.113.10', `ip_address must be the client ip, got ${String(insert.params?.[1])}`);
      });
    }

    // 4. Session with devices.view only -> 403 (permission is devices.manage)
    {
      const mark = calls.length;
      const res = await fetch(`${base}/public/endpointx-agent.apk`, {
        headers: { Authorization: `Bearer ${sessionToken(['devices.view'], VIEW_ROLE)}` },
      });
      const body = await res.text();
      check('apk with devices.view session -> 403 DOWNLOAD_FORBIDDEN', () => {
        assert.strictEqual(res.status, 403, `got ${res.status}`);
        const parsed = JSON.parse(body) as { error?: { code?: string } };
        assert.strictEqual(parsed.error?.code, 'DOWNLOAD_FORBIDDEN', `expected DOWNLOAD_FORBIDDEN: ${body}`);
      });
      check('apk with devices.view session is never counted in download_events', () => {
        assert.strictEqual(downloadInserts(mark).length, 0, 'denied download must not INSERT');
      });
    }

    // 5. Session with devices.manage -> 200 + counted
    {
      const mark = calls.length;
      const res = await fetch(`${base}/public/endpointx-agent.apk`, {
        headers: {
          Authorization: `Bearer ${sessionToken(['devices.manage'], MANAGE_ROLE)}`,
          'X-Forwarded-For': '198.51.100.7',
        },
      });
      check('apk with devices.manage session -> 200 + attachment headers', () => {
        assert.strictEqual(res.status, 200, `got ${res.status}`);
        assert.ok(
          (res.headers.get('content-disposition') || '').includes('filename="endpointx-agent.apk"'),
          `got disposition ${res.headers.get('content-disposition')}`
        );
      });
      await res.body?.cancel();
      check('apk download with devices.manage counted in download_events (kind + ip)', () => {
        const insert = downloadInserts(mark).find((c) => c.params?.[0] === 'android-apk');
        assert.ok(
          insert,
          `INSERT INTO download_events not executed: ${JSON.stringify(downloadInserts(mark))}`
        );
        assert.strictEqual(insert.params?.[1], '198.51.100.7', `ip_address must be the client ip, got ${String(insert.params?.[1])}`);
      });
    }

    // 6. /index.html -> 301 / (query-free canonical root)
    {
      const res = await fetch(`${origin}/index.html`, { redirect: 'manual' });
      check('GET /index.html -> 301 Location /', () => {
        assert.strictEqual(res.status, 301, `got ${res.status}`);
        assert.strictEqual(res.headers.get('location'), '/', `got ${res.headers.get('location')}`);
      });
      await res.body?.cancel();
    }

    // 7. /docs/faq.html?x=1 -> 301 /docs/faq?x=1 (query string preserved)
    {
      const res = await fetch(`${origin}/docs/faq.html?x=1`, { redirect: 'manual' });
      check('GET /docs/faq.html?x=1 -> 301 Location /docs/faq?x=1', () => {
        assert.strictEqual(res.status, 301, `got ${res.status}`);
        assert.strictEqual(res.headers.get('location'), '/docs/faq?x=1', `got ${res.headers.get('location')}`);
      });
      await res.body?.cancel();
    }

    // 8. Extension-less path must NOT redirect - it falls through to the next handler
    {
      const res = await fetch(`${origin}/docs/faq`, { redirect: 'manual' });
      const body = await res.text();
      check('GET /docs/faq (no .html) falls through to next without redirect', () => {
        assert.strictEqual(res.status, 200, `got ${res.status}`);
        assert.strictEqual(res.headers.get('location'), null, `unexpected Location ${res.headers.get('location')}`);
        assert.strictEqual(body, 'fell-through');
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

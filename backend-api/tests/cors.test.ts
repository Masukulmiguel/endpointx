/**
 * RED->GREEN gate for the CORS origin allowlist.
 * Run: npx tsx tests/cors.test.ts
 * Exit code 0 = every assertion held, 1 = at least one failed.
 */
import http from 'http';
import { isAllowedOrigin, corsOriginCheck } from '../src/utils/cors';

const FRONTEND_URL = process.env.FRONTEND_URL;

const cases: Array<[string, string | undefined, boolean]> = [
  ['no Origin header (agents, curl)', undefined, true],
  ['production dashboard', 'https://endpointx.onrender.com', true],
  ['vite dev server', 'http://localhost:5173', true],
  ['electron shell', 'http://127.0.0.1:5199', true],
  ['localhost without port', 'http://localhost', true],
  ['127.0.0.1 without port', 'http://127.0.0.1', true],
  ['https localhost', 'https://localhost:5173', true],
  ['unrelated origin', 'http://evil.com', false],
  ['literal null origin', 'null', false],
  ['suffix spoofing', 'https://endpointx.onrender.com.evil.com', false],
  ['scheme downgrade spoof', 'http://endpointx.onrender.com', false],
  ['credentials in origin', 'https://user@endpointx.onrender.com', false],
  ['hosted dashboard (default allowlist)', 'https://endpointx-dashboard.onrender.com', true],
  ['dashboard spoof', 'https://endpointx-dashboard.onrender.com.evil.com', false],
];

let failed = 0;
const check = (label: string, origin: string | undefined, expected: boolean) => {
  let actual: unknown;
  try {
    actual = isAllowedOrigin(origin);
  } catch (error) {
    actual = `threw: ${(error as Error).message}`;
  }
  if (actual !== expected) {
    failed += 1;
    console.error(`FAIL ${label}: origin=${JSON.stringify(origin)} expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
};

/** Compare an already-computed value (used by the middleware regression). */
const verify = (label: string, actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    failed += 1;
    console.error(`FAIL ${label}: expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
};

for (const [label, origin, expected] of cases) {
  check(label, origin, expected);
}

// FRONTEND_URL as a comma-separated list must only allow the listed origins.
process.env.FRONTEND_URL = 'https://a.example.com, https://b.example.com';
check('list: first entry', 'https://a.example.com', true);
check('list: second entry', 'https://b.example.com', true);
check('list: unlisted entry', 'https://endpointx.onrender.com', false);
check('list: local dev still allowed', 'http://127.0.0.1:5199', true);

if (FRONTEND_URL === undefined) {
  delete process.env.FRONTEND_URL;
} else {
  process.env.FRONTEND_URL = FRONTEND_URL;
}

// Regression, driven through the REAL cors middleware: origin checks arrive
// as (origin, callback) and cors waits for that callback. When the raw sync
// predicate was passed instead of corsOriginCheck, next() never ran and
// every request hung - while these isolated cases above kept passing.
const middlewareRegression = async (): Promise<void> => {
  const express = (await import('express')).default;
  const corsMw = (await import('cors')).default;
  const app = express();
  app.use(corsMw({ origin: corsOriginCheck, credentials: true }));
  app.get('/mw-probe', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  const server: http.Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/mw-probe`;

  const hit = (headers: Record<string, string>): Promise<{ status: number; acao: string | null; error: string | null }> =>
    new Promise((resolve) => {
      // Plain request with agent:false (no keep-alive) so the test process can
      // exit cleanly; fetch's pooled sockets trip a libuv assertion on exit.
      const req = http.request(base, { headers, agent: false, timeout: 3000 }, (res) => {
        res.resume();
        res.on('end', () => {
          const acao = res.headers['access-control-allow-origin'];
          resolve({ status: res.statusCode || 0, acao: typeof acao === 'string' ? acao : null, error: null });
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout 3s')));
      req.on('error', (error) => resolve({ status: 0, acao: null, error: error.message }));
      req.end();
    });

  const allowed = await hit({ Origin: 'https://endpointx-dashboard.onrender.com' });
  verify('middleware: allowed origin responds', allowed.error, null);
  verify('middleware: allowed origin status', allowed.status, 200);
  verify('middleware: allowed origin reflected', allowed.acao, 'https://endpointx-dashboard.onrender.com');

  const rejected = await hit({ Origin: 'http://evil.com' });
  verify('middleware: rejected origin still responds', rejected.error, null);
  verify('middleware: rejected origin gets no ACAO', rejected.acao, null);

  const noOrigin = await hit({});
  verify('middleware: no origin responds', noOrigin.error, null);
  verify('middleware: no origin status', noOrigin.status, 200);

  await new Promise<void>((resolve) => server.close(() => resolve()));
};

middlewareRegression().then(() => {
  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log('\nPASS');
  process.exit(0);
});

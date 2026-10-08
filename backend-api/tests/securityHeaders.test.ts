/**
 * RED->GREEN gate for Task 7: production must ship a strict CSP via helmet
 * on the API and via nginx for the dashboard SPA.
 * Run: npx tsx tests/securityHeaders.test.ts
 */
import './testEnv';
import assert from 'assert';
import http from 'http';
import express from 'express';
import * as securityHeaders from '../src/config/securityHeaders';

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

async function main(): Promise<void> {
  const app = express();
  const mw = (securityHeaders as { securityHeadersMiddleware?: unknown }).securityHeadersMiddleware;
  check('securityHeadersMiddleware is exported', () => {
    assert.strictEqual(typeof mw, 'function');
  });
  if (typeof mw === 'function') app.use(mw as Parameters<typeof app.use>[0]);
  app.get('/', (_req, res) => res.send('ok'));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    const csp = res.headers.get('content-security-policy') ?? '';

    check('Content-Security-Policy header present', () => {
      assert.ok(csp.length > 0, 'header missing');
    });
    check('default-src \'self\'', () => {
      assert.ok(/default-src[^;]*'self'/.test(csp), csp || '(empty)');
    });
    check('frame-ancestors \'none\'', () => {
      assert.ok(/frame-ancestors[^;]*'none'/.test(csp), csp || '(empty)');
    });
    check('object-src \'none\'', () => {
      assert.ok(/object-src[^;]*'none'/.test(csp), csp || '(empty)');
    });
    check('script-src \'self\'', () => {
      assert.ok(/script-src[^;]*'self'/.test(csp), csp || '(empty)');
    });
    check("style-src allows fonts.googleapis.com + 'unsafe-inline'", () => {
      assert.ok(/style-src[^;]*'unsafe-inline'/.test(csp), csp || '(empty)');
      assert.ok(/style-src[^;]*https:\/\/fonts\.googleapis\.com/.test(csp), csp || '(empty)');
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

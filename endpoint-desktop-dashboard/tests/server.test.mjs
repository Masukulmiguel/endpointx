/**
 * Contract for the packaged shell's local static server.
 * Run: node tests/server.test.mjs  (exit 0 = all assertions held)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createStaticServer } = require(path.join(here, '..', 'server.js'));

const root = path.join(here, '..', 'ui');

/** Raw request so we can send paths the URL parser would normalise away. */
const raw = (port, requestPath) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: requestPath, method: 'GET' },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });

const get = (url, requestPath) => raw(new URL(url).port, requestPath);

let failed = 0;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${label}: ${error.message}`);
  }
};

const { server, url } = await createStaticServer({ root, port: 0 });
assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(url), `unexpected url ${url}`);
assert.equal(new URL(url).hostname, '127.0.0.1', 'server must bind to 127.0.0.1 only');

await check('GET / serves index.html', async () => {
  const res = await get(url, '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.ok(res.body.length > 100, 'index.html body looks empty');
});

await check('deep link falls back to index.html (BrowserRouter)', async () => {
  const res = await get(url, '/devices/123');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  const index = await get(url, '/');
  assert.equal(res.body, index.body, 'fallback body must be index.html');
});

await check('deep link with query string falls back too', async () => {
  const res = await get(url, '/alerts?ack=1');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/html/);
});

await check('hashed js asset is served with a javascript type', async () => {
  const index = await get(url, '/');
  const match = index.body.match(/src="(\/assets\/[^"]+\.js)"/);
  assert.ok(match, 'index.html references no js asset');
  const res = await get(url, match[1]);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.ok(res.body.length > 1000, 'js asset body looks truncated');
});

await check('hashed css asset is served with a css type', async () => {
  const index = await get(url, '/');
  const match = index.body.match(/href="(\/assets\/[^"]+\.css)"/);
  assert.ok(match, 'index.html references no css asset');
  const res = await get(url, match[1]);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/css/);
});

await check('missing asset with an extension 404s instead of returning html', async () => {
  const res = await get(url, '/assets/nope-does-not-exist.js');
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.headers['content-type'] || '', /text\/html/);
});

await check('api namespaces are never served from the local origin', async () => {
  for (const p of ['/api/qualquer', '/socket.io/?EIO=4', '/remote/session']) {
    const res = await get(url, p);
    assert.equal(res.status, 404, `${p} should be 404, got ${res.status}`);
  }
});

await check('dot-dot traversal is blocked', async () => {
  for (const p of ['/../package.json', '/../../backend-api/package.json', '/assets/../../package.json']) {
    const res = await get(url, p);
    assert.notEqual(res.status, 200, `${p} leaked with ${res.status}`);
    assert.ok(!res.body.includes('"electron-builder"'), `${p} leaked package.json`);
  }
});

await check('encoded traversal is blocked', async () => {
  const res = await get(url, '/%2e%2e/package.json');
  assert.notEqual(res.status, 200, `encoded traversal leaked with ${res.status}`);
  assert.ok(!res.body.includes('"electron-builder"'), 'encoded traversal leaked package.json');
});

await check('html is not cached, hashed assets are immutable', async () => {
  const index = await get(url, '/');
  assert.match(index.headers['cache-control'] || '', /no-cache/);
  const match = index.body.match(/src="(\/assets\/[^"]+\.js)"/);
  const asset = await get(url, match[1]);
  assert.match(asset.headers['cache-control'] || '', /immutable/);
  assert.equal(asset.headers['x-content-type-options'], 'nosniff');
});

await check('root outside cwd does not escape', async () => {
  const res = await get(url, '/server.js');
  assert.equal(res.status, 404, 'source files next to ui/ must not be reachable');
});

server.close();
if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nPASS');

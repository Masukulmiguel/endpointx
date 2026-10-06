/**
 * RED->GREEN gate for the CORS origin allowlist.
 * Run: npx tsx tests/cors.test.ts
 * Exit code 0 = every assertion held, 1 = at least one failed.
 */
import { isAllowedOrigin } from '../src/utils/cors';

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
    console.error(`FAIL ${label}: origin=${JSON.stringify(origin)} expected=${expected} got=${JSON.stringify(actual)}`);
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

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nPASS');

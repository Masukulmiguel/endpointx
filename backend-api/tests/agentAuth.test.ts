/**
 * RED->GREEN gate for Task 5: agent heartbeat requires X-Agent-Secret and
 * mobile enrollment requires a valid enrolment token. Statuses of 500/404
 * after the gate are acceptable here (no DB in tests) — only 401 matters.
 * Run: npx tsx tests/agentAuth.test.ts
 */
import './testEnv';
import assert from 'assert';
import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { JWT } from '../src/config/constants';
import devicesRouter from '../src/routes/devices';

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

const enrollToken = jwt.sign(
  { sub: '3ccbf05c-3ead-4f92-8da3-b22476aeb16', typ: 'enroll' },
  JWT.ACCESS_SECRET,
  { expiresIn: '1h' }
);

async function main(): Promise<void> {
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

    // 1. Heartbeat without the secret header must be rejected up front.
    {
      const res = await post('/heartbeat', { agent_id: 'x' });
      check('heartbeat without X-Agent-Secret -> 401', () => {
        assert.strictEqual(res.status, 401, `got ${res.status}`);
      });
    }

    // 2. Wrong secret rejected.
    {
      const res = await post('/heartbeat', { agent_id: 'x' }, { 'x-agent-secret': 'wrong' });
      check('heartbeat with wrong X-Agent-Secret -> 401', () => {
        assert.strictEqual(res.status, 401, `got ${res.status}`);
      });
    }

    // 3. Correct secret passes the gate (later 404/500 without DB is fine).
    {
      const res = await post('/heartbeat', { agent_id: 'x' }, { 'x-agent-secret': process.env.AGENT_SECRET! });
      check('heartbeat with correct secret -> not 401', () => {
        assert.notStrictEqual(res.status, 401, `got ${res.status}`);
      });
    }

    // 4. Mobile register without enrolment proof rejected.
    {
      const res = await post('/mobile/register', { device_name: 'd' });
      check('mobile/register without enroll_token -> 401', () => {
        assert.strictEqual(res.status, 401, `got ${res.status}`);
      });
    }

    // 5. Valid enrolment token passes the gate.
    {
      const res = await post('/mobile/register', { device_name: 'd', enroll_token: enrollToken });
      check('mobile/register with valid enroll_token -> not 401', () => {
        assert.notStrictEqual(res.status, 401, `got ${res.status}`);
      });
    }
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

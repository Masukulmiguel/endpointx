/**
 * RED->GREEN gate for Task 2: the shared AGENT_SECRET must not be reachable
 * without a valid enrolment token, and installer/enrolment endpoints must
 * demand devices.manage.
 * Run: npx tsx tests/installAccess.test.ts
 * Exit code 0 = every assertion held, 1 = at least one failed.
 */
import './testEnv';
import assert from 'assert';
import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { JWT } from '../src/config/constants';
import devicesRouter from '../src/routes/devices';

const AGENT_SECRET = process.env.AGENT_SECRET as string;

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

const sessionToken = (permissions: string[]) =>
  jwt.sign(
    {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'viewer@endpointx.local',
      role_id: '22222222-2222-4222-8222-222222222222',
      role_name: 'user',
      permissions,
    },
    JWT.ACCESS_SECRET,
    { issuer: JWT.ISSUER, audience: JWT.AUDIENCE, expiresIn: '1h' }
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
    // 1. Public install script without enrolment token -> 403 (never 200 + secret)
    {
      const res = await fetch(`${base}/public/install.ps1`);
      const body = await res.text();
      check('install.ps1 without ?t= -> 403', () => {
        assert.strictEqual(res.status, 403, `got ${res.status}`);
        assert.ok(!body.includes(AGENT_SECRET), 'secret must not leak');
      });
    }

    // 2. With a valid enrolment token -> 200 and the script is fully rendered
    {
      const res = await fetch(`${base}/public/install.ps1?t=${enrollToken}`);
      const body = await res.text();
      check('install.ps1 with valid ?t= -> 200 + secret embedded', () => {
        assert.strictEqual(res.status, 200, `got ${res.status}`);
        assert.ok(body.includes(AGENT_SECRET), 'script should carry the agent secret for enrolment');
        assert.ok(!body.includes('##AGENT_SECRET##'), 'placeholder must be replaced');
      });
    }

    // 3. Garbage token -> 403
    {
      const res = await fetch(`${base}/public/install.ps1?t=not-a-jwt`);
      check('install.ps1 with garbage ?t= -> 403', () => {
        assert.strictEqual(res.status, 403, `got ${res.status}`);
      });
    }

    // 4. Linux script: same gate (file existence is a separate concern)
    {
      const res = await fetch(`${base}/public/install-linux.sh`);
      check('install-linux.sh without ?t= -> 403', () => {
        assert.strictEqual(res.status, 403, `got ${res.status}`);
      });
    }
    {
      const res = await fetch(`${base}/public/install-linux.sh?t=${enrollToken}`);
      const body = await res.text();
      check('install-linux.sh with valid ?t= -> not 401/403', () => {
        assert.ok(res.status !== 401 && res.status !== 403, `got ${res.status}`);
        assert.ok(!body.includes('##AGENT_SECRET##'), 'placeholder must be replaced when served');
      });
    }

    // 5. Enrolment token minting now requires devices.manage
    {
      const res = await fetch(`${base}/enroll-token`, {
        headers: { Authorization: `Bearer ${sessionToken(['devices.view'])}` },
      });
      check('GET /enroll-token with devices.view only -> 403', () => {
        assert.strictEqual(res.status, 403, `got ${res.status}`);
      });
    }

    // 6. Authenticated installer download now requires devices.manage
    {
      const res = await fetch(`${base}/download/installer?platform=windows`, {
        headers: { Authorization: `Bearer ${sessionToken(['devices.view'])}` },
      });
      check('GET /download/installer with devices.view only -> 403', () => {
        assert.strictEqual(res.status, 403, `got ${res.status}`);
      });
    }

    // 7. Public Windows PC installer (site download button) streams as attachment
    {
      const res = await fetch(`${base}/public/endpointx.exe`);
      check('GET /public/endpointx.exe -> 200 + attachment headers', () => {
        assert.strictEqual(res.status, 200, `got ${res.status}`);
        assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream');
        assert.ok(
          (res.headers.get('content-disposition') || '').includes('filename="endpointx.exe"'),
          `got disposition ${res.headers.get('content-disposition')}`
        );
      });
      await res.body?.cancel();
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

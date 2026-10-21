/**
 * Gate for the reports CSV exports (devices / compliance / alerts).
 *
 * These exports carry third-party content — a device hostname, an alert
 * title, a compliance asset name — and every one of those values is
 * operator- or agent-supplied. A cell starting with =, +, -, @, TAB or CR is
 * evaluated as a formula by Excel/Sheets, so opening the export could
 * execute a crafted expression (CSV injection). The shared formatter in
 * src/utils/csv.ts must neutralise those cells without breaking the
 * RFC 4180 quoting the exports have always used.
 *
 * Design notes: same FakePool harness as tests/cyberlabRbac.test.ts — a
 * stubbed pg.Pool in require.cache, so the routes run over real SQL
 * semantics without a database.
 *
 * Run: npx tsx tests/reportsCsv.test.ts
 */
import './testEnv';
import assert from 'assert';
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { JWT } from '../src/config/constants';

let failed = 0;
const checkAsync = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${(error as Error).message}`);
  }
};

// ---- Fake pg (installed before config/database is first required) ----------
const rolePermissions = new Map<string, Record<string, unknown>[]>();
const setRolePermissions = (roleId: string, codes: string[]): void => {
  rolePermissions.set(roleId, codes.map((code) => ({ code })));
};

// The devices the export will render. The hostname is the injection vector:
// in a real deployment it comes from the agent's self-reported identity.
const deviceRows = [
  {
    hostname: '=HYPERLINK("http://evil.local","click me")',
    os_type: 'Windows 11',
    status: 'online',
    user_email: 'user@test.local',
    last_heartbeat: '2026-03-01T09:00:00.000Z',
    cpu_usage: 12.5,
    ram_usage: 40,
    disk_usage: 80,
  },
  {
    hostname: 'pc-01, "lab"',
    os_type: 'Ubuntu 24.04',
    status: 'offline',
    user_email: 'user@test.local',
    last_heartbeat: '2026-03-01T08:00:00.000Z',
    cpu_usage: 1,
    ram_usage: 2,
    disk_usage: 3,
  },
  {
    // A negative metric must stay a number: the injection guard must not
    // turn a value that cannot be a formula into text.
    hostname: 'pc-02',
    os_type: 'Ubuntu 24.04',
    status: 'online',
    user_email: 'user@test.local',
    last_heartbeat: '2026-03-01T08:00:00.000Z',
    cpu_usage: -3.25,
    ram_usage: 2,
    disk_usage: 3,
  },
];

const respond = (sql: string, params: unknown[] = []) => {
  if (sql.includes('FROM permissions')) {
    const roleId = String(params[0] ?? '');
    const rows = rolePermissions.get(roleId) ?? [];
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('JOIN users u ON u.id = s.user_id')) {
    return {
      rows: [{ expires_at: new Date(Date.now() + 3600e3).toISOString(), is_active: true }],
      rowCount: 1,
    };
  }
  if (sql.includes('FROM devices d')) {
    return { rows: deviceRows, rowCount: deviceRows.length };
  }
  return { rows: [], rowCount: 0 };
};

const record = (sql: string, params?: unknown[]) => respond(sql, params ?? []);

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

/* eslint-disable @typescript-eslint/no-var-requires */
const { initDatabase } = require('../src/config/database') as { initDatabase: () => Promise<void> };
/* eslint-enable @typescript-eslint/no-var-requires */

async function main(): Promise<void> {
  await initDatabase();
  const { default: reportsRouter } = (await import('../src/routes/reports')) as {
    default: import('express').Router;
  };

  const app = express();
  app.use(express.json());
  app.use('/api/reports', reportsRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/reports`;

  setRolePermissions('role-viewer', ['logs.view']);
  const token = jwt.sign(
    {
      id: 'user-viewer',
      email: 'user@test.local',
      role_id: 'role-viewer',
      role_name: 'user',
      permissions: ['logs.view'],
      sid: 'user-viewer-sid-0000-0000-000000000000',
    },
    JWT.ACCESS_SECRET,
    { issuer: JWT.ISSUER, audience: JWT.AUDIENCE, expiresIn: '1h' }
  );

  const getCsv = (path: string) =>
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  try {
    await checkAsync('test_devices_csv_neutralises_formula_injection', async () => {
      const res = await getCsv('/devices/csv');
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const contentType = res.headers.get('content-type') ?? '';
      assert.ok(contentType.startsWith('text/csv'), `content-type must be text/csv, got ${contentType}`);

      const text = await res.text();
      const lines = text.split('\n');
      assert.strictEqual(lines.length, 4, `header + three devices, got ${lines.length} lines`);
      assert.strictEqual(lines[0], '"Hostname","OS","Status","User","Last Heartbeat","CPU%","RAM%","Disk%"');

      // The dangerous hostname must be neutralised.
      const hostnameCell = lines[1].split('","')[0];
      assert.ok(
        hostnameCell.startsWith('"\'=HYPERLINK'),
        `the hostname cell must be quote-prefixed, got ${hostnameCell}`
      );

      // No TEXT cell in the document may lead with a formula character. A
      // numeric cell is exempt: a real number cannot be a formula (the
      // negative CPU metric below is the case in point).
      for (const line of lines.slice(1)) {
        for (const cell of line.split('","')) {
          const value = cell.replace(/^"/, '');
          if (/^-?\d+(\.\d+)?$/.test(value)) continue; // a plain number
          assert.ok(!/^[=+\-@\t\r]/.test(value), `unneutralised formula-leading cell: ${value}`);
        }
      }
    });

    await checkAsync('test_devices_csv_keeps_the_existing_quoting_contract', async () => {
      const res = await getCsv('/devices/csv');
      const text = await res.text();
      // Commas and quotes inside a value stay escaped reports.ts-style.
      assert.ok(
        text.includes('"pc-01, ""lab"""'),
        `commas/quotes must stay escaped, got: ${text.split('\n')[2]}`
      );
      // Falsy-but-meaningful numbers must not become empty.
      assert.ok(text.includes('"1.0"'), `cpu 1 must render as 1.0, got: ${text.split('\n')[2]}`);
    });

    await checkAsync('test_devices_csv_keeps_negative_metrics_as_numbers', async () => {
      const res = await getCsv('/devices/csv');
      const text = await res.text();
      // The negative CPU must render as the number -3.3 (toFixed(1)), not as
      // text with a leading quote — the injection guard must not fire on a
      // value that cannot be a formula.
      assert.ok(
        text.includes('"-3.3"'),
        `a negative metric must stay a number, got: ${text.split('\n').slice(1).join(' | ')}`
      );
      assert.ok(
        !text.includes("'-3.3"),
        'a negative metric must not be neutralised into text'
      );
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(failed === 0 ? '\nALL PASS\n' : `\n${failed} test(s) FAILED\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

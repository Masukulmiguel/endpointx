/**
 * RED->GREEN gate for Task 1 (cyberlab_* schema + cyberlab.* RBAC codes).
 *
 * Design notes: same FakePool harness as tests/networkDiscovery.test.ts - a
 * stubbed pg.Pool installed in require.cache before config/database loads,
 * then initDatabase() run against it with capturing on so every statement of
 * the inline schema + seed passes through record(). App modules that touch
 * the pool (middleware) are loaded via dynamic import AFTER the fake is in
 * place.
 * Run: npx tsx tests/cyberlabRbac.test.ts
 */
import './testEnv';
import assert from 'assert';
import express from 'express';
import http from 'http';
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

// ---- Fake pg (installed before config/database is first required) --------
let capturing = false;
const calls: Array<{ sql: string; params: unknown[] }> = [];

// Per-role permission rows for authenticate()'s loadRolePermissions query.
const rolePermissions = new Map<string, Record<string, unknown>[]>();
const setRolePermissions = (roleId: string, codes: string[]): void => {
  rolePermissions.set(roleId, codes.map((code) => ({ code })));
};

const respond = (sql: string, params: unknown[] = []) => {
  if (sql.includes('FROM permissions')) {
    const roleId = String(params[0] ?? '');
    const rows = rolePermissions.get(roleId) ?? [];
    return { rows, rowCount: rows.length };
  }
  // Default live session for the authenticate() gate so the HTTP test
  // exercises the permission logic rather than the session check.
  if (sql.includes('JOIN users u ON u.id = s.user_id')) {
    return {
      rows: [{ expires_at: new Date(Date.now() + 3600e3).toISOString(), is_active: true }],
      rowCount: 1,
    };
  }
  return { rows: [], rowCount: 0 };
};

const record = (sql: string, params?: unknown[]) => {
  if (capturing) calls.push({ sql, params: params ?? [] });
  return respond(sql, params ?? []);
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

/* eslint-disable @typescript-eslint/no-var-requires */
const { initDatabase, allPerms, SEED_ROLE_PERMISSIONS } = require('../src/config/database') as {
  initDatabase: () => Promise<void>;
  allPerms: Array<[string, string, string, string]>;
  SEED_ROLE_PERMISSIONS: Record<string, string[]>;
};
/* eslint-enable @typescript-eslint/no-var-requires */

const CYBERLAB_CODES = ['cyberlab.approve', 'cyberlab.export', 'cyberlab.manage', 'cyberlab.view'];

async function main(): Promise<void> {
  capturing = true;
  await initDatabase();
  capturing = false;

  const statements = calls.map((c) => c.sql);

  check('test_boot_seeds_exactly_four_cyberlab_permissions', () => {
    assert.ok(Array.isArray(allPerms), 'database.ts must export the permission catalog (allPerms)');
    const cyberlabTuples = allPerms.filter(([code]) => code.startsWith('cyberlab.'));
    assert.deepStrictEqual(
      cyberlabTuples.map(([code]) => code).sort(),
      CYBERLAB_CODES,
      `allPerms must contain exactly the 4 cyberlab codes: ${JSON.stringify(cyberlabTuples)}`
    );
    for (const [code, name, desc, category] of cyberlabTuples) {
      assert.strictEqual(category, 'cyberlab', `${code} must have category "cyberlab", got "${category}"`);
      assert.ok(name.length > 0 && desc.length > 0, `${code} needs a non-empty name and description`);
    }
  });

  check('test_boot_insert_statements_carry_cyberlab_category', () => {
    const inserts = calls.filter((c) => c.sql.includes('INSERT INTO permissions'));
    const cyberlabInserts = inserts.filter(
      (c) => typeof c.params[0] === 'string' && (c.params[0] as string).startsWith('cyberlab.')
    );
    assert.ok(cyberlabInserts.length >= 4, `expected cyberlab permission INSERTs at boot, got ${cyberlabInserts.length}`);
    for (const c of cyberlabInserts) {
      assert.strictEqual(c.params[3], 'cyberlab', `${String(c.params[0])}: category must be cyberlab`);
    }
    const codes = [...new Set(cyberlabInserts.map((c) => String(c.params[0])))].sort();
    assert.deepStrictEqual(codes, CYBERLAB_CODES, `boot must insert exactly the 4 codes: ${JSON.stringify(codes)}`);
  });

  check('test_inline_schema_creates_cyberlab_tables', () => {
    for (const table of ['cyberlab_jobs', 'cyberlab_artifacts', 'cyberlab_findings', 'cyberlab_scopes']) {
      assert.ok(
        statements.some((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${table}`)),
        `missing CREATE TABLE IF NOT EXISTS ${table}`
      );
    }
    const jobs = statements.find((s) => s.includes('CREATE TABLE IF NOT EXISTS cyberlab_jobs'))!;
    assert.ok(jobs.includes('cancel_requested'), 'cyberlab_jobs must have cancel_requested');
    assert.ok(jobs.includes('approval_ref'), 'cyberlab_jobs must have approval_ref');
    const findings = statements.find((s) => s.includes('CREATE TABLE IF NOT EXISTS cyberlab_findings'))!;
    assert.ok(
      /job_id UUID NOT NULL REFERENCES cyberlab_jobs\(id\)/.test(findings),
      'cyberlab_findings.job_id must be a NOT NULL FK to cyberlab_jobs'
    );
    const scopes = statements.find((s) => s.includes('CREATE TABLE IF NOT EXISTS cyberlab_scopes'))!;
    assert.ok(scopes.includes('allowed_methods'), 'cyberlab_scopes must have allowed_methods');
  });

  check('test_seed_role_permissions_grant_no_cyberlab_codes', () => {
    for (const [role, codes] of Object.entries(SEED_ROLE_PERMISSIONS)) {
      const leaked = codes.filter((code) => code.startsWith('cyberlab.'));
      assert.deepStrictEqual(leaked, [], `SEED_ROLE_PERMISSIONS.${role} must not grant cyberlab codes`);
    }
  });

  // ---- HTTP: war-mounted empty provider router (real route lands in a
  // later task; this guards the requirePermission('cyberlab.view') gate).
  const { authenticate } = await import('../src/middleware/auth');
  const { requirePermission } = await import('../src/middleware/rbac');

  const sessionToken = (id: string, roleId: string, permissions: string[]): string => {
    setRolePermissions(roleId, permissions);
    return jwt.sign(
      {
        id,
        email: `${id}@test.local`,
        role_id: roleId,
        role_name: 'user',
        permissions,
        sid: `${id}-sid-0000-0000-000000000000`.slice(0, 36),
      },
      JWT.ACCESS_SECRET,
      { issuer: JWT.ISSUER, audience: JWT.AUDIENCE, expiresIn: '1h' }
    );
  };

  const noCyberlabToken = sessionToken('user-nocyber', 'role-nocyber', ['devices.view']);

  const app = express();
  app.use(express.json());
  const cyberlabWarRouter = express.Router();
  cyberlabWarRouter.get('/providers', authenticate, requirePermission('cyberlab.view'), (_req, res) => {
    res.status(200).json({ success: true, data: [] });
  });
  app.use('/api/cyberlab', cyberlabWarRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  try {
    await checkAsync('test_providers_requires_cyberlab_view', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/cyberlab/providers`, {
        headers: { Authorization: `Bearer ${noCyberlabToken}` },
      });
      assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.error.code, 'AUTH_PERMISSION_DENIED', `unexpected error body: ${JSON.stringify(body)}`);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED`);
    process.exit(1);
  }
  console.log('\nALL PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * RED->GREEN gate for the role permission contract.
 *
 * The Roles page is the only way an operator grants a permission (the Cyber
 * Lab codes included) to a role. The contract it speaks and the contract the
 * route reads must agree, otherwise the save is a silent no-op and the
 * permission never reaches the role.
 *
 * Design notes: same FakePool harness as tests/cyberlabRbac.test.ts - a
 * stubbed pg.Pool installed in require.cache before config/database loads.
 * Run: npx tsx tests/rolesPermissions.test.ts
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

// ---- Fake pg (installed before config/database is first required) --------
let capturing = false;
const calls: Array<{ sql: string; params: unknown[] }> = [];

const rolePermissions = new Map<string, string[]>();

const record = (sql: string, params: unknown[] = []) => {
  if (capturing) calls.push({ sql, params });
  // The permission lookup the authenticate() gate performs.
  if (sql.includes('JOIN role_permissions')) {
    const roleId = String(params[0] ?? '');
    const codes = rolePermissions.get(roleId) ?? [];
    return { rows: codes.map((code) => ({ code })), rowCount: codes.length };
  }
  // The session check the authenticate() gate performs.
  if (sql.includes('JOIN users u ON u.id = s.user_id')) {
    return {
      rows: [{ expires_at: new Date(Date.now() + 3600e3).toISOString(), is_active: true }],
      rowCount: 1,
    };
  }
  if (sql.includes('COUNT(*) as count FROM roles')) {
    // Roles already exist in this database: the boot takes the repair path.
    return { rows: [{ count: 4 }], rowCount: 1 };
  }
  if (sql.includes('FROM roles r')) {
    return {
      rows: [
        {
          id: 'role-0000-0000-0000-000000000000',
          name: 'supervisor',
          display_name: 'Supervisor',
          description: 'Can view and manage devices and users',
          is_system: true,
          permission_count: 3,
        },
      ],
      rowCount: 1,
    };
  }
  return { rows: [], rowCount: 0 };
};

class FakeClient {
  query(sql: string, params?: unknown[]) {
    return Promise.resolve(record(sql, params ?? []));
  }
  release(): void {
    /* noop */
  }
}

class FakePool {
  constructor(_cfg: unknown) {}
  query(sql: string, params?: unknown[]) {
    return Promise.resolve(record(sql, params ?? []));
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

async function main(): Promise<void> {
  // initDatabase() installs the pool the routes query through.
  const { initDatabase } = await import('../src/config/database');
  await initDatabase();

  const { authenticate } = await import('../src/middleware/auth');
  const { requirePermission } = await import('../src/middleware/rbac');
  const rolesRouter = (await import('../src/routes/roles')).default;

  const adminRoleId = 'role-admin-0000-0000-000000000000';
  rolePermissions.set(adminRoleId, ['roles.view', 'roles.manage']);

  const token = jwt.sign(
    {
      id: 'user-admin-0000-0000-000000000000',
      email: 'admin@test.local',
      role_id: adminRoleId,
      role_name: 'admin',
      permissions: ['roles.view', 'roles.manage'],
      sid: 'user-admin-0000-0000-000000000000',
    },
    JWT.ACCESS_SECRET,
    { issuer: JWT.ISSUER, audience: JWT.AUDIENCE, expiresIn: '1h' }
  );

  const app = express();
  app.use(express.json());
  app.use('/api/roles', authenticate, rolesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;

  const put = async (body: Record<string, unknown>): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/api/roles/role-0000-0000-0000-000000000000`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  const post = async (body: Record<string, unknown>): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}/api/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

  try {
    // ---- the canonical field: permission_ids ----------------------------
    capturing = true;
    calls.length = 0;
    const res = await put({
      display_name: 'Supervisor',
      permission_ids: ['perm-a', 'perm-b', 'perm-c'],
    });
    capturing = false;

    check('test_update_role_with_permission_ids_replaces_the_set', () => {
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const deletes = calls.filter((c) => c.sql.includes('DELETE FROM role_permissions'));
      assert.strictEqual(deletes.length, 1, `expected one DELETE, got ${deletes.length}`);
      assert.deepStrictEqual(
        deletes[0].params,
        ['role-0000-0000-0000-000000000000'],
        'the DELETE must target the edited role'
      );
      const inserts = calls.filter((c) => c.sql.includes('INSERT INTO role_permissions'));
      assert.strictEqual(inserts.length, 3, `expected 3 INSERTs, got ${inserts.length}`);
      assert.deepStrictEqual(
        inserts.map((c) => c.params[1]),
        ['perm-a', 'perm-b', 'perm-c'],
        'every granted permission id must be written'
      );
    });

    check('test_update_role_touches_the_role_row', () => {
      const updates = calls.filter((c) => c.sql.includes('UPDATE roles SET'));
      assert.strictEqual(updates.length, 1, `expected one UPDATE, got ${updates.length}`);
    });

    // ---- the alias: permissions (what the dashboard used to send) --------
    capturing = true;
    calls.length = 0;
    await put({ display_name: 'Supervisor', permissions: ['perm-x'] });
    capturing = false;

    check('test_update_role_accepts_permissions_as_an_alias', () => {
      const inserts = calls.filter((c) => c.sql.includes('INSERT INTO role_permissions'));
      assert.strictEqual(inserts.length, 1, `the alias must apply the change, got ${inserts.length} INSERTs`);
      assert.deepStrictEqual(inserts[0].params[1], 'perm-x', 'the alias must write the same id');
    });

    // ---- no permission field at all: the label changes, the set stays ----
    capturing = true;
    calls.length = 0;
    await put({ display_name: 'Supervisor' });
    capturing = false;

    check('test_update_role_without_permissions_leaves_the_set_alone', () => {
      const writes = calls.filter(
        (c) => c.sql.includes('DELETE FROM role_permissions') || c.sql.includes('INSERT INTO role_permissions')
      );
      assert.strictEqual(writes.length, 0, `the permission set must not be touched, got ${writes.length} writes`);
    });

    // ---- a system role keeps its name but its permissions are the
    //      operator's to change -------------------------------------------
    capturing = true;
    calls.length = 0;
    await put({
      display_name: 'Cyber Supervisor',
      permission_ids: ['perm-cyberlab'],
    });
    capturing = false;

    check('test_system_role_display_name_is_not_silently_dropped', () => {
      const updates = calls.filter((c) => c.sql.includes('UPDATE roles SET'));
      assert.strictEqual(updates.length, 1, `expected one UPDATE, got ${updates.length}`);
      assert.ok(
        !/is_system = false/.test(updates[0].sql),
        'a system role must not be excluded from its own label update'
      );
      assert.strictEqual(updates[0].params[0], 'Cyber Supervisor', 'the new label must be written');
    });

    check('test_system_role_permissions_are_applied', () => {
      const inserts = calls.filter((c) => c.sql.includes('INSERT INTO role_permissions'));
      assert.strictEqual(inserts.length, 1, `expected one INSERT, got ${inserts.length}`);
    });

    // ---- creating a role with its permissions ---------------------------
    capturing = true;
    calls.length = 0;
    const created = await post({
      name: 'cyber-ops',
      display_name: 'Cyber Ops',
      description: 'Cyber Lab operators',
      permission_ids: ['perm-1', 'perm-2'],
    });
    capturing = false;

    check('test_create_role_with_permission_ids_writes_the_set', () => {
      assert.strictEqual(created.status, 201, `expected 201, got ${created.status}`);
      const inserts = calls.filter((c) => c.sql.includes('INSERT INTO role_permissions'));
      assert.strictEqual(inserts.length, 2, `expected 2 INSERTs, got ${inserts.length}`);
    });

    capturing = true;
    calls.length = 0;
    const createdAlias = await post({
      name: 'cyber-ops-2',
      display_name: 'Cyber Ops 2',
      permissions: ['perm-3'],
    });
    capturing = false;

    check('test_create_role_accepts_permissions_as_an_alias', () => {
      assert.strictEqual(createdAlias.status, 201, `expected 201, got ${createdAlias.status}`);
      const inserts = calls.filter((c) => c.sql.includes('INSERT INTO role_permissions'));
      assert.strictEqual(inserts.length, 1, `the alias must apply the change, got ${inserts.length} INSERTs`);
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

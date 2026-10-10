/**
 * RED->GREEN gate for Task 3 (schema, flag default, command type) and
 * Task 4 (discoveryService: ingest + tenant-scoped list + review + enroll).
 *
 * Design notes: same FakePool harness as tests/networkStats.test.ts - a stubbed
 * pg.Pool installed in require.cache before config/database loads, then
 * initDatabase() run against it with capturing on so every statement of the
 * inline schema + seed passes through record().
 * Task 4 extends respond() with substring-keyed scripted rows so each service
 * test controls what each SELECT returns, and adds captureCalls() to record
 * the SQL + params a service function emits.
 * Run: npx tsx tests/networkDiscovery.test.ts
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

type ScriptedRow = { match: string; rows: Record<string, unknown>[] };
const scripts: ScriptedRow[] = [];
const setScripts = (next: ScriptedRow[]): void => {
  scripts.length = 0;
  scripts.push(...next);
};

// Per-role permission rows for authenticate()'s loadRolePermissions query.
// Keyed by role_id (the $1 param of the permissions JOIN query).
const rolePermissions = new Map<string, Record<string, unknown>[]>();
const setRolePermissions = (roleId: string, codes: string[]): void => {
  rolePermissions.set(roleId, codes.map((code) => ({ code })));
};

// One-shot error injection: next SQL containing `match` throws once.
let injectedError: { match: string; message: string } | null = null;
const injectErrorOnce = (match: string, message = 'injected failure'): void => {
  injectedError = { match, message };
};

const respond = (sql: string, params: unknown[] = []) => {
  if (injectedError && sql.includes(injectedError.match)) {
    const err = new Error(injectedError.message);
    injectedError = null;
    throw err;
  }
  if (sql.includes('FROM permissions')) {
    const roleId = String(params[0] ?? '');
    const rows = rolePermissions.get(roleId) ?? [];
    return { rows, rowCount: rows.length };
  }
  for (const s of scripts) {
    if (sql.includes(s.match)) return { rows: s.rows, rowCount: s.rows.length };
  }
  return { rows: [], rowCount: 0 };
};

/** Run a service call with SQL capturing on; returns the result + emitted SQL. */
async function captureCalls<T>(
  fn: () => Promise<T>
): Promise<{ result: T; calls: Array<{ sql: string; params: unknown[] }> }> {
  const start = calls.length;
  capturing = true;
  try {
    const result = await fn();
    return { result, calls: calls.slice(start) };
  } finally {
    capturing = false;
  }
}

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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDatabase } = require('../src/config/database') as {
  initDatabase: () => Promise<void>;
};

async function main(): Promise<void> {
  capturing = true;
  await initDatabase();
  capturing = false;

  const statements = calls.map((c) => c.sql);

  check('test_inline_schema_adds_network_nodes_columns', () => {
    const createdBy = statements.filter((s) =>
      /ALTER TABLE network_nodes[\s\S]*ADD COLUMN IF NOT EXISTS created_by/.test(s)
    );
    assert.strictEqual(
      createdBy.length,
      1,
      `expected exactly 1 statement with the network_nodes created_by ALTER, got ${createdBy.length}`
    );
    assert.ok(
      statements.some((s) => /ALTER TABLE network_nodes\s+ADD COLUMN IF NOT EXISTS review_status/.test(s)),
      'missing ALTER TABLE network_nodes ADD COLUMN IF NOT EXISTS review_status'
    );
    assert.ok(
      statements.some((s) => /ALTER TABLE network_nodes\s+ADD COLUMN IF NOT EXISTS enrollment_requested_at/.test(s)),
      'missing ALTER TABLE network_nodes ADD COLUMN IF NOT EXISTS enrollment_requested_at'
    );
    assert.ok(
      statements.some((s) => s.includes('CREATE INDEX IF NOT EXISTS idx_network_nodes_created_by ON network_nodes(created_by)')),
      'missing idx_network_nodes_created_by index'
    );
    assert.ok(
      statements.some((s) => s.includes('CREATE INDEX IF NOT EXISTS idx_network_nodes_review_status ON network_nodes(review_status)')),
      'missing idx_network_nodes_review_status index'
    );
  });

  check('test_flag_default_flip_is_idempotent', () => {
    const flagStatements = statements.filter((s) => s.includes('netsentinel_enabled'));
    assert.strictEqual(
      flagStatements.length,
      1,
      `netsentinel_enabled must be seeded by exactly one statement (no duplicate seed row insert), got ${flagStatements.length}`
    );
    const upsert = flagStatements[0];
    assert.ok(upsert.includes('INSERT INTO app_settings'), 'expected an app_settings insert');
    assert.ok(
      upsert.includes('ON CONFLICT (key) DO UPDATE'),
      'expected an upsert so the flip is idempotent across boots'
    );
    assert.ok(
      /'netsentinel_enabled'\s*,\s*'true'/.test(upsert),
      "flag must default to 'true'"
    );
    assert.ok(
      upsert.includes("WHERE app_settings.value = 'false'"),
      "must only flip legacy 'false' rows - never downgrade an explicit 'true'"
    );
  });

  const { ALLOWED_COMMAND_TYPES } = await import('../src/routes/commands');
  check('test_commands_allowlist_contains_network_discovery', () => {
    assert.ok(Array.isArray(ALLOWED_COMMAND_TYPES), 'commands.ts must export ALLOWED_COMMAND_TYPES');
    assert.ok(
      ALLOWED_COMMAND_TYPES.includes('network_discovery'),
      `network_discovery missing from allowlist: ${JSON.stringify(ALLOWED_COMMAND_TYPES)}`
    );
  });

  // ---- Task 4: discoveryService -------------------------------------------
  const {
    ingestReport,
    listNodes,
    setNodeReview,
    identifyNode,
    requestEnrollment,
    getNode,
    failStaleDiscoveryRuns,
  } = await import('../src/services/discoveryService');

  const s = (match: string, rows: Record<string, unknown>[] = []): ScriptedRow => ({ match, rows });
  const RUNNER = 'FROM devices WHERE id =';
  const NODE_BY_IP = 'FROM network_nodes WHERE ip_address';
  const DEV_BY_MAC = 'FROM devices WHERE LOWER(mac_address)';
  const RUN_FINALIZE = 'UPDATE network_discovery_runs';

  const oneHost = (over: Partial<Record<string, unknown>> = {}) => ({
    subnets: ['192.168.1.0/24'],
    truncated: false,
    hosts: [
      {
        ip: '192.168.1.50',
        mac: 'AA:BB:CC:DD:EE:FF',
        hostname: 'pc1',
        os_estimate: 'Windows',
        rtt_ms: 5,
        ...over,
      },
    ],
  });

  await checkAsync('test_ingest_links_device_by_mac_case_insensitive', async () => {
    setScripts([
      s(RUNNER, [{ id: 'dev-runner', created_by: 'user-1' }]),
      s(NODE_BY_IP, []),
      s(DEV_BY_MAC, [{ id: 'dev-linked' }]),
    ]);
    const { result, calls: emitted } = await captureCalls(() =>
      ingestReport({
        commandId: 'cmd-1',
        deviceId: 'dev-runner',
        status: 'completed',
        report: oneHost(),
        issuedBy: 'user-1',
      })
    );
    assert.strictEqual(result.linked_devices, 1, `expected linked_devices=1, got ${JSON.stringify(result)}`);
    assert.strictEqual(result.new_nodes, 1);
    assert.ok(
      emitted.some((c) => c.params.includes('dev-linked')),
      'linked device uuid must appear in upsert params'
    );
  });

  await checkAsync('test_ingest_upserts_host_without_mac', async () => {
    setScripts([
      s(RUNNER, [{ id: 'dev-runner', created_by: 'user-1' }]),
      s('mac_address IS NULL', []),
      s('FROM hermes_assets', []),
    ]);
    const report = oneHost({ mac: null });
    const { result, calls: emitted } = await captureCalls(() =>
      ingestReport({
        commandId: 'cmd-2',
        deviceId: 'dev-runner',
        status: 'completed',
        report,
        issuedBy: 'user-1',
      })
    );
    assert.strictEqual(result.new_nodes, 1, `expected new_nodes=1, got ${JSON.stringify(result)}`);
    assert.ok(
      !emitted.some((c) => c.sql.includes('LOWER(mac_address)')),
      'device-by-MAC lookup must be skipped when mac is null'
    );
  });

  await checkAsync('test_ingest_preserves_first_seen_and_identify_fields', async () => {
    setScripts([
      s(RUNNER, [{ id: 'dev-runner', created_by: 'user-1' }]),
      s(NODE_BY_IP, [
        {
          id: 'node-9',
          name: 'Printer-HP',
          node_type: 'PRINTER',
          device_id: null,
          hostname: 'printer',
        },
      ]),
      s(DEV_BY_MAC, [{ id: 'dev-printer' }]),
    ]);
    const { calls: emitted } = await captureCalls(() =>
      ingestReport({
        commandId: 'cmd-3',
        deviceId: 'dev-runner',
        status: 'completed',
        report: oneHost({ ip: '192.168.1.20', mac: 'AA:BB:CC:DD:EE:FF' }),
        issuedBy: 'user-1',
      })
    );
    const updates = emitted.filter((c) => c.sql.startsWith('UPDATE network_nodes'));
    assert.strictEqual(updates.length, 1, `expected exactly 1 network_nodes UPDATE, got ${updates.length}`);
    const upd = updates[0].sql;
    assert.ok(!upd.includes('first_seen'), `UPDATE must not touch first_seen: ${upd}`);
    assert.ok(!/\bname\s*=/.test(upd), `UPDATE must not touch admin name: ${upd}`);
    assert.ok(!upd.includes('node_type'), `UPDATE must not touch node_type: ${upd}`);
  });

  await checkAsync('test_ingest_creates_hermes_recommendation_for_new_unlinked_node', async () => {
    setScripts([
      s(RUNNER, [{ id: 'dev-runner', created_by: 'user-1' }]),
      s(NODE_BY_IP, []),
      s('FROM hermes_assets', []),
    ]);
    const { calls: emitted } = await captureCalls(() =>
      ingestReport({
        commandId: 'cmd-4',
        deviceId: 'dev-runner',
        status: 'completed',
        report: oneHost({ mac: null }),
        issuedBy: 'user-1',
      })
    );
    const sqls = emitted.map((c) => c.sql).join('\n');
    assert.ok(sqls.includes('INSERT INTO hermes_assets'), 'missing hermes_assets insert');
    assert.ok(sqls.includes('INSERT INTO hermes_alerts'), 'missing hermes_alerts insert');
    const rec = emitted.find((c) => c.sql.includes('INSERT INTO hermes_recommendations'));
    assert.ok(rec, 'missing hermes_recommendations insert');
    assert.ok(
      rec.sql.includes('identify_device') || rec.params.includes('identify_device'),
      'recommendation must use action_type identify_device'
    );
  });

  await checkAsync('test_ingest_failed_status_finalizes_run_failed', async () => {
    setScripts([s(RUNNER, [{ id: 'dev-runner', created_by: 'user-1' }])]);
    const { result, calls: emitted } = await captureCalls(() =>
      ingestReport({
        commandId: 'cmd-5',
        deviceId: 'dev-runner',
        status: 'failed',
        report: new Error('agent blew up'),
        issuedBy: 'user-1',
      })
    );
    assert.deepStrictEqual(result, {
      hosts_alive: 0,
      new_nodes: 0,
      updated_nodes: 0,
      linked_devices: 0,
      truncated: false,
    });
    const fin = emitted.find((c) => c.sql.includes(RUN_FINALIZE));
    assert.ok(fin, 'run must be finalized');
    assert.ok(fin.params.includes('failed'), `finalize must set status failed: ${JSON.stringify(fin.params)}`);
    assert.ok(
      !emitted.some((c) => c.sql.includes('network_nodes') && /INSERT|UPDATE/.test(c.sql)),
      'failed status must not write nodes'
    );
  });

  await checkAsync('test_ingest_never_throws_on_malformed_report', async () => {
    setScripts([s(RUNNER, [{ id: 'dev-runner', created_by: 'user-1' }])]);
    const { result, calls: emitted } = await captureCalls(() =>
      ingestReport({
        commandId: 'cmd-6',
        deviceId: 'dev-runner',
        status: 'completed',
        report: 'garbage',
        issuedBy: 'user-1',
      })
    );
    assert.strictEqual(result.new_nodes, 0);
    const fin = emitted.find((c) => c.sql.includes(RUN_FINALIZE));
    assert.ok(fin, 'malformed report must still finalize the run');
    assert.ok(fin.params.includes('failed'), 'malformed report must finalize as failed');
  });

  await checkAsync('test_list_nodes_scopes_by_created_by', async () => {
    setScripts([
      s('COUNT(*)', [{ total: 3 }]),
      s('FROM network_nodes n', [{ id: 'n1', ip_address: '192.168.1.5' }]),
    ]);
    const scoped = await captureCalls(() =>
      listNodes({ page: 1, limit: 10, user: { id: 'u1', permissions: ['network.view'] } })
    );
    const scopedSql = scoped.calls.map((c) => c.sql).join('\n');
    assert.ok(scopedSql.includes('n.created_by = $1'), `scoped SQL must filter created_by: ${scopedSql}`);
    assert.ok(scoped.calls.some((c) => c.params.includes('u1')), 'scoped params must carry the user id');

    setScripts([
      s('COUNT(*)', [{ total: 3 }]),
      s('FROM network_nodes n', [{ id: 'n1', ip_address: '192.168.1.5' }]),
    ]);
    const admin = await captureCalls(() =>
      listNodes({ page: 1, limit: 10, user: { id: 'u2', permissions: ['network.view', 'devices.view_all'] } })
    );
    const adminSql = admin.calls.map((c) => c.sql).join('\n');
    assert.ok(!adminSql.includes('n.created_by = $1'), `view_all must drop the tenant filter: ${adminSql}`);
  });

  await checkAsync('test_list_nodes_pagination_shape', async () => {
    setScripts([
      s('COUNT(*)', [{ total: 25 }]),
      s('FROM network_nodes n', [{ id: 'n1' }]),
    ]);
    const { result } = await captureCalls(() =>
      listNodes({ page: 2, limit: 10, user: { id: 'u1', permissions: ['network.view'] } })
    );
    assert.deepStrictEqual(result.pagination, { page: 2, limit: 10, total: 25, totalPages: 3 });
    assert.ok(Array.isArray(result.nodes));
  });

  await checkAsync('test_request_enrollment_returns_three_commands_and_token', async () => {
    setScripts([s('FROM network_nodes n WHERE', [{ id: 'n1', created_by: 'u1', device_id: null }])]);
    const { result, calls: emitted } = await captureCalls(() =>
      requestEnrollment('n1', { id: 'u1', email: 'u1@x.pt', permissions: ['network.view', 'devices.view_all'] })
    );
    assert.ok(result, 'expected enrollment result');
    const payload = jwt.verify(result.token, JWT.ACCESS_SECRET) as Record<string, unknown>;
    assert.strictEqual(payload.sub, 'u1');
    assert.strictEqual(payload.typ, 'enroll');
    assert.ok(result.commands.windows.includes('install.ps1?t='), result.commands.windows);
    assert.ok(result.commands.linux.includes('install-linux.sh?t='), result.commands.linux);
    assert.ok(result.commands.macos.includes('install-macos.sh?t='), result.commands.macos);
    const upd = emitted.find((c) => c.sql.startsWith('UPDATE network_nodes'));
    assert.ok(upd, 'must update the node');
    assert.ok(upd.sql.includes("review_status = 'enrollment_requested'"), upd.sql);
    assert.ok(upd.sql.includes('enrollment_requested_at'), upd.sql);
  });

  await checkAsync('test_set_node_review_writes_audit', async () => {
    setScripts([s('UPDATE network_nodes SET review_status', [{ id: 'n1' }])]);
    const { result, calls: emitted } = await captureCalls(() =>
      setNodeReview('n1', 'known', { id: 'u1', permissions: ['network.view'] })
    );
    assert.strictEqual(result, true);
    const aud = emitted.find((c) => c.sql.includes('INSERT INTO audit_logs'));
    assert.ok(aud, 'review must write an audit_logs row');
    assert.ok(
      aud.params.includes('network_node_review'),
      `audit action must be network_node_review: ${JSON.stringify(aud.params)}`
    );
  });

  await checkAsync('test_identify_node_overwrites_only_provided_fields', async () => {
    setScripts([s('UPDATE network_nodes SET name', [{ id: 'n1' }])]);
    const { result, calls: emitted } = await captureCalls(() =>
      identifyNode('n1', { name: 'X' }, { id: 'u1', permissions: ['network.view'] })
    );
    assert.strictEqual(result, true);
    const upd = emitted.find((c) => c.sql.startsWith('UPDATE network_nodes'));
    assert.ok(upd, 'must update the node');
    assert.ok(upd.sql.includes('name'), upd.sql);
    assert.ok(!upd.sql.includes('node_type'), `must not touch node_type when not provided: ${upd.sql}`);
  });

  // Final-review regression: mutations must be tenant-scoped like getNode/listNodes.
  // A user without devices.view_all must only reach nodes it owns; getNode's scoped
  // SQL must also be syntactically valid (AND before the visibility predicate).
  await checkAsync('test_mutations_scope_by_created_by', async () => {
    const scoped = { id: 'u1', permissions: ['network.view'] };

    setScripts([s('UPDATE network_nodes SET review_status', [{ id: 'n1' }])]);
    const rev = await captureCalls(() => setNodeReview('n1', 'known', scoped));
    const revUpd = rev.calls.find((c) => c.sql.startsWith('UPDATE network_nodes'));
    assert.ok(revUpd, 'setNodeReview must emit an UPDATE');
    assert.ok(
      revUpd.sql.includes('created_by'),
      `setNodeReview UPDATE must filter by tenant: ${revUpd.sql}`
    );
    assert.ok(revUpd.params.includes('u1'), 'setNodeReview must carry the caller user id');

    setScripts([s('UPDATE network_nodes SET name', [{ id: 'n1' }])]);
    const ident = await captureCalls(() => identifyNode('n1', { name: 'X' }, scoped));
    const identUpd = ident.calls.find((c) => c.sql.startsWith('UPDATE network_nodes'));
    assert.ok(identUpd, 'identifyNode must emit an UPDATE');
    assert.ok(
      identUpd.sql.includes('created_by'),
      `identifyNode UPDATE must filter by tenant: ${identUpd.sql}`
    );

    setScripts([s('FROM network_nodes', [])]);
    const enr = await captureCalls(() =>
      requestEnrollment('n1', { id: 'u1', email: 'u1@x.pt', permissions: ['network.view'] })
    );
    assert.strictEqual(enr.result, null, 'requestEnrollment must deny a node owned by another tenant');
    const upd = enr.calls.find((c) => c.sql.startsWith('UPDATE network_nodes'));
    assert.ok(!upd, 'requestEnrollment must not update a node it cannot see');

    setScripts([s('FROM network_nodes n WHERE', [])]);
    const get = await captureCalls(() => getNode('n1', scoped));
    assert.strictEqual(get.result, null, 'getNode must return null for an invisible node');
    const sel = get.calls.find((c) => c.sql.includes('FROM network_nodes'));
    assert.ok(sel, 'getNode must SELECT the node');
    assert.ok(
      /WHERE n\.id = \$\d+ AND/.test(sel.sql),
      `getNode scoped SQL must AND-join the id and visibility predicates: ${sel.sql}`
    );

    setScripts([s('UPDATE network_nodes SET review_status', [{ id: 'n1' }])]);
    const adminRev = await captureCalls(() =>
      setNodeReview('n1', 'known', { id: 'u2', permissions: ['network.view', 'devices.view_all'] })
    );
    const adminUpd = adminRev.calls.find((c) => c.sql.startsWith('UPDATE network_nodes'));
    assert.ok(adminUpd, 'view_all caller must still emit the UPDATE');
    assert.ok(
      !adminUpd.sql.includes('created_by'),
      `view_all must drop the tenant filter on mutations: ${adminUpd.sql}`
    );
  });

  // ---- Task 7 (bugfix): agent error_message passthrough + run watchdog ----
  await checkAsync('test_ingest_failed_prefers_agent_error_message', async () => {
    setScripts([s(RUNNER, [{ id: 'dev-runner', created_by: 'user-1' }])]);
    const { calls: emitted } = await captureCalls(() =>
      ingestReport({
        commandId: 'cmd-em',
        deviceId: 'dev-runner',
        status: 'failed',
        report: null,
        errorMessage: 'Unknown command type: network_discovery',
        issuedBy: 'user-1',
      })
    );
    const fin = emitted.find((c) => c.sql.includes(RUN_FINALIZE));
    assert.ok(fin, 'run must be finalized');
    assert.ok(
      fin.params.includes('Unknown command type: network_discovery'),
      `finalize must carry the agent error_message: ${JSON.stringify(fin.params)}`
    );
  });

  await checkAsync('test_fail_stale_discovery_runs_emits_watchdog_sql', async () => {
    const { calls: emitted } = await captureCalls(() => failStaleDiscoveryRuns());
    const expire = emitted.find((c) => c.sql.includes('UPDATE agent_commands'));
    assert.ok(expire, 'watchdog must expire stale network_discovery commands');
    assert.ok(expire.sql.includes("'network_discovery'"), `expiry must target network_discovery only: ${expire.sql}`);
    assert.ok(expire.sql.includes("'pending'") && expire.sql.includes("'processing'"), `expiry must cover pending+processing: ${expire.sql}`);
    assert.ok(/INTERVAL '5 minutes'/.test(expire.sql), `expiry must use the 5 minute window: ${expire.sql}`);

    const fin = emitted.find((c) => c.sql.includes('UPDATE network_discovery_runs'));
    assert.ok(fin, 'watchdog must finalize runs whose command failed');
    assert.ok(fin.sql.includes('FROM agent_commands'), `finalize must join agent_commands: ${fin.sql}`);
    assert.ok(fin.sql.includes("'running'"), `finalize must only touch running runs: ${fin.sql}`);
    assert.ok(fin.sql.includes("c.status = 'failed'"), `finalize must key off failed commands: ${fin.sql}`);
    assert.ok(
      fin.params.some((p) => typeof p === 'string' && p.includes('hosts_alive')),
      `finalize must write zero stats: ${JSON.stringify(fin.params)}`
    );
  });

  // ---- Task 5: HTTP routes -------------------------------------------------
  const { default: netsentinelRouter } = await import('../src/routes/netsentinel');
  const { default: devicesRouter } = await import('../src/routes/devices');

  const sessionToken = (id: string, roleId: string, permissions: string[]): string => {
    setRolePermissions(roleId, permissions);
    return jwt.sign(
      { id, email: `${id}@test.local`, role_id: roleId, role_name: 'user', permissions },
      JWT.ACCESS_SECRET,
      { issuer: JWT.ISSUER, audience: JWT.AUDIENCE, expiresIn: '1h' }
    );
  };

  const netToken = sessionToken('user-net', 'role-net', ['network.view']);
  const manageToken = sessionToken('user-manage', 'role-manage', ['devices.manage']);
  const noneToken = sessionToken('user-none', 'role-none', []);
  const agentSecret = process.env.AGENT_SECRET || '';

  const app = express();
  app.use(express.json());
  app.use('/api/netsentinel', netsentinelRouter);
  app.use('/api/devices', devicesRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const post = (path: string, token: string | null, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const get = (path: string, token: string) =>
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  try {
    await checkAsync('test_run_requires_network_view', async () => {
      const res = await post('/api/netsentinel/discovery/run', noneToken, {});
      assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
    });

    await checkAsync('test_run_with_public_cidr_rejected', async () => {
      const res = await post('/api/netsentinel/discovery/run', netToken, { cidr: '8.8.8.0/24' });
      assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
    });

    await checkAsync('test_run_no_online_agent_conflict_409', async () => {
      setScripts([
        s('FROM devices WHERE id =', [{ id: 'dev-offline', created_by: 'user-net', status: 'offline', agent_id: 'agt-1' }]),
      ]);
      const res = await post('/api/netsentinel/discovery/run', netToken, { device_id: 'dev-offline' });
      assert.strictEqual(res.status, 409, `expected 409, got ${res.status}`);
    });

    await checkAsync('test_run_duplicate_running_409', async () => {
      setScripts([
        s('FROM devices WHERE id =', [{ id: 'dev-1', created_by: 'user-net', status: 'online', agent_id: 'agt-1' }]),
        s("status = 'running'", [{ id: 'run-live' }]),
      ]);
      const res = await post('/api/netsentinel/discovery/run', netToken, { device_id: 'dev-1' });
      assert.strictEqual(res.status, 409, `expected 409, got ${res.status}`);
    });

    await checkAsync('test_run_enqueues_command_and_returns_ids', async () => {
      setScripts([
        s('FROM devices WHERE id =', [{ id: 'dev-1', created_by: 'user-net', status: 'online', agent_id: 'agt-1' }]),
        s("status = 'running'", []),
      ]);
      capturing = true;
      let res: Response;
      try {
        res = await post('/api/netsentinel/discovery/run', netToken, { device_id: 'dev-1', cidr: '192.168.1.0/24' });
      } finally {
        capturing = false;
      }
      assert.strictEqual(res.status, 201, `expected 201, got ${res.status}`);
      const body = (await res.json()) as { success: boolean; data: { run_id: string; command_id: string; device_id: string } };
      assert.strictEqual(body.data.command_id, body.data.run_id, 'run id must equal command id');
      assert.strictEqual(body.data.device_id, 'dev-1');
      const sqls = calls.map((c) => c.sql).join('\n');
      assert.ok(sqls.includes('INSERT INTO agent_commands'), 'missing agent_commands insert');
      assert.ok(sqls.includes('network_discovery'), 'command must be network_discovery');
      assert.ok(sqls.includes('INSERT INTO network_discovery_runs'), 'missing run insert');
      const cmdInsert = calls.find((c) => c.sql.includes('INSERT INTO agent_commands'));
      assert.ok(cmdInsert && cmdInsert.params.includes(body.data.command_id), 'command id must match run id in insert params');
    });

    await checkAsync('test_nodes_list_and_detail_and_review_and_identify', async () => {
      setScripts([
        s('COUNT(*)', [{ total: 1 }]),
        s('FROM network_nodes n', [{ id: 'n-http', ip_address: '192.168.1.7', created_by: 'user-manage' }]),
        s('FROM network_nodes n WHERE', [{ id: 'n-http', ip_address: '192.168.1.7', created_by: 'user-manage' }]),
        s('UPDATE network_nodes SET review_status', [{ id: 'n-http' }]),
        s('UPDATE network_nodes SET name', [{ id: 'n-http' }]),
      ]);
      const listRes = await get('/api/netsentinel/discovery/nodes', netToken);
      assert.strictEqual(listRes.status, 200, `list: expected 200, got ${listRes.status}`);
      const listBody = (await listRes.json()) as { data: { nodes: unknown[]; pagination: { total: number } } };
      assert.ok(Array.isArray(listBody.data.nodes), 'list must return nodes array');
      assert.strictEqual(listBody.data.pagination.total, 1);

      const detailRes = await get('/api/netsentinel/discovery/nodes/n-http', netToken);
      assert.strictEqual(detailRes.status, 200, `detail: expected 200, got ${detailRes.status}`);

      capturing = true;
      let knownRes: Response;
      let idRes: Response;
      try {
        knownRes = await post('/api/netsentinel/discovery/nodes/n-http/mark-known', netToken, {});
        idRes = await post('/api/netsentinel/discovery/nodes/n-http/identify', netToken, { name: 'Reception-PC' });
      } finally {
        capturing = false;
      }
      assert.strictEqual(knownRes.status, 204, `mark-known: expected 204, got ${knownRes.status}`);
      assert.strictEqual(idRes.status, 204, `identify: expected 204, got ${idRes.status}`);
      const reviewUpd = calls.find((c) => c.sql.includes("review_status = 'known'") || (c.sql.startsWith('UPDATE network_nodes SET review_status') && c.params.includes('known')));
      assert.ok(reviewUpd, `mark-known must persist review_status=known: ${JSON.stringify(calls.map((c) => c.sql))}`);

      setScripts([s('FROM network_nodes n WHERE', [])]);
      const missingRes = await get('/api/netsentinel/discovery/nodes/n-missing', netToken);
      assert.strictEqual(missingRes.status, 404, `missing node: expected 404, got ${missingRes.status}`);
    });

    await checkAsync('test_enroll_request_requires_devices_manage', async () => {
      const denied = await post('/api/netsentinel/discovery/nodes/n-http/enroll-request', netToken, {});
      assert.strictEqual(denied.status, 403, `expected 403 for network.view-only, got ${denied.status}`);

      setScripts([s('FROM network_nodes n WHERE', [{ id: 'n-http', created_by: 'user-manage' }])]);
      capturing = true;
      let okRes: Response;
      try {
        okRes = await post('/api/netsentinel/discovery/nodes/n-http/enroll-request', manageToken, {});
      } finally {
        capturing = false;
      }
      assert.strictEqual(okRes.status, 200, `expected 200, got ${okRes.status}`);
      const body = (await okRes.json()) as { data: { token: string; commands: { macos: string } } };
      assert.ok(body.data.commands.macos.includes('install-macos.sh?t='), body.data.commands.macos);
    });

    await checkAsync('test_command_result_dispatches_ingest_for_network_discovery', async () => {
      setScripts([
        s('FROM devices WHERE agent_id', [{ id: 'dev-agent', created_by: 'user-net' }]),
        s('SELECT command_type FROM agent_commands', [{ command_type: 'network_discovery' }]),
        s('FROM devices WHERE id =', [{ id: 'dev-agent', created_by: 'user-net' }]),
        s('mac_address IS NULL', []),
        s('FROM hermes_assets', []),
      ]);
      const mark = calls.length;
      capturing = true;
      let res: Response;
      try {
        res = await post(
          '/api/devices/command-result',
          null,
          {
            agent_id: 'agt-live',
            command_id: 'cmd-ingest-1',
            status: 'completed',
            result: { subnets: ['192.168.1.0/24'], truncated: false, hosts: [{ ip: '192.168.1.60', mac: null, hostname: 'host60', os_estimate: 'Linux', rtt_ms: 3 }] },
          },
          { 'X-Agent-Secret': agentSecret }
        );
        assert.strictEqual(res.status, 200, `expected immediate 200, got ${res.status}`);
        await new Promise((r) => setTimeout(r, 80));
      } finally {
        capturing = false;
      }
      const sqls = calls.slice(mark).map((c) => c.sql).join('\n');
      assert.ok(sqls.includes('UPDATE agent_commands'), 'must record the command result');
      assert.ok(sqls.includes('INSERT INTO network_nodes'), 'ingest must write the discovered node');
      assert.ok(sqls.includes('UPDATE network_discovery_runs'), 'ingest must finalize the run');
    });

    await checkAsync('test_ingest_error_does_not_fail_command_result', async () => {
      setScripts([
        s('FROM devices WHERE agent_id', [{ id: 'dev-agent', created_by: 'user-net' }]),
        s('SELECT command_type FROM agent_commands', [{ command_type: 'network_discovery' }]),
        s('FROM devices WHERE id =', [{ id: 'dev-agent', created_by: 'user-net' }]),
        s('mac_address IS NULL', []),
        s('FROM hermes_assets', []),
      ]);
      injectErrorOnce('INSERT INTO network_nodes', 'disk full');
      const res = await post(
        '/api/devices/command-result',
        null,
        {
          agent_id: 'agt-live',
          command_id: 'cmd-ingest-2',
          status: 'completed',
          result: { subnets: [], truncated: false, hosts: [{ ip: '192.168.1.61', mac: null, hostname: null, os_estimate: 'Unknown', rtt_ms: null }] },
        },
        { 'X-Agent-Secret': agentSecret }
      );
      assert.strictEqual(res.status, 200, `expected 200 despite ingest error, got ${res.status}`);
      const body = (await res.json()) as { success: boolean };
      assert.strictEqual(body.success, true);
      await new Promise((r) => setTimeout(r, 80));
    });

    await checkAsync('test_command_result_failed_forwards_error_message_to_run', async () => {
      setScripts([
        s('FROM devices WHERE agent_id', [{ id: 'dev-agent', created_by: 'user-net' }]),
        s('SELECT command_type FROM agent_commands', [{ command_type: 'network_discovery' }]),
      ]);
      const mark = calls.length;
      capturing = true;
      let res: Response;
      try {
        res = await post(
          '/api/devices/command-result',
          null,
          {
            agent_id: 'agt-live',
            command_id: 'cmd-fail-em',
            status: 'failed',
            error_message: 'Unknown command type: network_discovery',
          },
          { 'X-Agent-Secret': agentSecret }
        );
        assert.strictEqual(res.status, 200, `expected immediate 200, got ${res.status}`);
        await new Promise((r) => setTimeout(r, 80));
      } finally {
        capturing = false;
      }
      const fin = calls.slice(mark).find((c) => c.sql.includes('UPDATE network_discovery_runs'));
      assert.ok(fin, 'failed result must finalize the run');
      assert.ok(
        fin.params.includes('Unknown command type: network_discovery'),
        `run error_message must come from the agent: ${JSON.stringify(fin.params)}`
      );
    });

    await checkAsync('test_get_discovery_runs_runs_watchdog_first', async () => {
      const mark = calls.length;
      capturing = true;
      let res: Response;
      try {
        res = await get('/api/netsentinel/discovery', netToken);
        assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      } finally {
        capturing = false;
      }
      const sqls = calls.slice(mark).map((c) => c.sql);
      assert.ok(
        sqls.some((s) => s.includes('UPDATE agent_commands') && s.includes("'network_discovery'")),
        'GET /discovery must expire stale discovery commands before listing'
      );
      assert.ok(
        sqls.some((s) => s.includes('UPDATE network_discovery_runs') && s.includes('FROM agent_commands')),
        'GET /discovery must finalize runs whose command failed before listing'
      );
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

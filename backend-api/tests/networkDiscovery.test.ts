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

const respond = (sql: string) => {
  for (const s of scripts) {
    if (sql.includes(s.match)) return { rows: s.rows, rowCount: s.rows.length };
  }
  return sql.includes('FROM permissions')
    ? { rows: [{ code: 'network.view' }, { code: 'devices.view' }], rowCount: 2 }
    : { rows: [], rowCount: 0 };
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
  return respond(sql);
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
    setScripts([s('FROM network_nodes WHERE id =', [{ id: 'n1', created_by: 'u1', device_id: null }])]);
    const { result, calls: emitted } = await captureCalls(() =>
      requestEnrollment('n1', { id: 'u1', email: 'u1@x.pt' })
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

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

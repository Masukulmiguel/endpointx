/**
 * RED->GREEN gate for the v1.3.0 installation authorization flow:
 *   - inline schema: installation_requests table + indexes, created once
 *   - installRequests service: state machine (create/decide/gate/integrate)
 *   - public /api/enroll routes: consent page + decision endpoints
 *   - install.ps1 template carries the native consent dialog
 * Run: npx tsx tests/installRequests.test.ts
 */
import './testEnv';
import assert from 'assert';
import express from 'express';
import http from 'http';

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

const respond = (sql: string, params: unknown[] = []) => {
  void params;
  for (const s of scripts) {
    if (sql.includes(s.match)) return { rows: s.rows, rowCount: s.rows.length };
  }
  return { rows: [], rowCount: 0 };
};

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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const svc = require('../src/services/installRequests') as typeof import('../src/services/installRequests');

const FUTURE = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const PAST = new Date(Date.now() - 3600 * 1000).toISOString();
const HEX64 = 'a'.repeat(64);
const NODE_ID = '11111111111111111111111111111111';
const USER_ID = '22222222222222222222222222222222';

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '33333333333333333333333333333333',
    node_id: NODE_ID,
    device_id: null,
    requested_by: USER_ID,
    status: 'pending',
    invite_token: HEX64,
    install_jti: 'b'.repeat(64),
    os_hint: 'Windows',
    decision: null,
    decision_channel: null,
    delivered_at: null,
    decided_at: null,
    installing_at: null,
    installed_at: null,
    integrated_at: null,
    expires_at: FUTURE,
    error_message: null,
    created_at: FUTURE,
    updated_at: FUTURE,
    node_ip: '192.168.1.50',
    node_mac: 'aa:bb:cc:dd:ee:ff',
    node_hostname: 'PC-SALA3',
    device_name: null,
    ...overrides,
  };
}

async function main(): Promise<void> {
  capturing = true;
  await initDatabase();
  capturing = false;
  const statements = calls.map((c) => c.sql);

  check('schema_creates_installation_requests_exactly_once', () => {
    const creates = statements.filter((s) => /CREATE TABLE IF NOT EXISTS installation_requests/.test(s));
    assert.strictEqual(creates.length, 1, `expected 1 CREATE TABLE installation_requests, got ${creates.length}`);
    const ddl = creates[0];
    for (const col of ['invite_token', 'install_jti', 'expires_at', 'decision_channel', 'integrated_at']) {
      assert.ok(ddl.includes(col), `DDL missing column ${col}`);
    }
  });

  check('schema_indexes_installation_requests', () => {
    for (const idx of [
      'idx_installation_requests_status',
      'idx_installation_requests_node',
      'idx_installation_requests_device',
    ]) {
      const hits = statements.filter((s) => s.includes(idx));
      assert.strictEqual(hits.length, 1, `expected exactly 1 statement for ${idx}, got ${hits.length}`);
    }
  });

  check('install_token_jwt_carries_install_typ_and_jti', () => {
    const token = svc.buildInstallToken(
      { id: USER_ID },
      { install_jti: 'b'.repeat(64), node_mac: 'aa:bb', node_ip: '10.0.0.1' }
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { JWT } = require('../src/config/constants') as typeof import('../src/config/constants');
    const payload = jwt.verify(token, JWT.ACCESS_SECRET) as Record<string, unknown>;
    assert.strictEqual(payload.typ, 'install');
    assert.strictEqual(payload.sub, USER_ID);
    assert.strictEqual(payload.jti, 'b'.repeat(64));
    const expSec = Number(payload.exp) - Math.floor(Date.now() / 1000);
    assert.ok(expSec > 6 * 24 * 3600 && expSec <= 7 * 24 * 3600, `exp ~7d, got ${expSec}s`);
  });

  check('install_commands_point_at_public_script_endpoints', () => {
    const cmds = svc.buildInstallCommands(
      { id: USER_ID },
      { install_jti: 'b'.repeat(64), node_mac: null, node_ip: null }
    );
    assert.ok(cmds.windows.includes('/api/devices/public/install.ps1?t='), cmds.windows);
    assert.ok(cmds.linux.includes('/api/devices/public/install-linux.sh?t='), cmds.linux);
    assert.ok(cmds.macos.includes('/api/devices/public/install-macos.sh?t='), cmds.macos);
    assert.ok(svc.buildInviteUrl(HEX64).endsWith(`/api/enroll/invite/${HEX64}`));
  });

  await checkAsync('get_invite_rejects_malformed_token', async () => {
    const { result, calls: emitted } = await captureCalls(() => svc.getInviteByToken('nope'));
    assert.strictEqual(result, null);
    assert.strictEqual(emitted.length, 0, 'malformed token must not hit the DB');
  });

  await checkAsync('create_blocks_already_enrolled_node', async () => {
    setScripts([
      { match: 'FROM network_nodes WHERE id', rows: [{ id: NODE_ID, device_id: 'dev1', mac_address: null, ip_address: null, hostname: null, metadata: {}, created_by: USER_ID }] },
    ]);
    const results = await svc.createInstallRequests([NODE_ID], { id: USER_ID, permissions: [] });
    assert.strictEqual(results[0].ok, false);
    assert.strictEqual(results[0].reason, 'already_enrolled');
  });

  await checkAsync('create_blocks_when_active_request_exists', async () => {
    setScripts([
      { match: 'FROM network_nodes WHERE id', rows: [{ id: NODE_ID, device_id: null, mac_address: 'aa:bb', ip_address: '10.0.0.2', hostname: 'x', metadata: {}, created_by: USER_ID }] },
      { match: 'SELECT id FROM installation_requests', rows: [{ id: 'active1' }] },
    ]);
    const results = await svc.createInstallRequests([NODE_ID], { id: USER_ID, permissions: [] });
    assert.strictEqual(results[0].ok, false);
    assert.strictEqual(results[0].reason, 'active_request_exists');
  });

  await checkAsync('create_success_inserts_and_marks_node_review_status', async () => {
    setScripts([
      { match: 'FROM network_nodes WHERE id', rows: [{ id: NODE_ID, device_id: null, mac_address: 'aa:bb:cc:dd:ee:ff', ip_address: '192.168.1.50', hostname: 'PC-SALA3', metadata: { os_estimate: 'Windows' }, created_by: USER_ID }] },
      { match: 'SELECT id FROM installation_requests', rows: [] },
      { match: 'INSERT INTO installation_requests', rows: [baseRow()] },
      { match: "SET review_status = 'enrollment_requested'", rows: [] },
      { match: 'INSERT INTO audit_logs', rows: [] },
    ]);
    const { result, calls: emitted } = await captureCalls(() =>
      svc.createInstallRequests([NODE_ID], { id: USER_ID, permissions: [] })
    );
    assert.strictEqual(result[0].ok, true, JSON.stringify(result[0]));
    assert.strictEqual(result[0].request?.status, 'pending');
    assert.strictEqual(result[0].request?.os_hint, 'Windows');
    const inserts = emitted.filter((c) => c.sql.includes('INSERT INTO installation_requests'));
    assert.strictEqual(inserts.length, 1, 'exactly one INSERT per node');
    assert.ok(
      emitted.some((c) => c.sql.includes('enrollment_requested')),
      'node review_status must flip to enrollment_requested'
    );
  });

  await checkAsync('create_blocks_node_from_another_tenant', async () => {
    setScripts([
      { match: 'FROM network_nodes WHERE id', rows: [{ id: NODE_ID, device_id: null, mac_address: 'aa:bb', ip_address: '10.0.0.3', hostname: 'other', metadata: {}, created_by: 'other-user' }] },
    ]);
    const { result, calls: emitted } = await captureCalls(() =>
      svc.createInstallRequests([NODE_ID], { id: USER_ID, permissions: ['devices.manage'] })
    );
    assert.strictEqual(result[0].ok, false, JSON.stringify(result[0]));
    assert.strictEqual(result[0].reason, 'node_not_found', 'cross-tenant must be indistinguishable from a missing node');
    assert.ok(
      !emitted.some((c) => c.sql.includes('INSERT INTO installation_requests')),
      'must not create a request for another tenant node'
    );
    assert.ok(
      !emitted.some((c) => c.sql.includes('UPDATE network_nodes')),
      'must not touch another tenant node'
    );
  });

  await checkAsync('create_allows_node_owner_without_view_all', async () => {
    setScripts([
      { match: 'FROM network_nodes WHERE id', rows: [{ id: NODE_ID, device_id: null, mac_address: 'aa:bb:cc:dd:ee:ff', ip_address: '192.168.1.50', hostname: 'OWN-PC', metadata: { os_estimate: 'Windows' }, created_by: USER_ID }] },
      { match: 'SELECT id FROM installation_requests', rows: [] },
      { match: 'INSERT INTO installation_requests', rows: [baseRow()] },
      { match: "SET review_status = 'enrollment_requested'", rows: [] },
      { match: 'INSERT INTO audit_logs', rows: [] },
    ]);
    const { result } = await captureCalls(() =>
      svc.createInstallRequests([NODE_ID], { id: USER_ID, permissions: ['devices.manage'] })
    );
    assert.strictEqual(result[0].ok, true, JSON.stringify(result[0]));
  });

  await checkAsync('create_allows_view_all_for_unowned_node', async () => {
    setScripts([
      { match: 'FROM network_nodes WHERE id', rows: [{ id: NODE_ID, device_id: null, mac_address: 'aa:bb:cc:dd:ee:ff', ip_address: '192.168.1.50', hostname: 'UNOWNED', metadata: { os_estimate: 'Windows' }, created_by: null }] },
      { match: 'SELECT id FROM installation_requests', rows: [] },
      { match: 'INSERT INTO installation_requests', rows: [baseRow()] },
      { match: "SET review_status = 'enrollment_requested'", rows: [] },
      { match: 'INSERT INTO audit_logs', rows: [] },
    ]);
    const { result } = await captureCalls(() =>
      svc.createInstallRequests([NODE_ID], { id: USER_ID, permissions: ['devices.manage', 'devices.view_all'] })
    );
    assert.strictEqual(result[0].ok, true, JSON.stringify(result[0]));
  });

  await checkAsync('decision_refuse_from_pending', async () => {
    setScripts([
      { match: 'WHERE r.invite_token', rows: [baseRow({ status: 'pending' })] },
      { match: 'SET status = $2, decision = $2', rows: [baseRow({ status: 'refused', decision: 'refused', decision_channel: 'web' })] },
      { match: 'INSERT INTO audit_logs', rows: [] },
    ]);
    const result = await svc.recordDecision(HEX64, 'refuse', 'web');
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(result.request?.status, 'refused');
  });

  await checkAsync('decision_authorize_is_idempotent', async () => {
    setScripts([
      { match: 'WHERE r.invite_token', rows: [baseRow({ status: 'authorized', decision: 'authorize' })] },
    ]);
    const { result, calls: emitted } = await captureCalls(() =>
      svc.recordDecision(HEX64, 'authorize', 'web')
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.request?.status, 'authorized');
    assert.ok(
      !emitted.some((c) => c.sql.includes('SET status = $2, decision = $2')),
      'idempotent authorize must not UPDATE again'
    );
  });

  await checkAsync('decision_refuse_after_authorize_is_invalid_state', async () => {
    setScripts([
      { match: 'WHERE r.invite_token', rows: [baseRow({ status: 'authorized' })] },
    ]);
    const result = await svc.recordDecision(HEX64, 'refuse', 'web');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'invalid_state');
  });

  await checkAsync('decision_on_expired_row_is_rejected', async () => {
    setScripts([
      { match: 'WHERE r.invite_token', rows: [baseRow({ status: 'delivered', expires_at: PAST })] },
    ]);
    const result = await svc.recordDecision(HEX64, 'authorize', 'device');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'expired');
  });

  await checkAsync('install_gate_allows_authorized_and_blocks_refused', async () => {
    setScripts([
      { match: 'WHERE r.install_jti', rows: [baseRow({ status: 'authorized' })] },
    ]);
    let gate = await svc.assertInstallTokenUsable('b'.repeat(64));
    assert.strictEqual(gate.ok, true);

    setScripts([
      { match: 'WHERE r.install_jti', rows: [baseRow({ status: 'refused' })] },
    ]);
    gate = await svc.assertInstallTokenUsable('b'.repeat(64));
    assert.strictEqual(gate.ok, false);
    assert.strictEqual(gate.reason, 'refused');

    setScripts([
      { match: 'WHERE r.install_jti', rows: [baseRow({ status: 'pending' })] },
    ]);
    gate = await svc.assertInstallTokenUsable('b'.repeat(64));
    assert.strictEqual(gate.ok, false);
    assert.strictEqual(gate.reason, 'not_authorized');
  });

  await checkAsync('installed_links_request_and_node_to_device', async () => {
    setScripts([
      { match: 'SET status = \'installed\'', rows: [{ node_id: NODE_ID }] },
      { match: 'SET device_id = $2', rows: [] },
      { match: 'INSERT INTO audit_logs', rows: [] },
    ]);
    const ok = await svc.markRequestInstalledDevice('33333333333333333333333333333333', 'dev123');
    assert.strictEqual(ok, true);
  });

  await checkAsync('installed_guard_rejects_refused_request', async () => {
    setScripts([
      { match: "SET status = 'installed'", rows: [] },
      { match: 'SELECT status FROM installation_requests', rows: [{ status: 'refused' }] },
    ]);
    const ok = await svc.markRequestInstalledDevice('33333333333333333333333333333333', 'dev123');
    assert.strictEqual(ok, false);
  });

  await checkAsync('integrated_only_flips_from_installed', async () => {
    setScripts([
      { match: "SET status = 'integrated'", rows: [{ id: 'req1' }] },
      { match: 'INSERT INTO audit_logs', rows: [] },
    ]);
    const id = await svc.markIntegratedByDevice('dev123');
    assert.strictEqual(id, 'req1');

    setScripts([
      { match: "SET status = 'integrated'", rows: [] },
    ]);
    const none = await svc.markIntegratedByDevice('dev-other');
    assert.strictEqual(none, null);
  });

  await checkAsync('expire_sweep_targets_pending_and_delivered_only', async () => {
    setScripts([
      { match: "SET status = 'expired'", rows: [{ id: 'stale1' }] },
      { match: 'INSERT INTO audit_logs', rows: [] },
    ]);
    const { result, calls: emitted } = await captureCalls(() => svc.expireStaleRequests());
    assert.strictEqual(result, 1);
    const upd = emitted.find((c) => c.sql.includes("SET status = 'expired'"));
    assert.ok(upd, 'sweep UPDATE missing');
    assert.ok(upd!.sql.includes("'pending','delivered'"), upd!.sql);
    assert.ok(upd!.sql.includes('expires_at < NOW()'), upd!.sql);
  });

  await checkAsync('invite_page_marks_delivered_and_renders_consent_form', async () => {
    setScripts([
      { match: 'WHERE r.invite_token', rows: [baseRow({ status: 'pending' })] },
      { match: 'SET status = CASE WHEN status', rows: [] },
    ]);
    const app = express();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const enrollRouter = require('../src/routes/enroll').default;
    app.use('/api/enroll', enrollRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      capturing = true;
      const res = await fetch(`http://127.0.0.1:${port}/api/enroll/invite/${HEX64}`);
      const html = await res.text();
      assert.strictEqual(res.status, 200);
      assert.ok(html.includes('Sim, autorizar instalacao'), 'consent form missing');
      assert.ok(html.includes('PC-SALA3'), 'device hostname missing');
      assert.ok(!html.includes('<script'), 'CSP forbids inline scripts - page must be JS-free');
      assert.ok(
        calls.some((c) => c.sql.includes('SET status = CASE WHEN status') && c.sql.includes('delivered')),
        'GET invite must mark the request delivered'
      );
    } finally {
      capturing = false;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    }
  });

  await checkAsync('invite_decision_form_authorize_returns_commands_html', async () => {
    setScripts([
      { match: 'WHERE r.invite_token', rows: [baseRow({ status: 'delivered' })] },
      { match: 'SET status = $2, decision = $2', rows: [baseRow({ status: 'authorized', decision: 'authorize', decision_channel: 'web' })] },
      { match: 'INSERT INTO audit_logs', rows: [] },
    ]);
    const app = express();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const enrollRouter = require('../src/routes/enroll').default;
    app.use('/api/enroll', enrollRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/enroll/invite/${HEX64}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
        body: 'decision=authorize',
      });
      const html = await res.text();
      assert.strictEqual(res.status, 200, html.slice(0, 200));
      assert.ok(html.includes('Instalacao autorizada'), 'result page missing');
      assert.ok(html.includes('install.ps1?t='), 'windows command missing');
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    }
  });

  await checkAsync('device_decision_endpoint_accepts_install_jwt_json', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { JWT } = require('../src/config/constants') as typeof import('../src/config/constants');
    const token = jwt.sign({ sub: USER_ID, typ: 'install', jti: 'b'.repeat(64) }, JWT.ACCESS_SECRET, { expiresIn: '1h' });

    setScripts([
      { match: 'WHERE r.install_jti', rows: [baseRow({ status: 'delivered' })] },
      { match: 'WHERE r.invite_token', rows: [baseRow({ status: 'delivered' })] },
      { match: 'SET status = $2, decision = $2', rows: [baseRow({ status: 'refused', decision: 'refuse', decision_channel: 'device' })] },
      { match: 'INSERT INTO audit_logs', rows: [] },
    ]);
    const app = express();
    app.use(express.json());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const enrollRouter = require('../src/routes/enroll').default;
    app.use('/api/enroll', enrollRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/enroll/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, decision: 'refuse' }),
      });
      const json = (await res.json()) as { success: boolean; data: { status: string } };
      assert.strictEqual(res.status, 200);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.data.status, 'refused');
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    }
  });

  await checkAsync('invite_page_unknown_token_is_404_html', async () => {
    setScripts([{ match: 'WHERE r.invite_token', rows: [] }]);
    const app = express();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const enrollRouter = require('../src/routes/enroll').default;
    app.use('/api/enroll', enrollRouter);
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/enroll/invite/${'c'.repeat(64)}`);
      assert.strictEqual(res.status, 404);
      const html = await res.text();
      assert.ok(html.includes('Ligacao invalida'), html.slice(0, 120));
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    }
  });

  await checkAsync('install_ps1_template_carries_native_consent_dialog', async () => {
    const { readFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const tpl = readFileSync(join(__dirname, '..', 'public', 'install.ps1'), 'utf-8');
    assert.ok(tpl.includes('##CONSENT_MODE##'), 'template missing ##CONSENT_MODE## placeholder');
    assert.ok(tpl.includes('System.Windows.MessageBox'), 'template missing native MessageBox');
    assert.ok(tpl.includes('/api/enroll/decision'), 'template missing device decision callback');
    assert.ok(tpl.includes('WScript.Shell'), 'template missing Popup fallback');
  });

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

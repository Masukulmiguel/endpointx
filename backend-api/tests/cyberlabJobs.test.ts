/**
 * RED->GREEN gate for Task 4 — cyberlab jobs runner + lifecycle routes.
 *
 * Design notes: same FakePool harness as tests/cyberlabArtifacts.test.ts -
 * a stubbed pg.Pool in require.cache backed by a small in-memory jobs store,
 * so createJob/cancelJob/promoteQueued and the four job routes all run over
 * real SQL semantics (conditional running insert, FIFO promotion, guarded
 * updates). child_process.execFile is swapped in-place the same way
 * cyberlabSeefastCore.test.ts does, returning FakeChild handles whose kill()
 * is the SIGTERM spy; the adapter module itself is replaced via require.cache
 * with a scripted runOperation (mock de runOperation via require-cache, per
 * the brief) that still spawns through the *current* execFile, so the
 * runner's child-capture path is exercised end to end. No engine, no temp
 * files: the storage dir must stay empty (artifacts persist by design, the
 * adapter never writes temps — controller ruling 3).
 * Run: npx tsx tests/cyberlabJobs.test.ts
 */
import './testEnv';
import assert from 'assert';
import { EventEmitter } from 'events';
import express from 'express';
import fs from 'fs';
import http from 'http';
import jwt from 'jsonwebtoken';
import os from 'os';
import path from 'path';
import { JWT } from '../src/config/constants';
import type { JobType, RawRun } from '../src/services/seefast/adapter';
import type { SeefastLimits } from '../src/services/seefast/limits';

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

// ---- Storage: fresh temp dir (never backend-api/storage) -------------------
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberlab-jobs-'));
process.env.CYBERLAB_STORAGE_DIR = storageDir;

// ---- Fake child_process (in-place, installed before seefast modules load) --
type FakeChild = EventEmitter & { killCalls: NodeJS.Signals[] };

const fakeChildren: FakeChild[] = [];
let probeScript: { error: Error | null; stdout: string; stderr: string } = {
  error: null,
  stdout: '{"version":"1.0.0"}',
  stderr: '',
};

function fakeExecFile(
  _file: string,
  args: string[],
  _options: Record<string, unknown>,
  callback?: (error: Error | null, stdout: string, stderr: string) => void
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.killCalls = [];
  child.kill = ((signal: NodeJS.Signals = 'SIGTERM') => {
    child.killCalls.push(signal);
    setImmediate(() => child.emit('close', null, signal));
    return true;
  }) as FakeChild['kill'];
  fakeChildren.push(child);
  if (Array.isArray(args) && args[0] === 'capabilities' && callback) {
    const script = probeScript;
    setImmediate(() => callback(script.error, script.stdout, script.stderr));
  }
  return child;
}

const cpPath = require.resolve('child_process');
const cpModule = require(cpPath) as Record<string, unknown>;
cpModule.execFile = fakeExecFile;
(require.cache as unknown as Record<string, unknown>)[cpPath] = { exports: cpModule, loaded: true };

// ---- Fake pg: in-memory cyberlab_jobs + cyberlab_artifacts ----------------
type JobRecord = {
  id: string;
  type: string;
  status: string;
  target_ref: string | null;
  params: unknown;
  plan: unknown;
  result: unknown;
  error: string | null;
  progress: number;
  cancel_requested: boolean;
  started_by: string | null;
  approval_ref: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const jobsDb = new Map<string, JobRecord>();
const artifactsDb = new Map<string, { id: string; storage_path: string }>();
// Minimal app_settings store: PUT /config writes through setSetting and the
// next getLimits() read must observe it, otherwise a promotion-on-config test
// would be asserting against a store that never moves.
const settingsDb = new Map<string, string>();
const audits: Array<{ sql: string; params: unknown[] }> = [];
const sqlCalls: Array<{ sql: string; params: unknown[] }> = [];
let jobSeq = 0;

const nowStamp = (): string => new Date(Date.UTC(2026, 0, 1) + jobSeq++).toISOString();

const makeJob = (partial: Partial<JobRecord> & Pick<JobRecord, 'type' | 'status' | 'target_ref'>): JobRecord => ({
  id: `00000000-0000-4000-8000-${String(jobSeq).padStart(12, '0')}`,
  params: null,
  plan: null,
  result: null,
  error: null,
  progress: 0,
  cancel_requested: false,
  started_by: null,
  approval_ref: null,
  created_at: nowStamp(),
  started_at: null,
  finished_at: null,
  ...partial,
});

const rolePermissions = new Map<string, Record<string, unknown>[]>();
const setRolePermissions = (roleId: string, codes: string[]): void => {
  rolePermissions.set(roleId, codes.map((code) => ({ code })));
};

const respond = (sql: string, params: unknown[] = []) => {
  if (sql.includes('FROM permissions')) {
    const rows = rolePermissions.get(String(params[0] ?? '')) ?? [];
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('JOIN users u ON u.id = s.user_id')) {
    return {
      rows: [{ expires_at: new Date(Date.now() + 3600e3).toISOString(), is_active: true }],
      rowCount: 1,
    };
  }
  if (sql.includes('FROM app_settings WHERE key = ANY')) {
    // Store-backed so PUT /config actually moves the effective limits (a
    // permanently empty map would make the config tests vacuous).
    const keys = (params[0] as string[]) ?? [];
    const rows = keys.filter((key) => settingsDb.has(key)).map((key) => ({ key, value: settingsDb.get(key) }));
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('INSERT INTO app_settings')) {
    settingsDb.set(String(params[0]), String(params[1]));
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes('INSERT INTO audit_logs')) {
    audits.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }
  if (sql.includes('INSERT INTO cyberlab_artifacts')) {
    const id = String(params[0]);
    artifactsDb.set(id, { id, storage_path: path.join(storageDir, `${id}.js`) });
    return { rows: [{ created_at: nowStamp() }], rowCount: 1 };
  }
  if (sql.includes('JOIN cyberlab_artifacts')) {
    const job = jobsDb.get(String(params[0]));
    const artifact = job ? artifactsDb.get(job.target_ref ?? '') : undefined;
    return artifact ? { rows: [{ storage_path: artifact.storage_path }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.includes('FROM cyberlab_artifacts')) {
    const row = artifactsDb.get(String(params[0]));
    return row ? { rows: [{ id: row.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.includes('INSERT INTO cyberlab_jobs') && sql.includes('WHERE (SELECT COUNT(*)')) {
    const running = [...jobsDb.values()].filter((j) => j.status === 'running').length;
    const max = Number(params[3]);
    if (running >= max) return { rows: [], rowCount: 0 };
    const row = makeJob({
      type: String(params[0]),
      status: 'running',
      target_ref: String(params[1]),
      started_by: (params[2] as string | null) ?? null,
      started_at: nowStamp(),
    });
    jobsDb.set(row.id, row);
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (sql.includes('INSERT INTO cyberlab_jobs')) {
    const row = makeJob({
      type: String(params[0]),
      status: 'queued',
      target_ref: String(params[1]),
      started_by: (params[2] as string | null) ?? null,
    });
    jobsDb.set(row.id, row);
    return { rows: [{ ...row }], rowCount: 1 };
  }
  if (sql.includes('UPDATE cyberlab_jobs SET cancel_requested')) {
    const job = jobsDb.get(String(params[0]));
    if (!job || job.status !== 'running') return { rows: [], rowCount: 0 };
    job.cancel_requested = true;
    return { rows: [{ id: job.id }], rowCount: 1 };
  }
  if (sql.includes("UPDATE cyberlab_jobs") && sql.includes("WHERE status = 'running'") && sql.includes('RETURNING id')) {
    // Boot recovery: every row stuck at `running` (orphaned by a crash) closes
    // as failed; the rows are returned so the audit loop can see them.
    const orphans = [...jobsDb.values()].filter((j) => j.status === 'running');
    for (const job of orphans) {
      job.status = 'failed';
      job.error = 'interrupted by server restart';
      job.finished_at = nowStamp();
    }
    return { rows: orphans.map((j) => ({ id: j.id })), rowCount: orphans.length };
  }
  if (sql.includes("UPDATE cyberlab_jobs SET status = 'cancelled'")) {
    const job = jobsDb.get(String(params[0]));
    if (!job || job.status !== 'queued') return { rows: [], rowCount: 0 };
    job.status = 'cancelled';
    job.finished_at = nowStamp();
    return { rows: [{ id: job.id }], rowCount: 1 };
  }
  if (sql.includes("UPDATE cyberlab_jobs SET status = 'running'")) {
    const job = jobsDb.get(String(params[0]));
    if (!job || job.status !== 'queued') return { rows: [], rowCount: 0 };
    job.status = 'running';
    job.started_at = nowStamp();
    return { rows: [{ id: job.id }], rowCount: 1 };
  }
  if (sql.includes('UPDATE cyberlab_jobs SET status = $2')) {
    const job = jobsDb.get(String(params[0]));
    if (!job || job.status !== 'running') return { rows: [], rowCount: 0 };
    job.status = String(params[1]);
    job.error = (params[2] as string | null) ?? null;
    job.result = params[3] ?? null;
    job.finished_at = nowStamp();
    return { rows: [{ id: job.id }], rowCount: 1 };
  }
  if (sql.includes("FROM cyberlab_jobs WHERE status = 'queued' ORDER BY")) {
    const oldest = [...jobsDb.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))[0];
    return oldest ? { rows: [{ id: oldest.id, type: oldest.type }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.includes("AS count FROM cyberlab_jobs WHERE status = 'running'")) {
    const count = [...jobsDb.values()].filter((j) => j.status === 'running').length;
    return { rows: [{ count }], rowCount: 1 };
  }
  if (sql.includes('AS total FROM cyberlab_jobs')) {
    const statusFilter = sql.includes('WHERE status = $1') ? String(params[0]) : null;
    const total = [...jobsDb.values()].filter((j) => (statusFilter ? j.status === statusFilter : true)).length;
    return { rows: [{ total }], rowCount: 1 };
  }
  if (sql.includes('FROM cyberlab_jobs') && sql.includes('ORDER BY created_at DESC')) {
    const statusFilter = sql.includes('WHERE status = $1') ? String(params[0]) : null;
    const rows = [...jobsDb.values()]
      .filter((j) => (statusFilter ? j.status === statusFilter : true))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('FROM cyberlab_jobs WHERE id = $1')) {
    const job = jobsDb.get(String(params[0]));
    return job ? { rows: [{ ...job }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
};

const record = (sql: string, params?: unknown[]) => {
  sqlCalls.push({ sql, params: params ?? [] });
  return respond(sql, params ?? []);
};

// ---- Slot-free gate: hold finalize's slot-freeing UPDATE response ----------
// The store side-effect (status flip) is applied immediately by record(), but
// the response is held until release(). That is exactly the disputed window:
// the slot is observably free while the runner has not yet promoted the older
// queued job — a POST /jobs issued here must still not take the slot (fix:
// finalize's UPDATE + promotion run inside one lock-held section).
type SlotFreeGate = { signalReached: () => void; release: Promise<void> };
let slotFreeGate: SlotFreeGate | null = null;

const armSlotFreeGate = (): { reached: Promise<void>; release: () => void } => {
  let signalReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  let releaseFn!: () => void;
  const releasePromise = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  slotFreeGate = { signalReached, release: releasePromise };
  return {
    reached,
    release: () => {
      slotFreeGate = null;
      releaseFn();
    },
  };
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
    const result = record(sql, params);
    const gate = slotFreeGate;
    if (gate && sql.includes('UPDATE cyberlab_jobs SET status = $2')) {
      gate.signalReached();
      return gate.release.then(() => result);
    }
    return Promise.resolve(result);
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
const { initDatabase } = require('../src/config/database') as {
  initDatabase: () => Promise<void>;
};
/* eslint-enable @typescript-eslint/no-var-requires */

// ---- Mocked adapter (require-cache), spawned through the current execFile --
type RunScript =
  | { kind: 'completed'; stdout?: string }
  | { kind: 'failed'; stderr?: string }
  | { kind: 'timeout' }
  | { kind: 'truncated'; stdout?: string }
  | { kind: 'await_kill' }
  | { kind: 'killed' }
  | { kind: 'manual' }
  | { kind: 'throw_cli' };

const runScripts: RunScript[] = [];
const pendingManual: Array<(raw: Partial<RawRun>) => void> = [];

// The provider probe refuses to spawn when the configured path holds nothing
// runnable — a missing engine is "not configured", not a failed probe — so
// the tests need a real file at the configured path.
const engineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberlab-engine-'));
const ENGINE_CLI = path.join(engineDir, 'seefast-cli.exe');
fs.writeFileSync(ENGINE_CLI, '#!/bin/sh\necho engine\n', { mode: 0o755 });

const completeNextManual = (raw: Partial<RawRun>): void => {
  const resolveRun = pendingManual.shift();
  assert.ok(resolveRun, 'no pending manual run to complete');
  resolveRun(raw);
};

async function mockRunOperation(type: JobType, artifactPath: string, _limits: SeefastLimits): Promise<RawRun> {
  const script = runScripts.shift() ?? ({ kind: 'completed' } as RunScript);
  if (script.kind === 'throw_cli') throw new Error('SEEFAST_CLI_NOT_CONFIGURED');
  return new Promise<RawRun>((resolve) => {
    const finish = (partial: Partial<RawRun>): void =>
      resolve({ exitCode: 0, signal: null, stdout: '', stderrTail: '', truncated: false, timedOut: false, durationMs: 3, ...partial });
    // Spawn through the *current* execFile so the runner's child-capture wrap
    // sees this child — cancelJob must SIGTERM the exact process in its Map.
    const child = (cpModule.execFile as typeof fakeExecFile)(process.env.SEEFAST_CLI || 'cli', [type, artifactPath], {}, undefined);
    if (script.kind === 'await_kill') {
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => finish({ exitCode: code, signal }));
      return;
    }
    if (script.kind === 'killed') {
      // The engine died on its own (OOM kill, segfault, external kill) — no
      // cancel_requested, so this must not be reported as a cancellation.
      setImmediate(() => finish({ exitCode: null, signal: 'SIGKILL' }));
      return;
    }
    if (script.kind === 'manual') {
      pendingManual.push((raw) => finish(raw));
      return;
    }
    if (script.kind === 'failed') {
      setImmediate(() => finish({ exitCode: 1, stderrTail: script.stderr ?? 'engine exploded' }));
      return;
    }
    if (script.kind === 'timeout') {
      setImmediate(() => finish({ exitCode: null, signal: 'SIGTERM', timedOut: true }));
      return;
    }
    if (script.kind === 'truncated') {
      setImmediate(() => finish({ exitCode: null, truncated: true, stdout: script.stdout ?? 'partial-output' }));
      return;
    }
    setImmediate(() => finish({ exitCode: 0, stdout: script.stdout ?? '{"status":"ok"}' }));
  });
}

const adapterPath = require.resolve('../src/services/seefast/adapter');
const realAdapter = require(adapterPath) as { JOB_OPS: unknown };
require.cache[adapterPath]!.exports = { ...realAdapter, runOperation: mockRunOperation };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function main(): Promise<void> {
  await initDatabase();
  const { default: cyberlabRouter } = (await import('../src/routes/cyberlab')) as {
    default: import('express').Router;
  };
  const { authenticate } = await import('../src/middleware/auth');
  const { recoverInterruptedJobs } = await import('../src/services/seefast/jobsRunner');
  const { invalidateLimitsCache } = await import('../src/services/seefast/limits');

  const app = express();
  app.use('/api/cyberlab', authenticate, express.json({ limit: '40mb' }));
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/cyberlab', cyberlabRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/cyberlab`;

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

  const manageToken = sessionToken('user-manager', 'role-manager', ['cyberlab.manage', 'cyberlab.view']);
  const viewToken = sessionToken('user-viewer', 'role-viewer', ['cyberlab.view']);
  const noPermToken = sessionToken('user-none', 'role-none', ['devices.view']);

  const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  const postJob = (token: string, type: string, artifactId: string) =>
    fetch(`${base}/jobs`, { method: 'POST', headers: auth(token), body: JSON.stringify({ type, artifactId }) });
  const getJob = (token: string, id: string) => fetch(`${base}/jobs/${id}`, { headers: auth(token) });
  const cancelRoute = (token: string, id: string) =>
    fetch(`${base}/jobs/${id}/cancel`, { method: 'POST', headers: auth(token) });
  const putConfig = (token: string, body: Record<string, unknown>) =>
    fetch(`${base}/config`, { method: 'PUT', headers: auth(token), body: JSON.stringify(body) });

  let artifactSeq = 0;
  const seedArtifact = (): string => {
    const id = `10000000-0000-4000-8000-${String(++artifactSeq).padStart(12, '0')}`;
    artifactsDb.set(id, { id, storage_path: path.join(storageDir, `${id}.js`) });
    return id;
  };

  const jobInserts = () => sqlCalls.filter((c) => c.sql.includes('INSERT INTO cyberlab_jobs'));
  const auditCount = (action: string) => audits.filter((a) => a.params[3] === action).length;
  const resetCounts = (): void => {
    audits.length = 0;
    sqlCalls.length = 0;
  };

  const readJob = async (id: string): Promise<Record<string, unknown>> => {
    const res = await getJob(manageToken, id);
    assert.strictEqual(res.status, 200, `get job ${id} expected 200, got ${res.status}`);
    const body = (await res.json()) as { data: { job: Record<string, unknown> } };
    return body.data.job;
  };

  const waitFor = async (label: string, predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await predicate()) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const waitForStatus = async (id: string, ...statuses: string[]): Promise<Record<string, unknown>> => {
    let job: Record<string, unknown> = {};
    await waitFor(`job ${id} in ${statuses.join('|')}`, async () => {
      job = await readJob(id);
      return statuses.includes(String(job.status));
    });
    return job;
  };

  try {
    // ---- RBAC: 403 on all four routes --------------------------------------
    await checkAsync('test_jobs_routes_enforce_rbac_403', async () => {
      const artifactId = seedArtifact();
      const cases = [
        await postJob(viewToken, 'js_analysis', artifactId),
        await fetch(`${base}/jobs`, { headers: auth(noPermToken) }),
        await fetch(`${base}/jobs/00000000-0000-4000-8000-000000000000`, { headers: auth(noPermToken) }),
        await cancelRoute(viewToken, '00000000-0000-4000-8000-000000000000'),
      ];
      for (const res of cases) {
        assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
        const body = (await res.json()) as { success: boolean; error: { code: string } };
        assert.strictEqual(body.success, false);
        assert.strictEqual(body.error.code, 'AUTH_PERMISSION_DENIED', JSON.stringify(body));
      }
    });

    // ---- Provider gate (controller ruling 1): no job INSERT when unusable --
    await checkAsync('test_post_job_without_provider_is_400_with_no_insert', async () => {
      resetCounts();
      delete process.env.SEEFAST_CLI;
      const res = await postJob(manageToken, 'js_analysis', seedArtifact());
      assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.success, false, JSON.stringify(body));
      assert.strictEqual(body.error.code, 'PROVIDER_NOT_CONFIGURED', JSON.stringify(body));
      assert.strictEqual(jobInserts().length, 0, 'provider gate must never INSERT a job');
    });

    await checkAsync('test_post_job_with_failing_probe_is_400_with_no_insert', async () => {
      resetCounts();
      process.env.SEEFAST_CLI = ENGINE_CLI;
      probeScript = { error: new Error('probe refused'), stdout: '', stderr: 'probe refused' };
      const res = await postJob(manageToken, 'js_analysis', seedArtifact());
      probeScript = { error: null, stdout: '{"version":"1.0.0"}', stderr: '' };
      assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
      const body = (await res.json()) as { error: { code: string } };
      assert.strictEqual(body.error.code, 'PROVIDER_NOT_CONFIGURED', JSON.stringify(body));
      assert.strictEqual(jobInserts().length, 0, 'failed probe must never INSERT a job');
    });

    // ---- Type / artifact validation -----------------------------------------
    await checkAsync('test_post_job_unsupported_type_is_400_with_no_insert', async () => {
      resetCounts();
      process.env.SEEFAST_CLI = ENGINE_CLI;
      const res = await postJob(manageToken, 'shell_exec', seedArtifact());
      assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
      const body = (await res.json()) as { error: { code: string } };
      assert.strictEqual(body.error.code, 'UNSUPPORTED_OPERATION', JSON.stringify(body));
      assert.strictEqual(jobInserts().length, 0, 'invalid type must never INSERT');
    });

    await checkAsync('test_post_job_missing_artifact_is_404_with_no_insert', async () => {
      resetCounts();
      const res = await postJob(manageToken, 'js_analysis', '99999999-9999-4999-8999-999999999999');
      assert.strictEqual(res.status, 404, `expected 404, got ${res.status}`);
      const body = (await res.json()) as { error: { code: string } };
      assert.strictEqual(body.error.code, 'ARTIFACT_NOT_FOUND', JSON.stringify(body));
      assert.strictEqual(jobInserts().length, 0, 'missing artifact must never INSERT');
    });

    // ---- Lifecycle: running → completed ------------------------------------
    await checkAsync('test_job_starts_running_and_completes_with_raw_result', async () => {
      resetCounts();
      runScripts.push({ kind: 'completed', stdout: '{"modules":3,"findings":[]}' });
      const artifactId = seedArtifact();
      const res = await postJob(manageToken, 'js_analysis', artifactId);
      assert.strictEqual(res.status, 201, `expected 201, got ${res.status}`);
      const body = (await res.json()) as {
        success: boolean;
        data: { job: Record<string, unknown>; started: boolean };
      };
      assert.strictEqual(body.success, true, JSON.stringify(body));
      const { job, started } = body.data;
      assert.strictEqual(started, true, 'first job with a free slot must start immediately');
      assert.strictEqual(job.status, 'running');
      assert.ok(UUID_RE.test(String(job.id)), `job id must be a uuid: ${job.id}`);
      assert.strictEqual(job.artifact_id, artifactId, 'job must reference the uploaded artifact');
      assert.ok(job.started_at, 'started_at must be set on the running insert');
      assert.ok(!JSON.stringify(body.data).includes('storage_path'), 'storage_path must never leak');

      const startedAudits = audits.filter((a) => a.params[3] === 'cyberlab.job_started');
      assert.strictEqual(startedAudits.length, 1, 'exactly one cyberlab.job_started audit on start');
      assert.strictEqual(startedAudits[0].params[5], job.id, 'audit target_id must be the job id');

      const finished = await waitForStatus(String(job.id), 'completed');
      assert.strictEqual(finished.status, 'completed');
      // Task 5: completed results are normalised — result carries the summary,
      // no longer the raw parsed stdout (findings live in cyberlab_findings).
      assert.ok(
        finished.result !== null && typeof (finished.result as { summary?: unknown }).summary === 'string',
        `completed result must carry the normalised summary, got ${JSON.stringify(finished.result)}`
      );
      assert.strictEqual(finished.error, null, 'completed job carries no error');
      assert.ok(finished.finished_at, 'finished_at must be set');
    });

    // ---- Concurrency 1 FIFO: 2nd queues, promotion on completion -----------
    await checkAsync('test_concurrency_one_second_job_queues_and_promotes_fifo', async () => {
      resetCounts();
      runScripts.push({ kind: 'manual' }, { kind: 'manual' });
      const artifactId = seedArtifact();

      const first = await postJob(manageToken, 'go_binary', artifactId);
      const firstBody = (await first.json()) as { data: { job: Record<string, unknown>; started: boolean } };
      assert.strictEqual(first.status, 201);
      assert.strictEqual(firstBody.data.started, true);
      assert.strictEqual(firstBody.data.job.status, 'running');

      const second = await postJob(manageToken, 'rust_binary', artifactId);
      const secondBody = (await second.json()) as { data: { job: Record<string, unknown>; started: boolean } };
      assert.strictEqual(second.status, 201);
      assert.strictEqual(secondBody.data.started, false, 'second job must not start while a slot is taken');
      assert.strictEqual(secondBody.data.job.status, 'queued');

      completeNextManual({ exitCode: 0, stdout: '{"first":true}' });
      const firstDone = await waitForStatus(String(firstBody.data.job.id), 'completed');
      assert.strictEqual(firstDone.status, 'completed');

      const promoted = await waitForStatus(String(secondBody.data.job.id), 'running', 'completed');
      assert.strictEqual(promoted.status, 'running', 'oldest queued job must be promoted to running on completion');
      assert.ok(promoted.started_at, 'promoted job must carry started_at');

      completeNextManual({ exitCode: 0, stdout: '{"second":true}' });
      const secondDone = await waitForStatus(String(secondBody.data.job.id), 'completed');
      // Task 5: completed results are normalised — result carries the summary.
      assert.ok(
        secondDone.result !== null && typeof (secondDone.result as { summary?: unknown }).summary === 'string',
        `completed result must carry the normalised summary, got ${JSON.stringify(secondDone.result)}`
      );
      assert.strictEqual(auditCount('cyberlab.job_started'), 2, 'job_started audited for the start and the promotion');
    });

    // ---- Review Focus 2: truly simultaneous starts must still split 1+1 ---
    await checkAsync('test_two_simultaneous_starts_yield_one_running_one_queued', async () => {
      resetCounts();
      runScripts.push({ kind: 'manual' }, { kind: 'manual' });
      const artifactId = seedArtifact();

      const [resA, resB] = await Promise.all([
        postJob(manageToken, 'js_analysis', artifactId),
        postJob(manageToken, 'go_binary', artifactId),
      ]);
      assert.strictEqual(resA.status, 201, `expected 201, got ${resA.status}`);
      assert.strictEqual(resB.status, 201, `expected 201, got ${resB.status}`);
      const bodyA = (await resA.json()) as { data: { job: Record<string, unknown>; started: boolean } };
      const bodyB = (await resB.json()) as { data: { job: Record<string, unknown>; started: boolean } };

      const outcomes = [bodyA, bodyB].map((b) => ({ started: b.data.started, status: b.data.job.status }));
      assert.ok(
        outcomes.filter((o) => o.started && o.status === 'running').length === 1 &&
          outcomes.filter((o) => !o.started && o.status === 'queued').length === 1,
        `2 simultaneous starts must split 1 running + 1 queued, got ${JSON.stringify(outcomes)}`
      );

      const startedJob = bodyA.data.started ? bodyA.data.job : bodyB.data.job;
      const queuedJob = bodyA.data.started ? bodyB.data.job : bodyA.data.job;

      await waitFor('started job to reach runOperation', async () => pendingManual.length === 1);
      completeNextManual({ exitCode: 0, stdout: '{"first":true}' });
      const promoted = await waitForStatus(String(queuedJob.id), 'running', 'completed');
      assert.notStrictEqual(promoted.status, 'queued', 'the queued twin must be promoted once the slot frees');
      await waitFor('promoted job to reach runOperation', async () => pendingManual.length === 1);
      completeNextManual({ exitCode: 0, stdout: '{"second":true}' });
      await waitForStatus(String(startedJob.id), 'completed');
      await waitForStatus(String(queuedJob.id), 'completed');
      assert.strictEqual(auditCount('cyberlab.job_started'), 2, 'start + promotion both audited');
    });

    // ---- Cancel running: SIGTERM to the exact child, close decides ---------
    await checkAsync('test_cancel_running_sigterms_child_and_finalises_cancelled', async () => {
      resetCounts();
      runScripts.push({ kind: 'await_kill' });
      const artifactId = seedArtifact();
      const childrenBefore = fakeChildren.length;
      const created = await postJob(manageToken, 'js_analysis', artifactId);
      const createdBody = (await created.json()) as { data: { job: Record<string, unknown> } };
      const jobId = String(createdBody.data.job.id);
      await waitForStatus(jobId, 'running');
      await waitFor('runOperation to spawn the child', async () => fakeChildren.length > childrenBefore);

      const res = await cancelRoute(manageToken, jobId);
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const body = (await res.json()) as { success: boolean; data: { status: string } };
      assert.strictEqual(body.data.status, 'cancelled', JSON.stringify(body));

      await waitFor('kill spy to record SIGTERM', async () =>
        fakeChildren.slice(childrenBefore).some((c) => c.killCalls.length > 0));
      const child = fakeChildren[fakeChildren.length - 1];
      assert.deepStrictEqual(child.killCalls, ['SIGTERM'], 'cancel must SIGTERM the exact ChildProcess from the Map');

      const cancelled = await waitForStatus(jobId, 'cancelled');
      assert.strictEqual(cancelled.status, 'cancelled');
      assert.strictEqual(cancelled.error, null);
      assert.ok(cancelled.finished_at, 'cancelled job must be finished');
      assert.strictEqual(auditCount('cyberlab.job_cancelled'), 1, 'exactly one cyberlab.job_cancelled audit on the transition');
      assert.deepStrictEqual(fs.readdirSync(storageDir), [], 'cancel must leave no temp files behind (ruling 3)');
    });

    // ---- Cancel queued: direct transition, no kill -------------------------
    await checkAsync('test_cancel_queued_cancels_directly_without_kill', async () => {
      resetCounts();
      runScripts.push({ kind: 'manual' }, { kind: 'manual' });
      const artifactId = seedArtifact();
      const runningBody = (await (await postJob(manageToken, 'js_analysis', artifactId)).json()) as {
        data: { job: Record<string, unknown> };
      };
      const queuedBody = (await (await postJob(manageToken, 'js_analysis', artifactId)).json()) as {
        data: { job: Record<string, unknown> };
      };
      assert.strictEqual(queuedBody.data.job.status, 'queued');
      // Wait until the running job actually reached runOperation: only then is
      // its child spawned, so any NEW child after this point would be the
      // queued job executing — which it must never do.
      await waitFor('running job to reach runOperation', async () => pendingManual.length === 1);
      const childrenBefore = fakeChildren.length;

      const res = await cancelRoute(manageToken, String(queuedBody.data.job.id));
      assert.strictEqual(res.status, 200);
      const body = (await res.json()) as { data: { status: string } };
      assert.strictEqual(body.data.status, 'cancelled');

      const cancelled = await readJob(String(queuedBody.data.job.id));
      assert.strictEqual(cancelled.status, 'cancelled', 'queued job must cancel directly');
      assert.ok(cancelled.finished_at);
      assert.strictEqual(fakeChildren.length, childrenBefore, 'cancelling a queued job must not spawn/kill anything');
      assert.strictEqual(auditCount('cyberlab.job_cancelled'), 1, 'one audit for the queued transition');
      assert.strictEqual(pendingManual.length, 1, 'the queued job must never have started executing');
      assert.strictEqual(runScripts.length, 1, 'the queued job must not have consumed its run script');
      runScripts.pop(); // drop the cancelled job's unused script so later tests stay aligned

      completeNextManual({ exitCode: 0, stdout: '{"ok":true}' });
      await waitForStatus(String(runningBody.data.job.id), 'completed');
    });

    // ---- Cancel finished / unknown ------------------------------------------
    await checkAsync('test_cancel_finished_job_is_409_and_unknown_is_404', async () => {
      runScripts.push({ kind: 'completed' });
      const artifactId = seedArtifact();
      const body = (await (await postJob(manageToken, 'js_analysis', artifactId)).json()) as {
        data: { job: Record<string, unknown> };
      };
      const jobId = String(body.data.job.id);
      await waitForStatus(jobId, 'completed');

      const finished = await cancelRoute(manageToken, jobId);
      assert.strictEqual(finished.status, 409, `expected 409, got ${finished.status}`);
      const finishedBody = (await finished.json()) as { error: { code: string } };
      assert.strictEqual(finishedBody.error.code, 'ALREADY_FINISHED', JSON.stringify(finishedBody));

      const missing = await cancelRoute(manageToken, '99999999-9999-4999-8999-999999999999');
      assert.strictEqual(missing.status, 404, `expected 404, got ${missing.status}`);
      const missingBody = (await missing.json()) as { error: { code: string } };
      assert.strictEqual(missingBody.error.code, 'JOB_NOT_FOUND', JSON.stringify(missingBody));
    });

    // ---- Timeout / truncated / failure sanitisation -------------------------
    await checkAsync('test_timeout_marks_failed_with_timeout_error', async () => {
      runScripts.push({ kind: 'timeout' });
      const body = (await (await postJob(manageToken, 'js_analysis', seedArtifact())).json()) as {
        data: { job: Record<string, unknown> };
      };
      const job = await waitForStatus(String(body.data.job.id), 'failed');
      assert.strictEqual(job.status, 'failed');
      assert.strictEqual(job.error, 'TIMEOUT', `timeout must store error TIMEOUT, got ${JSON.stringify(job.error)}`);
    });

    await checkAsync('test_truncated_run_marks_partial', async () => {
      runScripts.push({ kind: 'truncated' });
      const body = (await (await postJob(manageToken, 'go_binary', seedArtifact())).json()) as {
        data: { job: Record<string, unknown> };
      };
      const job = await waitForStatus(String(body.data.job.id), 'partial');
      assert.strictEqual(job.status, 'partial');
      assert.deepStrictEqual(job.result, { truncated: true }, 'partial result must carry truncated=true');
    });

    // A signal with no cancel_requested is an unexpected death (OOM kill,
    // segfault, external kill) — reporting it as `cancelled` would blame the
    // operator for a crash they did not cause. A genuine cancel sets the flag
    // first and still wins (covered by the cancel test above).
    await checkAsync('test_unexpected_signal_marks_failed_not_cancelled', async () => {
      runScripts.push({ kind: 'killed' });
      const body = (await (await postJob(manageToken, 'js_analysis', seedArtifact())).json()) as {
        data: { job: Record<string, unknown> };
      };
      const job = await waitForStatus(String(body.data.job.id), 'failed');
      assert.strictEqual(job.status, 'failed', 'an unexpected signal must not be reported as cancelled');
      assert.strictEqual(
        job.error,
        'engine terminated by signal SIGKILL',
        `the error must name the signal, got ${JSON.stringify(job.error)}`
      );
    });

    await checkAsync('test_failed_run_error_is_sanitised_and_capped', async () => {
      const cli = ENGINE_CLI;
      process.env.SEEFAST_CLI = cli;
      const artifactId = seedArtifact();
      const storagePath = artifactsDb.get(artifactId)!.storage_path;
      const leaky = `engine failed at ${cli} while reading ${storagePath}: ${'x'.repeat(700)}`;
      runScripts.push({ kind: 'failed', stderr: leaky });
      const body = (await (await postJob(manageToken, 'js_analysis', artifactId)).json()) as {
        data: { job: Record<string, unknown> };
      };
      const job = await waitForStatus(String(body.data.job.id), 'failed');
      const error = String(job.error);
      assert.ok(error.length <= 500, `error must be ≤500 chars, got ${error.length}`);
      assert.ok(!error.includes(cli), `error must not leak the engine path: ${error.slice(0, 120)}`);
      assert.ok(!error.includes(storagePath), `error must not leak the storage path: ${error.slice(0, 120)}`);
      assert.ok(error.includes('SEEFAST_CLI'), 'engine path must be redacted to SEEFAST_CLI');
    });

    await checkAsync('test_adapter_not_configured_maps_to_failed_not_raw_throw', async () => {
      runScripts.push({ kind: 'throw_cli' });
      const body = (await (await postJob(manageToken, 'js_analysis', seedArtifact())).json()) as {
        data: { job: Record<string, unknown> };
      };
      const job = await waitForStatus(String(body.data.job.id), 'failed');
      assert.strictEqual(job.status, 'failed');
      assert.strictEqual(job.error, 'SEEFAST_CLI_NOT_CONFIGURED', 'defensive mapping must sanitise the adapter throw');
    });

    // ---- List route ---------------------------------------------------------
    await checkAsync('test_job_list_filters_by_status_and_returns_total', async () => {
      const all = await fetch(`${base}/jobs?limit=100`, { headers: auth(viewToken) });
      assert.strictEqual(all.status, 200, `expected 200, got ${all.status}`);
      const allBody = (await all.json()) as { data: { jobs: Record<string, unknown>[]; total: number } };
      assert.ok(allBody.data.jobs.length >= 6, `expected the accumulated jobs, got ${allBody.data.jobs.length}`);
      assert.strictEqual(allBody.data.total, allBody.data.jobs.length, 'total must match the unfiltered row count');

      const failedOnly = await fetch(`${base}/jobs?status=failed&limit=100`, { headers: auth(viewToken) });
      const failedBody = (await failedOnly.json()) as { data: { jobs: Record<string, unknown>[]; total: number } };
      assert.ok(failedBody.data.jobs.length >= 2, 'there must be failed jobs from earlier tests');
      assert.ok(
        failedBody.data.jobs.every((j) => j.status === 'failed'),
        'status filter must return only failed jobs'
      );
      assert.strictEqual(failedBody.data.total, failedBody.data.jobs.length);

      const bad = await fetch(`${base}/jobs?status=exploded`, { headers: auth(viewToken) });
      assert.strictEqual(bad.status, 400, `invalid status must be 400, got ${bad.status}`);
    });

    // ---- Regression: queue-steal race between finalize and promotion -------
    // The fake holds finalize's slot-freeing UPDATE *response* (store already
    // flipped) — the exact window where a count-based POST could take the
    // freed slot from an older queued job. Deterministic core: once released,
    // the older queued B must own the slot and the new POST must be queued.
    await checkAsync('test_slot_freed_by_completion_is_promoted_before_a_new_post', async () => {
      resetCounts();
      runScripts.push({ kind: 'manual' }, { kind: 'manual' }, { kind: 'manual' }); // A, B, new POST
      const artifactId = seedArtifact();

      const jobOf = (payload: { data: { job: Record<string, unknown>; started: boolean } }): Record<string, unknown> =>
        payload.data.job;

      const a = jobOf((await (await postJob(manageToken, 'js_analysis', artifactId)).json()) as {
        data: { job: Record<string, unknown>; started: boolean };
      });
      const b = jobOf((await (await postJob(manageToken, 'js_analysis', artifactId)).json()) as {
        data: { job: Record<string, unknown>; started: boolean };
      });
      assert.strictEqual(a.status, 'running');
      assert.strictEqual(b.status, 'queued');
      await waitFor('A to reach runOperation', async () => pendingManual.length === 1);

      const gate = armSlotFreeGate();
      try {
        // A completes: finalize flips the status (slot freed in the store) but
        // its response is held — the promotion has not run yet.
        completeNextManual({ exitCode: 0, stdout: '{"done":true}' });
        await gate.reached;

        // A new POST lands inside that window.
        const dPromise = postJob(manageToken, 'go_binary', artifactId);
        await sleep(150); // let the POST advance as far as it can
        gate.release();

        const dRes = await dPromise;
        assert.strictEqual(dRes.status, 201, `expected 201, got ${dRes.status}`);
        const dBody = (await dRes.json()) as { data: { job: Record<string, unknown>; started: boolean } };
        assert.strictEqual(
          dBody.data.started,
          false,
          'the freed slot must go to the older queued job — a new POST must not steal it'
        );

        const bNow = await readJob(String(b.id));
        assert.ok(
          bNow.status === 'running' || bNow.status === 'completed',
          `older queued job must get the freed slot, got ${bNow.status}`
        );
        assert.strictEqual((await readJob(String(dBody.data.job.id))).status, 'queued', 'the new POST must queue');

        // Cleanup: B holds the slot (manual) — finish B, then D promotes and finishes.
        await waitFor('B to reach runOperation', async () => pendingManual.length === 1);
        completeNextManual({ exitCode: 0, stdout: '{"b":true}' });
        await waitForStatus(String(b.id), 'completed');
        await waitFor('new POST job to reach runOperation', async () => pendingManual.length === 1);
        completeNextManual({ exitCode: 0, stdout: '{"d":true}' });
        await waitForStatus(String(dBody.data.job.id), 'completed');
      } finally {
        gate.release(); // idempotent: never leave finalize (or later tests) hung
      }
    });

    await checkAsync('test_boot_recovery_fails_orphaned_running_and_promotes_queue', async () => {
      resetCounts();
      // Simulate a restart: two rows left at `running` with no ChildProcess
      // behind them, plus one `queued` job waiting on the slot they held.
      const orphanA = makeJob({ type: 'js_analysis', status: 'running', target_ref: seedArtifact(), started_at: nowStamp() });
      const orphanB = makeJob({ type: 'js_analysis', status: 'running', target_ref: seedArtifact(), started_at: nowStamp() });
      const waiting = makeJob({ type: 'js_analysis', status: 'queued', target_ref: seedArtifact() });
      jobsDb.set(orphanA.id, orphanA);
      jobsDb.set(orphanB.id, orphanB);
      jobsDb.set(waiting.id, waiting);
      runScripts.push({ kind: 'manual' });

      const recovered = await recoverInterruptedJobs();
      assert.strictEqual(recovered, 2, 'exactly the two orphaned running rows must be recovered');

      for (const orphan of [orphanA, orphanB]) {
        const row = await readJob(orphan.id);
        assert.strictEqual(row.status, 'failed', 'an orphaned running row must close as failed');
        assert.strictEqual(row.error, 'interrupted by server restart', 'honest operator-facing reason');
        assert.ok(row.finished_at, 'a recovered job must be finished');
      }
      assert.ok(
        audits.some((a) => a.sql.includes('INSERT INTO audit_logs') && String(a.params[3]) === 'cyberlab.job_interrupted'),
        'recovery must be audited'
      );

      // The queue must not stay wedged: the waiting job takes the freed slot.
      await waitFor('queued job promoted and reached runOperation', async () => pendingManual.length === 1);
      assert.strictEqual((await readJob(waiting.id)).status, 'running', 'queued job must run once orphans release the slots');
      completeNextManual({ exitCode: 0, stdout: '{"after_restart":true}' });
      await waitForStatus(waiting.id, 'completed');
    });

    // A crash can also leave `queued` jobs with NO orphan at all (the window
    // between finalize's slot-freeing UPDATE and its promotion). The drain
    // must happen anyway — otherwise a later POST would jump the FIFO queue.
    await checkAsync('test_boot_recovery_drains_queue_even_without_orphans', async () => {
      resetCounts();
      const waiting = makeJob({ type: 'js_analysis', status: 'queued', target_ref: seedArtifact() });
      jobsDb.set(waiting.id, waiting);
      runScripts.push({ kind: 'manual' });

      const recovered = await recoverInterruptedJobs();
      assert.strictEqual(recovered, 0, 'there was no orphaned running row to recover');

      await waitFor('queued job promoted without an orphan', async () => pendingManual.length === 1);
      assert.strictEqual((await readJob(waiting.id)).status, 'running', 'the queue must be drained even with zero orphans');
      completeNextManual({ exitCode: 0, stdout: '{"no_orphans":true}' });
      await waitForStatus(waiting.id, 'completed');
    });

    await checkAsync('test_put_config_raising_concurrency_promotes_the_queue', async () => {
      resetCounts();
      runScripts.push({ kind: 'manual' }, { kind: 'manual' });

      const artifactId = seedArtifact();
      const bodyOf = (res: Response) => res.json() as Promise<{ data: { job: { id: string; status: string }; started: boolean } }>;

      const a = (await bodyOf(await postJob(manageToken, 'js_analysis', artifactId))).data;
      const b = (await bodyOf(await postJob(manageToken, 'js_analysis', artifactId))).data;
      assert.strictEqual(a.job.status, 'running', 'concurrency 1 must start the first job');
      assert.strictEqual(b.job.status, 'queued', 'concurrency 1 must queue the second job');
      await waitFor('job A to reach runOperation', async () => pendingManual.length === 1);

      // Raising concurrency is the documented external event promoteQueued
      // exists for: the queued job must start without waiting for A to finish.
      const putRes = await putConfig(manageToken, { maxConcurrent: 2 });
      assert.strictEqual(putRes.status, 200, `expected 200, got ${putRes.status}`);

      await waitFor('queued job B to be promoted', async () => pendingManual.length === 2);
      assert.strictEqual((await readJob(b.job.id)).status, 'running', 'raising concurrency must drain the queue immediately');

      completeNextManual({ exitCode: 0, stdout: '{"a":true}' });
      completeNextManual({ exitCode: 0, stdout: '{"b":true}' });
      await waitForStatus(a.job.id, 'completed');
      await waitForStatus(b.job.id, 'completed');

      // The new concurrency must not leak into later suites' expectations.
      settingsDb.delete('cyberlab_max_concurrent');
      invalidateLimitsCache();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(storageDir, { recursive: true, force: true });
    delete process.env.CYBERLAB_STORAGE_DIR;
    delete process.env.SEEFAST_CLI;
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

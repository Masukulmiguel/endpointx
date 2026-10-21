/**
 * RED->GREEN gate for Task 5 — normalize + findings persistence + routes.
 *
 * Design notes: same harness as tests/cyberlabJobs.test.ts — stubbed pg.Pool
 * in require.cache backed by in-memory jobs/artifacts/findings stores, and the
 * adapter replaced via require-cache with a scripted runOperation that still
 * spawns through the current execFile (so the runner's child-capture path is
 * exercised). The synthetic fixture tests/fixtures/seefast/js_evidence.json
 * is hand-written (Task 8 will replace/augment it with a genuine engine
 * capture): it carries the plausible JS-analysis shape the normalizer parses
 * (module/IPC/native-addon counts + output limitations).
 * Run: npx tsx tests/cyberlabFindings.test.ts
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
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberlab-findings-'));
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

// ---- Fake pg: in-memory cyberlab_jobs / artifacts / findings --------------
type JobRecord = {
  id: string;
  type: string;
  status: string;
  target_ref: string | null;
  result: unknown;
  error: string | null;
  progress: number;
  cancel_requested: boolean;
  started_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type FindingRecord = {
  id: string;
  job_id: string;
  kind: string;
  title: string;
  severity: string | null;
  confidence: string | null;
  evidence: unknown;
  asset_ref: string | null;
  status: string;
};

const jobsDb = new Map<string, JobRecord>();
const artifactsDb = new Map<string, { id: string; storage_path: string }>();
const findingsDb = new Map<string, FindingRecord>();
const audits: Array<{ sql: string; params: unknown[] }> = [];
const sqlCalls: Array<{ sql: string; params: unknown[] }> = [];
let jobSeq = 0;
let findingSeq = 0;

const nowStamp = (): string => new Date(Date.UTC(2026, 0, 1) + jobSeq++).toISOString();

const makeJob = (partial: Partial<JobRecord> & Pick<JobRecord, 'type' | 'status' | 'target_ref'>): JobRecord => ({
  id: `00000000-0000-4000-8000-${String(jobSeq).padStart(12, '0')}`,
  result: null,
  error: null,
  progress: 0,
  cancel_requested: false,
  started_by: null,
  created_at: nowStamp(),
  started_at: null,
  finished_at: null,
  ...partial,
});

const findingsOfJob = (jobId: string): FindingRecord[] =>
  [...findingsDb.values()].filter((f) => f.job_id === jobId);

const rolePermissions = new Map<string, Record<string, unknown>[]>();
const setRolePermissions = (roleId: string, codes: string[]): void => {
  rolePermissions.set(roleId, codes.map((code) => ({ code })));
};

// Reproduce a `col = $n` filter from the SQL text so the fake list/count
// handlers honour whatever WHERE the route built.
const paramIndexFor = (sql: string, column: string): number | null => {
  const match = sql.match(new RegExp(`${column} = \\$(\\d+)`));
  return match ? Number(match[1]) - 1 : null;
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
    return { rows: [], rowCount: 0 }; // limits resolve to defaults (maxConcurrentJobs: 1)
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
  if (sql.includes('INSERT INTO cyberlab_findings')) {
    const row: FindingRecord = {
      id: `30000000-0000-4000-8000-${String(++findingSeq).padStart(12, '0')}`,
      job_id: String(params[0]),
      kind: String(params[1]),
      title: String(params[2]),
      severity: (params[3] as string | null) ?? null,
      confidence: (params[4] as string | null) ?? null,
      evidence: params[5] ?? null,
      asset_ref: null,
      status: 'open',
    };
    findingsDb.set(row.id, row);
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes("UPDATE cyberlab_findings SET status = 'acknowledged'")) {
    const finding = findingsDb.get(String(params[0]));
    if (!finding || finding.status !== 'open') return { rows: [], rowCount: 0 };
    finding.status = 'acknowledged';
    return { rows: [{ id: finding.id }], rowCount: 1 };
  }
  if (sql.includes('AS total FROM cyberlab_findings')) {
    const jobIdx = paramIndexFor(sql, 'job_id');
    const kindIdx = paramIndexFor(sql, 'kind');
    const severityIdx = paramIndexFor(sql, 'severity');
    const statusIdx = paramIndexFor(sql, 'status');
    const total = [...findingsDb.values()].filter(
      (f) =>
        (jobIdx === null || f.job_id === params[jobIdx]) &&
        (kindIdx === null || f.kind === params[kindIdx]) &&
        (severityIdx === null || f.severity === params[severityIdx]) &&
        (statusIdx === null || f.status === params[statusIdx])
    ).length;
    return { rows: [{ total }], rowCount: 1 };
  }
  if (sql.includes('FROM cyberlab_findings')) {
    const jobIdx = paramIndexFor(sql, 'job_id');
    const kindIdx = paramIndexFor(sql, 'kind');
    const severityIdx = paramIndexFor(sql, 'severity');
    const statusIdx = paramIndexFor(sql, 'status');
    const rows = [...findingsDb.values()]
      .filter(
        (f) =>
          (jobIdx === null || f.job_id === params[jobIdx]) &&
          (kindIdx === null || f.kind === params[kindIdx]) &&
          (severityIdx === null || f.severity === params[severityIdx]) &&
          (statusIdx === null || f.status === params[statusIdx])
      )
      .sort((a, b) => (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : a.id < b.id ? -1 : 1))
      .map(({ id, job_id, kind, title, severity, confidence, evidence, asset_ref, status }) => ({
        id,
        job_id,
        kind,
        title,
        severity,
        confidence,
        evidence,
        asset_ref,
        status,
      }));
    return { rows, rowCount: rows.length };
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
const { initDatabase } = require('../src/config/database') as {
  initDatabase: () => Promise<void>;
};
/* eslint-enable @typescript-eslint/no-var-requires */

// ---- Mocked adapter (require-cache), spawned through the current execFile --
type RunScript = { kind: 'completed'; stdout: string } | { kind: 'truncated' };

const runScripts: RunScript[] = [];

async function mockRunOperation(type: JobType, artifactPath: string, _limits: SeefastLimits): Promise<RawRun> {
  const script = runScripts.shift() ?? ({ kind: 'completed', stdout: '{"status":"ok"}' } as RunScript);
  return new Promise<RawRun>((resolve) => {
    const finish = (partial: Partial<RawRun>): void =>
      resolve({ exitCode: 0, signal: null, stdout: '', stderrTail: '', truncated: false, timedOut: false, durationMs: 3, ...partial });
    // Spawn through the *current* execFile so the runner's child-capture wrap
    // sees this child — same contract as the Task 4 harness.
    (cpModule.execFile as typeof fakeExecFile)(process.env.SEEFAST_CLI || 'cli', [type, artifactPath], {}, undefined);
    if (script.kind === 'truncated') {
      setImmediate(() => finish({ exitCode: null, truncated: true, stdout: 'partial-output' }));
      return;
    }
    setImmediate(() => finish({ exitCode: 0, stdout: script.stdout }));
  });
}

const adapterPath = require.resolve('../src/services/seefast/adapter');
const realAdapter = require(adapterPath) as { JOB_OPS: unknown };
require.cache[adapterPath]!.exports = { ...realAdapter, runOperation: mockRunOperation };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATIC_PHRASE = 'análise estática; sem execução';

async function main(): Promise<void> {
  await initDatabase();
  const { default: cyberlabRouter } = (await import('../src/routes/cyberlab')) as {
    default: import('express').Router;
  };
  const { authenticate } = await import('../src/middleware/auth');

  const app = express();
  app.use('/api/cyberlab', authenticate, express.json({ limit: '40mb' }));
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/cyberlab', cyberlabRouter);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}/api/cyberlab`;

  // The provider probe refuses to spawn when the configured path holds
  // nothing runnable — a missing engine is "not configured", not a failed
  // probe — so the tests need a real file at the configured path.
  const engineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberlab-engine-'));
  const ENGINE_CLI = path.join(engineDir, 'seefast-cli.exe');
  fs.writeFileSync(ENGINE_CLI, '#!/bin/sh\necho engine\n', { mode: 0o755 });
  process.env.SEEFAST_CLI = ENGINE_CLI;

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

  let artifactSeq = 0;
  const seedArtifact = (): string => {
    const id = `10000000-0000-4000-8000-${String(++artifactSeq).padStart(12, '0')}`;
    artifactsDb.set(id, { id, storage_path: path.join(storageDir, `${id}.js`) });
    return id;
  };

  const auditCount = (action: string) => audits.filter((a) => a.params[3] === action).length;
  const resetCounts = (): void => {
    audits.length = 0;
    sqlCalls.length = 0;
  };

  const readJob = async (id: string): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}/jobs/${id}`, { headers: auth(manageToken) });
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

  const waitForStatus = async (id: string, ...statuses: string[]): Promise<Record<string, unknown>> => {
    let job: Record<string, unknown> = {};
    await waitFor(`job ${id} in ${statuses.join('|')}`, async () => {
      job = await readJob(id);
      return statuses.includes(String(job.status));
    });
    return job;
  };

  const runToTerm = async (type: JobType, script: RunScript): Promise<{ jobId: string; job: Record<string, unknown> }> => {
    runScripts.push(script);
    const created = (await (await postJob(manageToken, type, seedArtifact())).json()) as {
      data: { job: Record<string, unknown>; started: boolean };
    };
    assert.strictEqual(created.data.started, true, 'job must start immediately (free slot)');
    const jobId = String(created.data.job.id);
    const job = await waitForStatus(jobId, 'completed', 'partial', 'failed', 'cancelled');
    return { jobId, job };
  };

  try {
    // ---- RBAC: 403 on both findings routes ---------------------------------
    await checkAsync('test_findings_routes_enforce_rbac_403', async () => {
      const cases = [
        await fetch(`${base}/findings`, { headers: auth(noPermToken) }),
        await fetch(`${base}/findings/${'00000000-0000-4000-8000-000000000000'}/acknowledge`, {
          method: 'POST',
          headers: auth(viewToken),
        }),
      ];
      for (const res of cases) {
        assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
        const body = (await res.json()) as { success: boolean; error: { code: string } };
        assert.strictEqual(body.success, false);
        assert.strictEqual(body.error.code, 'AUTH_PERMISSION_DENIED', JSON.stringify(body));
      }
    });

    // ---- (a) fixture → findings with static limitations --------------------
    let fixtureJobId = '';
    await checkAsync('test_js_fixture_normalises_to_findings_with_static_limitations', async () => {
      const fixturePath = path.join(__dirname, 'fixtures', 'seefast', 'js_evidence.json');
      const fixtureStdout = fs.readFileSync(fixturePath, 'utf8');
      const { jobId, job } = await runToTerm('js_analysis', { kind: 'completed', stdout: fixtureStdout });
      fixtureJobId = jobId;

      assert.strictEqual(job.status, 'completed', `fixture job must complete, got ${job.status}`);
      const result = job.result as { summary?: unknown } | null;
      assert.ok(result && typeof result.summary === 'string' && result.summary.length > 0,
        `completed result must carry a non-empty summary, got ${JSON.stringify(job.result)}`);

      const findings = findingsOfJob(jobId);
      assert.ok(findings.length >= 1, `fixture must produce >=1 finding, got ${findings.length}`);

      const evidence = findings[0].evidence as {
        source: string;
        method: string;
        observed_at: string;
        limitations: string[];
        details: Record<string, unknown>;
      };
      for (const finding of findings) {
        assert.strictEqual(finding.kind, 'fact', `directly observed facts map to kind=fact, got ${finding.kind}`);
        assert.strictEqual(finding.confidence, 'high', `observed facts carry confidence=high, got ${finding.confidence}`);
        const ev = finding.evidence as typeof evidence;
        assert.ok(Array.isArray(ev.limitations), 'evidence.limitations must be an array');
        assert.ok(ev.limitations.includes(STATIC_PHRASE),
          `limitations must include "${STATIC_PHRASE}", got ${JSON.stringify(ev.limitations)}`);
        assert.strictEqual(ev.source, 'seefast:js_analysis', `evidence.source must be seefast:js_analysis, got ${ev.source}`);
        assert.strictEqual(ev.method, 'static:js_analysis', `evidence.method must be static:js_analysis, got ${ev.method}`);
        assert.ok(!Number.isNaN(Date.parse(ev.observed_at)), `observed_at must be ISO, got ${ev.observed_at}`);
        assert.ok(ev.details && typeof ev.details === 'object', 'evidence.details must carry the raw extracted facts');
      }
      // The fixture's own output limitation is preserved alongside the static phrase.
      assert.ok(evidence.limitations.some((l) => l.includes('cobertura parcial')),
        `output limitations must be merged, got ${JSON.stringify(evidence.limitations)}`);
    });

    // ---- (b) unparsable stdout → partial, zero findings --------------------
    await checkAsync('test_unparsable_stdout_downgrades_to_partial_with_zero_findings', async () => {
      const { jobId, job } = await runToTerm('js_analysis', { kind: 'completed', stdout: '{invalid' });
      assert.strictEqual(job.status, 'partial', `unparsable stdout must downgrade to partial, got ${job.status}`);
      const result = job.result as { note?: unknown } | null;
      assert.ok(result && typeof result.note === 'string' && result.note.length > 0,
        `partial result must carry a note, got ${JSON.stringify(job.result)}`);
      assert.strictEqual(findingsOfJob(jobId).length, 0, 'unparsable stdout must never invent findings');
    });

    // ---- (c) truncated run → partial, zero findings ------------------------
    await checkAsync('test_truncated_run_is_partial_with_zero_findings', async () => {
      const { jobId, job } = await runToTerm('go_binary', { kind: 'truncated' });
      assert.strictEqual(job.status, 'partial', `truncated run must be partial, got ${job.status}`);
      assert.deepStrictEqual(job.result, { truncated: true }, 'truncated path keeps result.truncated=true');
      assert.strictEqual(findingsOfJob(jobId).length, 0, 'truncated run must never invent findings');
    });

    // ---- (d) JSON without extractable fields → completed + summary, 0 ------
    await checkAsync('test_json_without_extractable_fields_completes_with_summary_and_zero_findings', async () => {
      const { jobId, job } = await runToTerm('rust_binary', { kind: 'completed', stdout: '{"status":"ok","detail":"nothing structured"}' });
      assert.strictEqual(job.status, 'completed', `bare JSON must still complete, got ${job.status}`);
      const result = job.result as { summary?: unknown } | null;
      assert.ok(result && typeof result.summary === 'string' && result.summary.length > 0,
        `completed-without-fields must still carry a summary, got ${JSON.stringify(job.result)}`);
      assert.strictEqual(findingsOfJob(jobId).length, 0, 'absent fields must yield zero findings (zero inference)');
    });

    // ---- (e) list filters by kind ------------------------------------------
    await checkAsync('test_findings_list_filters_by_kind_and_returns_total', async () => {
      const fixtureFindings = findingsOfJob(fixtureJobId);
      assert.ok(fixtureFindings.length >= 1, 'the fixture job must have findings from test (a)');

      // Seed one differently-kinded finding so the filter has something to exclude.
      const seededId = '20000000-0000-4000-8000-000000000001';
      findingsDb.set(seededId, {
        id: seededId,
        job_id: fixtureJobId,
        kind: 'recommendation',
        title: 'Seeded recommendation',
        severity: 'info',
        confidence: 'medium',
        evidence: { source: 'seefast:js_analysis', method: 'static:js_analysis', observed_at: new Date().toISOString(), limitations: [STATIC_PHRASE], details: {} },
        asset_ref: null,
        status: 'open',
      });

      const all = await fetch(`${base}/findings?limit=100`, { headers: auth(viewToken) });
      assert.strictEqual(all.status, 200, `expected 200, got ${all.status}`);
      const allBody = (await all.json()) as { success: boolean; data: { findings: Record<string, unknown>[]; total: number } };
      assert.strictEqual(allBody.success, true, JSON.stringify(allBody));
      assert.strictEqual(allBody.data.total, allBody.data.findings.length, 'total must match the returned row count');

      const facts = await fetch(`${base}/findings?kind=fact&limit=100`, { headers: auth(viewToken) });
      const factsBody = (await facts.json()) as { data: { findings: Record<string, unknown>[]; total: number } };
      assert.strictEqual(facts.status, 200);
      assert.ok(factsBody.data.findings.length >= 1, 'kind=fact must return the fixture findings');
      assert.ok(factsBody.data.findings.every((f) => f.kind === 'fact'), 'kind filter must return only facts');
      assert.strictEqual(factsBody.data.total, factsBody.data.findings.length);

      const recs = await fetch(`${base}/findings?kind=recommendation&limit=100`, { headers: auth(viewToken) });
      const recsBody = (await recs.json()) as { data: { findings: Record<string, unknown>[]; total: number } };
      assert.strictEqual(recsBody.data.findings.length, 1, 'kind=recommendation must return exactly the seeded row');
      assert.strictEqual(recsBody.data.total, 1);

      const bad = await fetch(`${base}/findings?kind=exploded`, { headers: auth(viewToken) });
      assert.strictEqual(bad.status, 400, `invalid kind must be 400, got ${bad.status}`);
    });

    // ---- (d) job_id filter: the JobDetail page depends on it ---------------
    await checkAsync('test_findings_list_filters_by_job_id_without_leaking_others', async () => {
      // A second job holding its own finding: an unfiltered newest-N batch
      // would have made the JobDetail page claim "no findings" for whichever
      // job was pushed out of the page.
      const otherJobId = '40000000-0000-4000-8000-000000000002';
      findingsDb.set('40000000-0000-4000-8000-000000000003', {
        id: '40000000-0000-4000-8000-000000000003',
        job_id: otherJobId,
        kind: 'indicator',
        title: 'Indicator belonging to another job',
        severity: 'low',
        confidence: 'medium',
        evidence: null,
        asset_ref: null,
        status: 'open',
      });

      const res = await fetch(`${base}/findings?job_id=${fixtureJobId}&limit=100`, { headers: auth(viewToken) });
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const body = (await res.json()) as { success: boolean; data: { findings: Record<string, unknown>[]; total: number } };
      assert.strictEqual(body.success, true, JSON.stringify(body));
      assert.ok(body.data.findings.length >= 1, 'the fixture job must still return its findings');
      assert.ok(
        body.data.findings.every((f) => f.job_id === fixtureJobId),
        "job_id filter must never return another job's findings"
      );
      assert.strictEqual(body.data.total, body.data.findings.length, 'total must count only the filtered job');
      assert.ok(
        body.data.findings.every((f) => f.job_id !== otherJobId),
        "the other job's finding must not leak into this job's page"
      );

      // Combined with an existing filter — JobDetail and the global list share
      // the same endpoint, so both dimensions must compose.
      const combined = await fetch(`${base}/findings?job_id=${fixtureJobId}&kind=fact&limit=100`, { headers: auth(viewToken) });
      const combinedBody = (await combined.json()) as { data: { findings: Record<string, unknown>[] } };
      assert.strictEqual(combined.status, 200);
      assert.ok(
        combinedBody.data.findings.every((f) => f.job_id === fixtureJobId && f.kind === 'fact'),
        'job_id and kind must compose'
      );

      const bad = await fetch(`${base}/findings?job_id=not-a-uuid`, { headers: auth(viewToken) });
      assert.strictEqual(bad.status, 400, `malformed job_id must be 400, got ${bad.status}`);
    });

    // ---- (e) acknowledge 200 → 404, audit only on success ------------------
    await checkAsync('test_acknowledge_is_200_then_404_with_audit_only_on_success', async () => {
      resetCounts();
      const target = findingsOfJob(fixtureJobId).find((f) => f.kind === 'fact');
      assert.ok(target, 'an open fact finding from test (a) is required');

      const first = await fetch(`${base}/findings/${target.id}/acknowledge`, { method: 'POST', headers: auth(manageToken) });
      assert.strictEqual(first.status, 200, `first acknowledge must be 200, got ${first.status}`);
      const firstBody = (await first.json()) as { success: boolean; data: { status: string } };
      assert.strictEqual(firstBody.success, true, JSON.stringify(firstBody));
      assert.strictEqual(firstBody.data.status, 'acknowledged', JSON.stringify(firstBody));
      assert.strictEqual(findingsDb.get(target.id)?.status, 'acknowledged', 'acknowledge must persist status');
      assert.strictEqual(auditCount('cyberlab.finding_acknowledged'), 1, 'exactly one audit on the 200');

      const second = await fetch(`${base}/findings/${target.id}/acknowledge`, { method: 'POST', headers: auth(manageToken) });
      assert.strictEqual(second.status, 404, `second acknowledge must be 404, got ${second.status}`);
      const secondBody = (await second.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(secondBody.success, false, JSON.stringify(secondBody));
      assert.strictEqual(secondBody.error.code, 'FINDING_NOT_FOUND', JSON.stringify(secondBody));
      assert.strictEqual(auditCount('cyberlab.finding_acknowledged'), 1, 'no audit on the 404');

      const unknown = await fetch(`${base}/findings/99999999-9999-4999-8999-999999999999/acknowledge`, {
        method: 'POST',
        headers: auth(manageToken),
      });
      assert.strictEqual(unknown.status, 404, `unknown finding must be 404, got ${unknown.status}`);
      assert.strictEqual(auditCount('cyberlab.finding_acknowledged'), 1, 'still no audit for unknown ids');

      const malformed = await fetch(`${base}/findings/not-a-uuid/acknowledge`, { method: 'POST', headers: auth(manageToken) });
      assert.strictEqual(malformed.status, 404, `malformed id must be 404, got ${malformed.status}`);
      assert.ok(UUID_RE.test(target.id), 'sanity: seeded finding id is a uuid');
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

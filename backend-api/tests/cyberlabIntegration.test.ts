/**
 * Task 8 — real-engine integration gate (integration test + honest SKIP).
 *
 * Design notes: the ONLY test in the suite that talks to the real engine.
 * No child_process mock, no adapter mock — probeCapabilities/runOperation hit
 * the operator-supplied binary at SEEFAST_CLI, and the HTTP flow drives the
 * real router + real jobsRunner over a FakePool (same harness as
 * tests/cyberlabJobs.test.ts) so no Postgres is needed. Storage goes to a
 * fresh temp dir via CYBERLAB_STORAGE_DIR (never backend-api/storage).
 * Without SEEFAST_CLI the file exits 0 with a visible SKIP line before any
 * assertion — never a phantom pass; with SEEFAST_CLI set (even to a broken
 * path) every check runs and fails honestly. Fixtures under
 * tests/fixtures/seefast/jsapp/ are author-written static-analysis input
 * (data), never executed by this suite.
 * Run: npx tsx tests/cyberlabIntegration.test.ts
 */
import './testEnv';
import assert from 'assert';
import express from 'express';
import fs from 'fs';
import http from 'http';
import jwt from 'jsonwebtoken';
import os from 'os';
import path from 'path';
import { JWT } from '../src/config/constants';

// Honest SKIP (brief Step 3 / ruling 1): no engine env → visible SKIP line and
// exit 0 BEFORE any assertion, harness setup or spawn. Green-without-engine
// is a SKIP by construction, never a phantom pass. When SEEFAST_CLI IS set
// this guard never fires: a missing/binary-failing engine then fails the
// checks below honestly.
if (!process.env.SEEFAST_CLI) {
  console.log('SKIP: SEEFAST_CLI não definido — integração real não executada');
  process.exit(0);
}

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
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberlab-integration-'));
process.env.CYBERLAB_STORAGE_DIR = storageDir;

// ---- Fake pg: in-memory cyberlab_* + auth tables (engine itself is REAL) ---
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
  severity: string;
  confidence: string;
  evidence: unknown;
  asset_ref: string | null;
  status: string;
};

const jobsDb = new Map<string, JobRecord>();
const artifactsDb = new Map<string, { id: string; storage_path: string }>();
const findingsDb: FindingRecord[] = [];
let idSeq = 0;

const newUuid = (): string => `00000000-0000-4000-8000-${String(++idSeq).padStart(12, '0')}`;
const nowStamp = (): string => new Date().toISOString();

const rolePermissions = new Map<string, Record<string, unknown>[]>();
const setRolePermissions = (roleId: string, codes: string[]): void => {
  rolePermissions.set(roleId, codes.map((code) => ({ code })));
};

const makeJob = (partial: Partial<JobRecord> & Pick<JobRecord, 'type' | 'status' | 'target_ref'>): JobRecord => ({
  id: newUuid(),
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
    return { rows: [], rowCount: 0 }; // limits resolve to defaults
  }
  if (sql.includes('INSERT INTO audit_logs')) {
    return { rows: [], rowCount: 0 };
  }
  if (sql.includes('INSERT INTO cyberlab_artifacts')) {
    // params: [id, sha256, original_name, size_bytes, storage_path, uploaded_by]
    const id = String(params[0]);
    artifactsDb.set(id, { id, storage_path: String(params[4]) });
    return { rows: [{ created_at: nowStamp() }], rowCount: 1 };
  }
  if (sql.includes('SELECT id FROM cyberlab_artifacts')) {
    const id = String(params[0]);
    return artifactsDb.has(id) ? { rows: [{ id }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.includes('JOIN cyberlab_artifacts')) {
    const job = jobsDb.get(String(params[0]));
    const artifact = job ? artifactsDb.get(job.target_ref ?? '') : undefined;
    return artifact ? { rows: [{ storage_path: artifact.storage_path }], rowCount: 1 } : { rows: [], rowCount: 0 };
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
  if (sql.includes('SELECT cancel_requested FROM cyberlab_jobs')) {
    const job = jobsDb.get(String(params[0]));
    return { rows: [{ cancel_requested: job?.cancel_requested ?? false }], rowCount: 1 };
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
  if (sql.includes('INSERT INTO cyberlab_findings')) {
    const row: FindingRecord = {
      id: newUuid(),
      job_id: String(params[0]),
      kind: String(params[1]),
      title: String(params[2]),
      severity: String(params[3]),
      confidence: String(params[4]),
      evidence: params[5] ?? null,
      asset_ref: null,
      status: 'open',
    };
    findingsDb.push(row);
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes('AS total FROM cyberlab_findings')) {
    return { rows: [{ total: findingsDb.length }], rowCount: 1 };
  }
  if (sql.includes('FROM cyberlab_findings')) {
    const rows = [...findingsDb].sort((a, b) =>
      a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : a.id < b.id ? -1 : 1
    );
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('FROM cyberlab_jobs WHERE id = $1')) {
    const job = jobsDb.get(String(params[0]));
    return job ? { rows: [{ ...job }], rowCount: 1 } : { rows: [], rowCount: 0 };
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
const { initDatabase } = require('../src/config/database') as {
  initDatabase: () => Promise<void>;
};
/* eslint-enable @typescript-eslint/no-var-requires */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  await initDatabase();

  /* eslint-disable @typescript-eslint/no-var-requires */
  const { probeCapabilities } = require('../src/services/seefast/capabilities') as
    typeof import('../src/services/seefast/capabilities');
  const { runOperation } = require('../src/services/seefast/adapter') as typeof import('../src/services/seefast/adapter');
  const { normalizeJobResult } = require('../src/services/seefast/normalize') as
    typeof import('../src/services/seefast/normalize');
  const { getLimits } = require('../src/services/seefast/limits') as typeof import('../src/services/seefast/limits');
  /* eslint-enable @typescript-eslint/no-var-requires */

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

  const jsAppDir = path.join(__dirname, 'fixtures', 'seefast', 'jsapp');
  const jsAppMain = path.join(jsAppDir, 'main.js');

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

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    // (a) capability probe against the real binary
    await checkAsync('test_probe_reports_available_true', async () => {
      const status = await probeCapabilities();
      console.log(`      engine probe: ${JSON.stringify(status)}`);
      assert.strictEqual(status.available, true, `expected available:true, got ${JSON.stringify(status)}`);
    });

    // (b) direct adapter run over the author-written mini-app fixture
    let engineStdout = '';
    await checkAsync('test_js_analysis_run_exits_zero_with_parseable_stdout', async () => {
      const limits = await getLimits();
      const run = await runOperation('js_analysis', jsAppDir, limits);
      assert.strictEqual(run.timedOut, false, `engine run must not time out (limit ${limits.jobTimeoutMs}ms)`);
      assert.strictEqual(run.truncated, false, `stdout must not be truncated at maxBuffer ${limits.maxStdoutBytes}`);
      assert.strictEqual(
        run.exitCode,
        0,
        `expected exit 0, got ${run.exitCode}; stderr tail: ${run.stderrTail.slice(0, 300)}`
      );
      engineStdout = run.stdout;
      let parsed: unknown;
      try {
        parsed = JSON.parse(run.stdout);
      } catch {
        parsed = null;
      }
      assert.ok(
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
        `stdout must be a JSON object, got: ${run.stdout.slice(0, 300)}`
      );
    });

    // (c) normalisation of the real engine output
    await checkAsync('test_normalize_yields_findings_and_limitations', async () => {
      const outcome = normalizeJobResult('js_analysis', engineStdout, false);
      if (outcome.ok === false) {
        throw new Error(`normalisation rejected engine output: ${outcome.reason}`);
      }
      assert.ok(outcome.findings.length >= 1, `expected ≥1 finding, got 0 (summary: ${outcome.summary})`);
      assert.ok(outcome.limitations.length >= 1, 'limitations must be non-empty');
    });

    // (d) full HTTP flow: upload mini-app → job → poll completed → findings > 0
    await checkAsync('test_http_upload_job_poll_completed_with_findings', async () => {
      const manageToken = sessionToken('user-integration', 'role-integration', ['cyberlab.manage', 'cyberlab.view']);
      const auth = { Authorization: `Bearer ${manageToken}`, 'Content-Type': 'application/json' };

      const fileContent = fs.readFileSync(jsAppMain);
      const uploadRes = await fetch(`${base}/artifacts`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'main.js', contentBase64: fileContent.toString('base64') }),
      });
      assert.strictEqual(uploadRes.status, 201, `artifact upload expected 201, got ${uploadRes.status}`);
      const uploadBody = (await uploadRes.json()) as { data: { artifact: { id: string } } };
      const artifactId = uploadBody.data.artifact.id;
      assert.ok(UUID_RE.test(artifactId), `artifact id must be a uuid: ${artifactId}`);

      const jobRes = await fetch(`${base}/jobs`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ type: 'js_analysis', artifactId }),
      });
      assert.strictEqual(jobRes.status, 201, `job create expected 201, got ${jobRes.status}`);
      const jobBody = (await jobRes.json()) as { data: { job: { id: string; status: string }; started: boolean } };
      assert.strictEqual(jobBody.data.started, true, 'the free slot must start the job immediately');
      const jobId = jobBody.data.job.id;
      assert.ok(UUID_RE.test(jobId), `job id must be a uuid: ${jobId}`);

      const limits = await getLimits();
      const deadline = Date.now() + limits.jobTimeoutMs + 60_000;
      let job: Record<string, unknown> = {};
      for (;;) {
        const res = await fetch(`${base}/jobs/${jobId}`, { headers: auth });
        assert.strictEqual(res.status, 200, `poll expected 200, got ${res.status}`);
        job = ((await res.json()) as { data: { job: Record<string, unknown> } }).data.job;
        const status = String(job.status);
        if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'partial') break;
        if (Date.now() > deadline) {
          throw new Error(`timeout waiting for job ${jobId} (last status: ${status})`);
        }
        await sleep(200);
      }
      assert.strictEqual(
        job.status,
        'completed',
        `expected completed, got ${job.status}; error: ${JSON.stringify(job.error)}`
      );
      assert.strictEqual(job.error, null, 'completed job carries no error');
      assert.ok(
        job.result !== null && typeof (job.result as { summary?: unknown }).summary === 'string',
        `result must carry the normalised summary, got ${JSON.stringify(job.result)}`
      );

      const findingsRes = await fetch(`${base}/findings?limit=100`, { headers: auth });
      assert.strictEqual(findingsRes.status, 200, `findings expected 200, got ${findingsRes.status}`);
      const findingsBody = (await findingsRes.json()) as {
        data: { findings: Array<{ job_id: string; evidence: { limitations?: unknown } | null }>; total: number };
      };
      const jobFindings = findingsBody.data.findings.filter((f) => f.job_id === jobId);
      assert.ok(
        jobFindings.length > 0,
        `expected >0 findings for job ${jobId}, got ${JSON.stringify(findingsBody.data)}`
      );
      for (const finding of jobFindings) {
        const limitations = finding.evidence?.limitations;
        assert.ok(
          Array.isArray(limitations) && limitations.length >= 1,
          'every finding must carry non-empty evidence.limitations'
        );
      }
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(storageDir, { recursive: true, force: true });
    delete process.env.CYBERLAB_STORAGE_DIR;
  }

  if (failed > 0) {
    // exitCode only (not process.exit): this suite spawns real child
    // processes, and process.exit on Windows can race their handle cleanup
    // into a libuv assert — a natural drain exits 1 cleanly.
    console.error(`\n${failed} test(s) FAILED`);
    process.exitCode = 1;
    return;
  }
  console.log('\nALL PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

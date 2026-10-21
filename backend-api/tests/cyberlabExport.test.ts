/**
 * RED->GREEN gate for Task 6 — export (JSON/CSV) + audit filtrada + config.
 *
 * Design notes: same FakePool harness as tests/cyberlabFindings.test.ts —
 * stubbed pg.Pool in require.cache backed by in-memory jobs/findings stores,
 * an app_settings map for the three cyberlab_* limit keys, and an audit_logs
 * store that emulates `action LIKE 'cyberlab.%'` (the predicate is read from
 * the SQL text, so a route that drops the WHERE clause fails the hermes_scan
 * exclusion assertion instead of passing silently).
 * Run: npx tsx tests/cyberlabExport.test.ts
 */
import './testEnv';
import assert from 'assert';
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { JWT } from '../src/config/constants';

// Precedence is env > settings > defaults: ambient CYBERLAB_* values must
// never shadow the settings layer the config tests exercise.
delete process.env.CYBERLAB_MAX_ARTIFACT_MB;
delete process.env.CYBERLAB_JOB_TIMEOUT_S;
delete process.env.CYBERLAB_MAX_CONCURRENT;

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

// ---- Fake pg: jobs / findings / app_settings / audit_logs ------------------
type Row = Record<string, unknown>;

const jobsDb = new Map<string, Row>();
const findingsDb = new Map<string, Row>();
const settingsDb = new Map<string, string>();
const auditRows: Row[] = [];

const rolePermissions = new Map<string, Row[]>();
const setRolePermissions = (roleId: string, codes: string[]): void => {
  rolePermissions.set(roleId, codes.map((code) => ({ code })));
};

// Emulate only the predicate the SQL actually carries: a route that forgets
// `action LIKE 'cyberlab.%'` gets every row back and the test fails.
const auditMatches = (row: Row, sql: string): boolean =>
  sql.includes("action LIKE 'cyberlab.%'") ? String(row.action).startsWith('cyberlab.') : true;

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
  if (sql.includes('INSERT INTO app_settings')) {
    settingsDb.set(String(params[0]), String(params[1]));
    return { rows: [], rowCount: 1 };
  }
  if (sql.includes('FROM app_settings WHERE key = ANY')) {
    const keys = (params[0] as string[]) ?? [];
    const rows = keys.filter((key) => settingsDb.has(key)).map((key) => ({ key, value: settingsDb.get(key) }));
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('SELECT key, value FROM app_settings')) {
    const rows = [...settingsDb.entries()].map(([key, value]) => ({ key, value }));
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('INSERT INTO audit_logs')) {
    auditRows.push({
      id: String(params[0]),
      user_id: params[1] ?? null,
      user_email: params[2] ?? null,
      action: params[3],
      target_type: params[4] ?? null,
      target_id: params[5] ?? null,
      description: params[6] ?? null,
      ip_address: params[7] ?? null,
      created_at: new Date().toISOString(),
    });
    return { rows: [], rowCount: 0 };
  }
  if (sql.includes('FROM audit_logs') && sql.includes('ORDER BY created_at DESC')) {
    let rows = auditRows
      .filter((row) => auditMatches(row, sql))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
    if (sql.includes('LIMIT $1 OFFSET $2')) {
      const limit = Number(params[0]);
      const offset = Number(params[1]);
      rows = rows.slice(offset, offset + limit);
    }
    return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
  }
  if (sql.includes('COUNT(*)::int AS total FROM audit_logs')) {
    const total = auditRows.filter((row) => auditMatches(row, sql)).length;
    return { rows: [{ total }], rowCount: 1 };
  }
  if (sql.includes('FROM cyberlab_jobs WHERE id = $1')) {
    const job = jobsDb.get(String(params[0]));
    return job ? { rows: [{ ...job }], rowCount: 1 } : { rows: [], rowCount: 0 };
  }
  if (sql.includes('FROM cyberlab_findings WHERE job_id = $1')) {
    const rows = [...findingsDb.values()]
      .filter((finding) => finding.job_id === String(params[0]))
      .map((finding) => ({ ...finding }));
    return { rows, rowCount: rows.length };
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

// ---- Fixtures --------------------------------------------------------------
const JOB_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const ARTIFACT_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const FACT_EVIDENCE = {
  source: 'seefast:js_analysis',
  method: 'static:js_analysis',
  observed_at: '2026-03-01T09:00:02.000Z',
  limitations: ['análise estática; sem execução'],
  details: { moduleCount: 3 },
};

const seedStores = (): void => {
  jobsDb.set(JOB_ID, {
    id: JOB_ID,
    type: 'js_analysis',
    status: 'completed',
    target_ref: ARTIFACT_ID,
    progress: 100,
    cancel_requested: false,
    error: null,
    result: { summary: 'Static pass over the uploaded artifact' },
    started_by: null,
    created_at: '2026-03-01T09:00:00.000Z',
    started_at: '2026-03-01T09:00:01.000Z',
    finished_at: '2026-03-01T09:00:02.000Z',
  });
  findingsDb.set('f0000000-0000-4000-8000-000000000001', {
    id: 'f0000000-0000-4000-8000-000000000001',
    job_id: JOB_ID,
    kind: 'fact',
    title: 'Open port 8080, "admin" panel',
    severity: 'high',
    confidence: 'high',
    evidence: FACT_EVIDENCE,
    asset_ref: null,
    status: 'open',
  });
  findingsDb.set('f0000000-0000-4000-8000-000000000002', {
    id: 'f0000000-0000-4000-8000-000000000002',
    job_id: JOB_ID,
    kind: 'recommendation',
    title: 'Rotate exposed credential',
    severity: 'info',
    confidence: 'medium',
    evidence: FACT_EVIDENCE,
    asset_ref: null,
    status: 'acknowledged',
  });
  auditRows.push(
    {
      id: 'a0000000-0000-4000-8000-000000000001',
      user_id: 'u0000000-0000-4000-8000-000000000001',
      user_email: 'seed@test.local',
      action: 'cyberlab.artifact_uploaded',
      target_type: 'cyberlab_artifact',
      target_id: ARTIFACT_ID,
      description: 'Artifact uploaded: sample.js',
      ip_address: '127.0.0.1',
      created_at: '2026-03-01T08:00:00.000Z',
    },
    {
      id: 'a0000000-0000-4000-8000-000000000002',
      user_id: 'u0000000-0000-4000-8000-000000000001',
      user_email: 'seed@test.local',
      action: 'cyberlab.finding_acknowledged',
      target_type: 'cyberlab_finding',
      target_id: 'f0000000-0000-4000-8000-000000000001',
      description: 'Finding acknowledged',
      ip_address: '127.0.0.1',
      created_at: '2026-03-01T08:30:00.000Z',
    },
    // Newest row on purpose: a route without the LIKE filter returns it first.
    {
      id: 'a0000000-0000-4000-8000-000000000003',
      user_id: 'u0000000-0000-4000-8000-000000000002',
      user_email: 'seed@test.local',
      action: 'hermes_scan',
      target_type: 'host',
      target_id: '10.0.0.5',
      description: 'Out-of-scope row that must never reach /audit',
      ip_address: '127.0.0.1',
      created_at: '2026-03-01T09:30:00.000Z',
    },
    {
      id: 'a0000000-0000-4000-8000-000000000004',
      user_id: 'u0000000-0000-4000-8000-000000000002',
      user_email: 'seed@test.local',
      action: 'settings_update',
      target_type: 'setting',
      target_id: 'smtp_host',
      description: 'Global settings route row, also out of scope',
      ip_address: '127.0.0.1',
      created_at: '2026-03-01T09:45:00.000Z',
    }
  );
};

async function main(): Promise<void> {
  seedStores();
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

  const exportToken = sessionToken('user-export', 'role-export', ['cyberlab.export', 'cyberlab.view']);
  const manageToken = sessionToken('user-manager', 'role-manager', ['cyberlab.manage', 'cyberlab.view']);
  const viewToken = sessionToken('user-viewer', 'role-viewer', ['cyberlab.view']);
  const noPermToken = sessionToken('user-none', 'role-none', ['devices.view']);

  const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  const get = (path: string, token: string) => fetch(`${base}${path}`, { headers: auth(token) });
  const putConfig = (token: string, body: unknown) =>
    fetch(`${base}/config`, { method: 'PUT', headers: auth(token), body: JSON.stringify(body) });

  try {
    // ---- RBAC --------------------------------------------------------------
    await checkAsync('test_export_requires_cyberlab_export_permission', async () => {
      for (const token of [viewToken, noPermToken]) {
        const res = await get(`/jobs/${JOB_ID}/export`, token);
        assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
        const body = (await res.json()) as { success: boolean; error: { code: string; required: string[]; missing: string[] } };
        assert.strictEqual(body.success, false);
        assert.strictEqual(body.error.code, 'AUTH_PERMISSION_DENIED', JSON.stringify(body));
        assert.deepStrictEqual(body.error.required, ['cyberlab.export']);
        assert.deepStrictEqual(body.error.missing, ['cyberlab.export']);
      }
    });

    await checkAsync('test_audit_and_config_enforce_their_permissions', async () => {
      const cases = [
        { res: await get('/audit', noPermToken), required: ['cyberlab.view'] },
        { res: await get('/config', noPermToken), required: ['cyberlab.view'] },
        { res: await putConfig(viewToken, { maxConcurrent: 2 }), required: ['cyberlab.manage'] },
      ];
      for (const { res, required } of cases) {
        assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
        const body = (await res.json()) as { success: boolean; error: { code: string; required: string[] } };
        assert.strictEqual(body.success, false);
        assert.strictEqual(body.error.code, 'AUTH_PERMISSION_DENIED', JSON.stringify(body));
        assert.deepStrictEqual(body.error.required, required);
      }
    });

    // ---- Audit (runs before any successful action so totals are fixed) -----
    await checkAsync('test_audit_returns_only_cyberlab_actions_with_total', async () => {
      const res = await get('/audit', viewToken);
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const body = (await res.json()) as {
        success: boolean;
        data: { entries: Row[]; total: number };
      };
      assert.strictEqual(body.success, true, JSON.stringify(body));
      const { entries, total } = body.data;
      assert.strictEqual(total, 2, `total must count only cyberlab.* rows, got ${total}`);
      assert.strictEqual(entries.length, 2, `expected 2 entries, got ${entries.length}`);
      assert.ok(
        entries.every((entry) => String(entry.action).startsWith('cyberlab.')),
        `every entry must be cyberlab.*, got ${JSON.stringify(entries.map((e) => e.action))}`
      );
      assert.ok(
        !entries.some((entry) => entry.action === 'hermes_scan'),
        'the hermes_scan row must be excluded'
      );
      assert.ok(
        !entries.some((entry) => entry.action === 'settings_update'),
        'non-cyberlab actions must be excluded'
      );
      assert.strictEqual(entries[0].action, 'cyberlab.finding_acknowledged', 'ORDER BY created_at DESC');
      for (const key of ['id', 'user_email', 'action', 'target_type', 'target_id', 'description', 'created_at']) {
        assert.ok(key in entries[0], `entry must carry ${key}`);
      }
    });

    await checkAsync('test_audit_paginates_with_limit_offset_and_rejects_bad_limit', async () => {
      const first = (await (await get('/audit?limit=1&offset=0', viewToken)).json()) as {
        data: { entries: Row[]; total: number };
      };
      assert.strictEqual(first.data.entries.length, 1, 'limit=1 returns one entry');
      assert.strictEqual(first.data.total, 2, 'total is the filtered set, not the page');
      assert.strictEqual(first.data.entries[0].action, 'cyberlab.finding_acknowledged');

      const second = (await (await get('/audit?limit=1&offset=1', viewToken)).json()) as {
        data: { entries: Row[]; total: number };
      };
      assert.strictEqual(second.data.entries.length, 1, 'offset=1 moves the window');
      assert.strictEqual(second.data.entries[0].action, 'cyberlab.artifact_uploaded');
      assert.strictEqual(second.data.total, 2);

      const bad = await get('/audit?limit=0', viewToken);
      assert.strictEqual(bad.status, 400, `limit=0 must be 400, got ${bad.status}`);
      const badBody = (await bad.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(badBody.success, false);
      assert.strictEqual(badBody.error.code, 'VALIDATION_ERROR', JSON.stringify(badBody));
    });

    // ---- Export: JSON ------------------------------------------------------
    await checkAsync('test_export_json_returns_job_with_real_findings', async () => {
      const res = await get(`/jobs/${JOB_ID}/export?format=json`, exportToken);
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const body = (await res.json()) as {
        success: boolean;
        data: { job: Row; findings: Row[] };
      };
      assert.strictEqual(body.success, true, JSON.stringify(body));
      const { job, findings } = body.data;
      assert.strictEqual(job.id, JOB_ID);
      assert.strictEqual(job.artifact_id, ARTIFACT_ID, 'target_ref must be exposed as artifact_id');
      assert.strictEqual(job.status, 'completed');
      assert.strictEqual(findings.length, 2, `expected the 2 seeded findings, got ${findings.length}`);
      const titles = findings.map((finding) => String(finding.title));
      assert.ok(titles.includes('Open port 8080, "admin" panel'), `titles: ${JSON.stringify(titles)}`);
      const fact = findings.find((finding) => finding.kind === 'fact');
      assert.ok(fact, 'the seeded fact must be in the export');
      assert.strictEqual(fact.severity, 'high');
      const evidence = fact.evidence as typeof FACT_EVIDENCE;
      assert.strictEqual(evidence.source, 'seefast:js_analysis');
      assert.ok(Array.isArray(evidence.limitations) && evidence.limitations.length > 0);

      // Default format (no ?format=) is JSON.
      const fallback = await get(`/jobs/${JOB_ID}/export`, exportToken);
      assert.strictEqual(fallback.status, 200, `default format must be 200, got ${fallback.status}`);
      const fallbackBody = (await fallback.json()) as { data: { job: Row; findings: Row[] } };
      assert.strictEqual(fallbackBody.data.job.id, JOB_ID);
      assert.strictEqual(fallbackBody.data.findings.length, 2);
    });

    // ---- Export: CSV -------------------------------------------------------
    await checkAsync('test_export_csv_returns_findings_with_reports_style_header', async () => {
      const res = await get(`/jobs/${JOB_ID}/export?format=csv`, exportToken);
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const contentType = res.headers.get('content-type') ?? '';
      assert.ok(contentType.startsWith('text/csv'), `content-type must be text/csv, got ${contentType}`);
      const disposition = res.headers.get('content-disposition') ?? '';
      assert.ok(disposition.includes('attachment'), `content-disposition: ${disposition}`);
      assert.ok(disposition.includes('.csv'), `content-disposition must carry a .csv filename: ${disposition}`);

      const text = await res.text();
      const lines = text.split('\n');
      assert.strictEqual(
        lines[0],
        '"ID","Job ID","Kind","Title","Severity","Confidence","Status","Asset Ref","Evidence"',
        `CSV header: ${lines[0]}`
      );
      assert.strictEqual(lines.length, 3, `header + one row per finding, got ${lines.length} lines`);
      assert.ok(
        text.includes('"Open port 8080, ""admin"" panel"'),
        'commas/quotes must be escaped reports.ts-style'
      );
      assert.ok(text.includes('"fact"'), 'kind column must be present');
      assert.ok(text.includes('"recommendation"'), 'both findings must be exported');
      assert.ok(text.includes('seefast:js_analysis'), 'evidence must be serialised into the CSV');
    });

    // Findings titles/evidence come from analysed third-party artifacts, so a
    // cell can start with =, +, -, @ — a spreadsheet would evaluate it as a
    // formula on open (CSV injection). The cell must be neutralised, and the
    // legitimate quoting/escaping above must survive untouched.
    await checkAsync('test_export_csv_neutralises_formula_injection_without_breaking_quotes', async () => {
      findingsDb.set('f0000000-0000-4000-8000-000000000003', {
        id: 'f0000000-0000-4000-8000-000000000003',
        job_id: JOB_ID,
        kind: 'indicator',
        title: '=HYPERLINK("http://evil.local","click")',
        severity: 'low',
        confidence: 'medium',
        evidence: null,
        asset_ref: null,
        status: 'open',
      });
      findingsDb.set('f0000000-0000-4000-8000-000000000004', {
        id: 'f0000000-0000-4000-8000-000000000004',
        job_id: JOB_ID,
        kind: 'indicator',
        title: '+cmd|calc',
        severity: 'low',
        confidence: 'medium',
        evidence: null,
        asset_ref: null,
        status: 'open',
      });
      try {
        const res = await get(`/jobs/${JOB_ID}/export?format=csv`, exportToken);
        assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
        const text = await res.text();
        const lines = text.split('\n');
        assert.strictEqual(lines.length, 5, `header + four findings, got ${lines.length} lines`);

        const rowOf = (needle: string): string =>
          lines.find((line) => line.includes(needle)) ?? '';
        assert.ok(
          rowOf('=HYPERLINK').includes(`"'=HYPERLINK(""http://evil.local"",""click"")"`),
          `formula cell must be quote-prefixed and inner quotes doubled: ${rowOf('=HYPERLINK')}`
        );
        assert.ok(
          rowOf('+cmd|calc').includes(`"'+cmd|calc"`),
          `a leading + must be neutralised too: ${rowOf('+cmd|calc')}`
        );

        // No cell may begin a value with a bare formula character.
        for (const line of lines.slice(1)) {
          const cells = line.split('","');
          for (const cell of cells) {
            const value = cell.replace(/^"/, '');
            assert.ok(
              !/^[=+\-@]/.test(value),
              `unneutralised formula-leading cell in CSV: ${value}`
            );
          }
        }

        // The pre-existing escaping must still be intact.
        assert.ok(
          text.includes('"Open port 8080, ""admin"" panel"'),
          'commas/quotes in existing findings must still be escaped'
        );
      } finally {
        findingsDb.delete('f0000000-0000-4000-8000-000000000003');
        findingsDb.delete('f0000000-0000-4000-8000-000000000004');
      }
    });

    await checkAsync('test_export_rejects_invalid_format_with_400', async () => {
      const res = await get(`/jobs/${JOB_ID}/export?format=xml`, exportToken);
      assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
      const body = (await res.json()) as {
        success: boolean;
        error: { code: string; details: Array<{ field: string }> };
      };
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error.code, 'VALIDATION_ERROR', JSON.stringify(body));
      assert.ok(
        body.error.details.some((detail) => detail.field === 'format'),
        `details must name the format field: ${JSON.stringify(body.error.details)}`
      );
    });

    await checkAsync('test_export_missing_or_malformed_job_is_404', async () => {
      const missing = await get('/jobs/99999999-9999-4999-8999-999999999999/export', exportToken);
      assert.strictEqual(missing.status, 404, `expected 404, got ${missing.status}`);
      const body = (await missing.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error.code, 'JOB_NOT_FOUND', JSON.stringify(body));

      const csvMissing = await get('/jobs/99999999-9999-4999-8999-999999999999/export?format=csv', exportToken);
      assert.strictEqual(csvMissing.status, 404, `csv of a missing job must be 404, got ${csvMissing.status}`);

      const malformed = await get('/jobs/not-a-uuid/export', exportToken);
      assert.strictEqual(malformed.status, 404, `malformed id must be 404, got ${malformed.status}`);
    });

    // ---- Config ------------------------------------------------------------
    await checkAsync('test_config_get_returns_effective_limits_and_overrides', async () => {
      const res = await get('/config', viewToken);
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const body = (await res.json()) as {
        success: boolean;
        data: { limits: Row; overrides: Row; bounds: Row };
      };
      assert.strictEqual(body.success, true, JSON.stringify(body));
      const { limits, overrides, bounds } = body.data;
      assert.deepStrictEqual(
        limits,
        { max_artifact_mb: 25, job_timeout_s: 120, max_concurrent: 1 },
        'defaults must be the effective limits with no env and no settings'
      );
      assert.deepStrictEqual(
        overrides,
        { cyberlab_max_artifact_mb: null, cyberlab_job_timeout_s: null, cyberlab_max_concurrent: null },
        'no stored overrides yet'
      );
      assert.deepStrictEqual(bounds.max_artifact_mb, { min: 1, max: 28 });
      assert.deepStrictEqual(bounds.job_timeout_s, { min: 5, max: 600 });
      assert.deepStrictEqual(bounds.max_concurrent, { min: 1, max: 4 });
    });

    await checkAsync('test_config_put_within_bounds_is_reflected_immediately_by_get', async () => {
      const put = await putConfig(manageToken, { maxArtifactMb: 22, jobTimeoutS: 300, maxConcurrent: 3 });
      assert.strictEqual(put.status, 200, `expected 200, got ${put.status}`);
      const putBody = (await put.json()) as { success: boolean; data: { limits: Row; overrides: Row } };
      assert.strictEqual(putBody.success, true, JSON.stringify(putBody));
      assert.deepStrictEqual(
        putBody.data.limits,
        { max_artifact_mb: 22, job_timeout_s: 300, max_concurrent: 3 },
        'PUT response must already carry the effective limits'
      );
      assert.deepStrictEqual(
        putBody.data.overrides,
        { cyberlab_max_artifact_mb: '22', cyberlab_job_timeout_s: '300', cyberlab_max_concurrent: '3' }
      );

      assert.strictEqual(settingsDb.get('cyberlab_max_artifact_mb'), '22', 'exact settings key');
      assert.strictEqual(settingsDb.get('cyberlab_job_timeout_s'), '300', 'exact settings key');
      assert.strictEqual(settingsDb.get('cyberlab_max_concurrent'), '3', 'exact settings key');

      const getRes = await get('/config', viewToken);
      assert.strictEqual(getRes.status, 200);
      const getBody = (await getRes.json()) as { data: { limits: Row; overrides: Row } };
      assert.deepStrictEqual(
        getBody.data.limits,
        { max_artifact_mb: 22, job_timeout_s: 300, max_concurrent: 3 },
        'GET must reflect the PUT immediately (getLimits cache invalidated)'
      );
      assert.deepStrictEqual(getBody.data.overrides, {
        cyberlab_max_artifact_mb: '22',
        cyberlab_job_timeout_s: '300',
        cyberlab_max_concurrent: '3',
      });
    });

    await checkAsync('test_config_put_out_of_bounds_is_400_and_writes_nothing', async () => {
      const cases: Array<[string, Record<string, unknown>]> = [
        ['artifact above the 28MB parser ceiling', { maxArtifactMb: 29 }],
        ['timeout below 5s', { jobTimeoutS: 4 }],
        ['timeout above 600s', { jobTimeoutS: 601 }],
        ['concurrency above 4', { maxConcurrent: 5 }],
        ['concurrency below 1', { maxConcurrent: 0 }],
        ['no keys at all', {}],
      ];
      for (const [label, payload] of cases) {
        const res = await putConfig(manageToken, payload);
        assert.strictEqual(res.status, 400, `${label}: expected 400, got ${res.status}`);
        const body = (await res.json()) as { success: boolean; error: { code: string } };
        assert.strictEqual(body.success, false, label);
        assert.strictEqual(body.error.code, 'VALIDATION_ERROR', `${label}: ${JSON.stringify(body)}`);
      }

      const after = (await (await get('/config', viewToken)).json()) as {
        data: { limits: Row; overrides: Row };
      };
      assert.deepStrictEqual(
        after.data.limits,
        { max_artifact_mb: 22, job_timeout_s: 300, max_concurrent: 3 },
        'a rejected PUT must not touch settings or the effective limits'
      );
      assert.deepStrictEqual(after.data.overrides, {
        cyberlab_max_artifact_mb: '22',
        cyberlab_job_timeout_s: '300',
        cyberlab_max_concurrent: '3',
      });
    });

    await checkAsync('test_config_env_takes_precedence_over_settings', async () => {
      process.env.CYBERLAB_MAX_ARTIFACT_MB = '10';
      try {
        const put = await putConfig(manageToken, { maxArtifactMb: 22 });
        assert.strictEqual(put.status, 200, `expected 200, got ${put.status}`);
        const res = await get('/config', viewToken);
        const body = (await res.json()) as { data: { limits: Row; overrides: Row } };
        assert.strictEqual(
          body.data.limits.max_artifact_mb,
          10,
          'env CYBERLAB_MAX_ARTIFACT_MB must win over the settings override'
        );
        assert.strictEqual(
          body.data.overrides.cyberlab_max_artifact_mb,
          '22',
          'the stored override stays visible as the editable layer'
        );
      } finally {
        delete process.env.CYBERLAB_MAX_ARTIFACT_MB;
      }
    });

    // ---- Audit captures this task's own actions -----------------------------
    await checkAsync('test_audit_lists_export_and_config_actions', async () => {
      const body = (await (await get('/audit?limit=100', viewToken)).json()) as {
        data: { entries: Row[]; total: number };
      };
      const actions = body.data.entries.map((entry) => String(entry.action));
      assert.ok(actions.includes('cyberlab.exported'), `actions: ${JSON.stringify(actions)}`);
      assert.ok(actions.includes('cyberlab.config_updated'), `actions: ${JSON.stringify(actions)}`);
      assert.ok(
        actions.every((action) => action.startsWith('cyberlab.')),
        `only cyberlab.* actions may appear: ${JSON.stringify(actions)}`
      );
      assert.ok(!actions.includes('hermes_scan'), 'hermes_scan must stay excluded');
      assert.strictEqual(
        body.data.total,
        body.data.entries.length,
        'limit=100 covers the whole filtered set'
      );
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.CYBERLAB_MAX_ARTIFACT_MB;
    delete process.env.CYBERLAB_JOB_TIMEOUT_S;
    delete process.env.CYBERLAB_MAX_CONCURRENT;
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


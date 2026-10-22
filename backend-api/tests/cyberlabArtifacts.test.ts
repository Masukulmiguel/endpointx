/**
 * RED->GREEN gate for Task 3 — cyberlab routes: providers + artifacts (+ limits).
 *
 * Design notes: same FakePool harness as tests/networkDiscovery.test.ts - a
 * stubbed pg.Pool installed in require.cache before config/database loads,
 * then initDatabase() run against it. The real router is loaded via dynamic
 * import AFTER the fake is in place and mounted on /api/cyberlab, so every
 * assertion (RBAC codes, hard size limit, safe filenames, audit row) runs
 * through the production handler. The app is assembled exactly like index.ts:
 * cyberlab-scoped 40mb json parser gated by authenticate, then the global
 * 10mb parser (which no-ops on already-parsed bodies via req._body), then the
 * router - so oversize bodies above 10MB prove the scoped parser lets the
 * route's own PAYLOAD_TOO_LARGE check answer. Storage goes to a fresh temp
 * dir via CYBERLAB_STORAGE_DIR (never backend-api/storage) and is removed at
 * the end.
 * Run: npx tsx tests/cyberlabArtifacts.test.ts
 */
import './testEnv';
import assert from 'assert';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import http from 'http';
import jwt from 'jsonwebtoken';
import os from 'os';
import path from 'path';
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

// ---- Storage: fresh temp dir, never backend-api/storage (controller ruling 2)
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyberlab-artifacts-'));
process.env.CYBERLAB_STORAGE_DIR = storageDir;

// ---- Fake pg (installed before config/database is first required) --------
let capturing = false;
const calls: Array<{ sql: string; params: unknown[] }> = [];

// Per-role permission rows for authenticate()'s loadRolePermissions query.
const rolePermissions = new Map<string, Record<string, unknown>[]>();
const setRolePermissions = (roleId: string, codes: string[]): void => {
  rolePermissions.set(roleId, codes.map((code) => ({ code })));
};

// Scripted rows for the artifact INSERT RETURNING and the list endpoints.
let artifactInsertRow: Record<string, unknown> = { created_at: new Date().toISOString() };
let listRows: Record<string, unknown>[] = [];
let listTotal = 0;

const respond = (sql: string, params: unknown[] = []) => {
  if (sql.includes('FROM permissions')) {
    const roleId = String(params[0] ?? '');
    const rows = rolePermissions.get(roleId) ?? [];
    return { rows, rowCount: rows.length };
  }
  if (sql.includes('INSERT INTO cyberlab_artifacts')) {
    return { rows: [artifactInsertRow], rowCount: 1 };
  }
  if (sql.includes('INSERT INTO audit_logs')) {
    return { rows: [], rowCount: 0 };
  }
  if (sql.includes('FROM app_settings WHERE key = ANY')) {
    return { rows: [], rowCount: 0 }; // limits resolve to defaults
  }
  if (sql.includes('SELECT COUNT(*)::int AS total FROM cyberlab_artifacts')) {
    return { rows: [{ total: listTotal }], rowCount: 1 };
  }
  if (sql.includes('FROM cyberlab_artifacts')) {
    return { rows: listRows, rowCount: listRows.length };
  }
  // Default live session for the authenticate() gate so HTTP tests exercise
  // the route logic rather than the session check.
  if (sql.includes('JOIN users u ON u.id = s.user_id')) {
    return {
      rows: [{ expires_at: new Date(Date.now() + 3600e3).toISOString(), is_active: true }],
      rowCount: 1,
    };
  }
  return { rows: [], rowCount: 0 };
};

/** Run one HTTP exchange with SQL capturing on; returns the emitted SQL. */
async function captureDuring<T>(fn: () => Promise<T>): Promise<{ result: T; calls: Array<{ sql: string; params: unknown[] }> }> {
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

/* eslint-disable @typescript-eslint/no-var-requires */
const { initDatabase } = require('../src/config/database') as {
  initDatabase: () => Promise<void>;
};
const { invalidateLimitsCache } = require('../src/services/seefast/limits') as {
  invalidateLimitsCache: () => void;
};
/* eslint-enable @typescript-eslint/no-var-requires */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function main(): Promise<void> {
  await initDatabase();
  const { default: cyberlabRouter } = (await import('../src/routes/cyberlab')) as {
    default: import('express').Router;
  };
  const { authenticate } = await import('../src/middleware/auth');

  // Mirror index.ts middleware order for /api/cyberlab: authenticated 40mb
  // json gate first, then the global 10mb parser (skipped via req._body for
  // requests the gate already parsed), then the router.
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

  const manageToken = sessionToken('user-uploader', 'role-uploader', ['cyberlab.manage', 'cyberlab.view']);
  const viewToken = sessionToken('user-viewer', 'role-viewer', ['cyberlab.view']);
  const noPermToken = sessionToken('user-none', 'role-none', ['devices.view']);

  const postArtifact = (token: string, name: string, contentBase64: string) =>
    fetch(`${base}/artifacts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, contentBase64 }),
    });

  const storageFiles = (): string[] => fs.readdirSync(storageDir);

  try {
    // ---- RBAC: 403 with the repo's real AUTH_PERMISSION_DENIED code --------
    await checkAsync('test_providers_requires_cyberlab_view', async () => {
      const res = await fetch(`${base}/providers`, {
        headers: { Authorization: `Bearer ${noPermToken}` },
      });
      assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error.code, 'AUTH_PERMISSION_DENIED', JSON.stringify(body));
    });

    await checkAsync('test_upload_requires_cyberlab_manage', async () => {
      const res = await postArtifact(viewToken, 'a.js', Buffer.from('x').toString('base64'));
      assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
      const body = (await res.json()) as { error: { code: string; required?: string[] } };
      assert.strictEqual(body.error.code, 'AUTH_PERMISSION_DENIED', JSON.stringify(body));
      assert.deepStrictEqual(body.error.required, ['cyberlab.manage']);
    });

    await checkAsync('test_artifact_list_requires_cyberlab_view', async () => {
      const res = await fetch(`${base}/artifacts`, {
        headers: { Authorization: `Bearer ${noPermToken}` },
      });
      assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
      const body = (await res.json()) as { error: { code: string } };
      assert.strictEqual(body.error.code, 'AUTH_PERMISSION_DENIED', JSON.stringify(body));
    });

    // ---- Hard size limit: detected BEFORE decoding, 413, no file, no INSERT
    await checkAsync('test_upload_oversize_is_413_with_no_file_and_no_insert', async () => {
      process.env.CYBERLAB_MAX_ARTIFACT_MB = '1';
      invalidateLimitsCache();
      try {
        // (len*3)/4 = 1048578 > 1 MiB, checked before any decode work
        const oversize = 'A'.repeat(1_398_104);
        const { result, calls: emitted } = await captureDuring(() => postArtifact(manageToken, 'big.bin', oversize));
        assert.strictEqual(result.status, 413, `expected 413, got ${result.status}`);
        const body = (await result.json()) as { success: boolean; error: { code: string } };
        assert.strictEqual(body.success, false);
        assert.strictEqual(body.error.code, 'PAYLOAD_TOO_LARGE', JSON.stringify(body));
        assert.deepStrictEqual(storageFiles(), [], 'oversize upload must write zero files');
        assert.strictEqual(
          emitted.filter((c) => c.sql.includes('INSERT INTO cyberlab_artifacts')).length,
          0,
          'oversize upload must never INSERT'
        );
      } finally {
        delete process.env.CYBERLAB_MAX_ARTIFACT_MB;
        invalidateLimitsCache();
      }
    });

    // ---- Body above the global 10mb parser must reach the route's check ----
    await checkAsync('test_upload_over_10mb_body_reaches_route_limit_check', async () => {
      process.env.CYBERLAB_MAX_ARTIFACT_MB = '10';
      invalidateLimitsCache();
      try {
        // 14_000_000 base64 chars ≈ 10.5MB decoded > 10MB cap, and the body
        // itself is far above the global 10mb parser. A JSON 413 with OUR
        // code proves the scoped 40mb parser accepted it, the global parser
        // no-oped on req._body, and the route's own check fired.
        const oversize = 'A'.repeat(14_000_000);
        const { result, calls: emitted } = await captureDuring(() => postArtifact(manageToken, 'huge.bin', oversize));
        assert.strictEqual(result.status, 413, `expected 413 from the route check, got ${result.status}`);
        const body = (await result.json()) as { success: boolean; error: { code: string } };
        assert.strictEqual(body.success, false, JSON.stringify(body));
        assert.strictEqual(body.error.code, 'PAYLOAD_TOO_LARGE', JSON.stringify(body));
        assert.deepStrictEqual(storageFiles(), [], 'over-10mb oversize upload must write zero files');
        assert.strictEqual(
          emitted.filter((c) => c.sql.includes('INSERT INTO cyberlab_artifacts')).length,
          0,
          'over-10mb oversize upload must never INSERT'
        );
      } finally {
        delete process.env.CYBERLAB_MAX_ARTIFACT_MB;
        invalidateLimitsCache();
      }
    });

    // ---- Unauthenticated large body: the gate 401s before the parser -------
    await checkAsync('test_unauthenticated_large_body_is_rejected_by_gate', async () => {
      const res = await fetch(`${base}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'x.bin', contentBase64: 'A'.repeat(14_000_000) }),
      });
      assert.strictEqual(res.status, 401, `expected 401 from the gate, got ${res.status}`);
      const body = (await res.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error.code, 'AUTH_TOKEN_MISSING', JSON.stringify(body));
      assert.deepStrictEqual(storageFiles(), [], 'unauthenticated upload must write zero files');
    });

    // ---- Invalid base64: 400, no file, no INSERT ---------------------------
    await checkAsync('test_upload_invalid_base64_is_400_with_no_file_and_no_insert', async () => {
      const { result, calls: emitted } = await captureDuring(() => postArtifact(manageToken, 'bad.js', 'not-base64!!!'));
      assert.strictEqual(result.status, 400, `expected 400, got ${result.status}`);
      const body = (await result.json()) as { success: boolean; error: { code: string } };
      assert.strictEqual(body.success, false);
      assert.strictEqual(body.error.code, 'VALIDATION_ERROR', JSON.stringify(body));
      assert.deepStrictEqual(storageFiles(), [], 'invalid base64 must write zero files');
      assert.strictEqual(
        emitted.filter((c) => c.sql.includes('INSERT INTO cyberlab_artifacts')).length,
        0,
        'invalid base64 must never INSERT'
      );
    });

    // ---- Path traversal name: file on disk is [uuid]+ext only --------------
    await checkAsync('test_upload_traversal_name_stores_uuid_only_filename', async () => {
      const res = await postArtifact(manageToken, '../../etc/passwd', Buffer.from('hello').toString('base64'));
      assert.strictEqual(res.status, 201, `expected 201, got ${res.status}`);
      const body = (await res.json()) as { success: boolean; data: { artifact: { id: string; original_name: string } } };
      assert.strictEqual(body.success, true, JSON.stringify(body));
      const { id, original_name: originalName } = body.data.artifact;
      assert.ok(UUID_RE.test(id), `artifact id must be a uuid, got ${id}`);
      assert.strictEqual(originalName, '../../etc/passwd', 'original_name must be preserved in the payload');
      const files = storageFiles();
      assert.deepStrictEqual(files, [id], `stored filename must be uuid only (no traversal, no name): ${JSON.stringify(files)}`);
      assert.ok(!files[0].includes('passwd') && !files[0].includes('..'), `filename leaks the original name: ${files[0]}`);
      assert.ok(fs.existsSync(path.join(storageDir, files[0])), 'file must live directly in the storage root');
    });

    // ---- Success: sha256 INSERT + audit row + exact payload shape ----------
    await checkAsync('test_upload_success_inserts_sha256_and_writes_audit_row', async () => {
      const content = 'hello world';
      const expectedSha = crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
      const createdAt = '2026-10-17T12:00:00.000Z';
      artifactInsertRow = { created_at: createdAt };

      const { result, calls: emitted } = await captureDuring(() =>
        postArtifact(manageToken, 'demo.js', Buffer.from(content, 'utf8').toString('base64'))
      );
      assert.strictEqual(result.status, 201, `expected 201, got ${result.status}`);
      const body = (await result.json()) as {
        success: boolean;
        data: { artifact: Record<string, unknown> };
      };
      assert.strictEqual(body.success, true, JSON.stringify(body));
      const artifact = body.data.artifact;
      assert.deepStrictEqual(
        Object.keys(artifact).sort(),
        ['created_at', 'id', 'original_name', 'sha256', 'size_bytes'],
        `payload must carry exactly the documented fields: ${JSON.stringify(artifact)}`
      );
      assert.strictEqual(artifact.sha256, expectedSha, 'sha256 must be the hash of the decoded buffer');
      assert.strictEqual(artifact.size_bytes, Buffer.byteLength(content, 'utf8'));
      assert.strictEqual(artifact.original_name, 'demo.js');
      assert.strictEqual(artifact.created_at, createdAt);
      assert.ok(!JSON.stringify(body.data).includes('storage_path'), 'storage_path must never leak into the payload');

      const inserts = emitted.filter((c) => c.sql.includes('INSERT INTO cyberlab_artifacts'));
      assert.strictEqual(inserts.length, 1, 'exactly one artifact INSERT');
      const p = inserts[0].params as [string, string, string, number, string, string];
      assert.strictEqual(p[0], artifact.id, 'INSERT id must equal the returned id');
      assert.strictEqual(p[1], expectedSha, 'INSERT must carry the sha256 of the decoded buffer');
      assert.strictEqual(p[2], 'demo.js', 'original_name goes to the DB only');
      assert.strictEqual(p[3], Buffer.byteLength(content, 'utf8'));
      assert.strictEqual(path.basename(p[4]), `${artifact.id}.js`, 'storage filename must be uuid + safe ext');
      assert.ok(p[4].startsWith(storageDir), `storage_path must be inside the storage root: ${p[4]}`);
      assert.strictEqual(p[5], 'user-uploader', 'uploaded_by must be the authenticated user');

      const audits = emitted.filter((c) => c.sql.includes('INSERT INTO audit_logs'));
      assert.strictEqual(audits.length, 1, 'exactly one audit row');
      assert.strictEqual(audits[0].params[3], 'cyberlab.artifact_uploaded', 'audit action must be cyberlab.artifact_uploaded');
      assert.strictEqual(audits[0].params[5], artifact.id, 'audit target_id must be the artifact id');

      assert.ok(fs.existsSync(path.join(storageDir, `${artifact.id}.js`)), 'the .js file must exist on disk');
      assert.strictEqual(fs.readFileSync(path.join(storageDir, `${artifact.id}.js`), 'utf8'), content);
      assert.strictEqual(storageFiles().length, 2, 'two successful uploads so far');
    });

    // ---- List: { artifacts, total }, never storage_path --------------------
    await checkAsync('test_artifact_list_returns_rows_and_total_without_storage_path', async () => {
      listRows = [
        {
          id: '4b2c8f60-1111-4222-8333-444455556666',
          sha256: 'a'.repeat(64),
          original_name: 'demo.js',
          size_bytes: 11,
          created_at: '2026-10-17T12:00:00.000Z',
        },
      ];
      listTotal = 7;
      const res = await fetch(`${base}/artifacts?limit=5&offset=10`, {
        headers: { Authorization: `Bearer ${viewToken}` },
      });
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const body = (await res.json()) as {
        success: boolean;
        data: { artifacts: Record<string, unknown>[]; total: number };
      };
      assert.strictEqual(body.success, true, JSON.stringify(body));
      assert.deepStrictEqual(body.data.artifacts, listRows, 'artifacts must be the stored rows');
      assert.strictEqual(body.data.total, 7, 'total must reflect the full count');
      assert.ok(!JSON.stringify(body.data).includes('storage_path'), 'list payload must not carry storage_path');
      listRows = [];
      listTotal = 0;
    });

    // ---- List: the job count comes from the database, not from the client --
    // The Evidence page used to map artifacts to jobs from a client-side
    // window of the newest 100 jobs and state "no known jobs" for everything
    // outside it — a statement the page could not support. The count is now
    // the database's answer, per artifact, in the list query itself.
    await checkAsync('test_artifact_list_carries_the_job_count_from_the_database', async () => {
      listRows = [
        {
          id: '4b2c8f60-1111-4222-8333-444455556666',
          sha256: 'a'.repeat(64),
          original_name: 'demo.js',
          size_bytes: 11,
          created_at: '2026-10-17T12:00:00.000Z',
          job_count: 3,
        },
      ];
      listTotal = 1;
      const { result: res, calls } = await captureDuring(() =>
        fetch(`${base}/artifacts?limit=5&offset=0`, {
          headers: { Authorization: `Bearer ${viewToken}` },
        })
      );
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const body = (await res.json()) as {
        success: boolean;
        data: { artifacts: Record<string, unknown>[] };
      };
      assert.strictEqual(body.data.artifacts[0].job_count, 3, JSON.stringify(body));

      const listSql = calls.map((call) => call.sql).find((sql) => sql.includes('FROM cyberlab_artifacts a'));
      assert.ok(listSql, `the list query must select from the artifacts table: ${JSON.stringify(calls.map((c) => c.sql))}`);
      assert.ok(
        listSql.includes('FROM cyberlab_jobs j') && listSql.includes('j.target_ref = a.id'),
        `the list query must count the jobs per artifact: ${listSql}`
      );
      listRows = [];
      listTotal = 0;
    });

    // ---- Provider probe: empty SEEFAST_CLI → not_configured ----------------
    await checkAsync('test_providers_without_cli_reports_not_configured', async () => {
      delete process.env.SEEFAST_CLI;
      const res = await fetch(`${base}/providers`, {
        headers: { Authorization: `Bearer ${viewToken}` },
      });
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const body = (await res.json()) as { success: boolean; data: unknown };
      assert.strictEqual(body.success, true, JSON.stringify(body));
      assert.deepStrictEqual(
        body.data,
        { available: false, reason: 'not_configured', version: null, detail: null },
        `providers must return exactly the ProviderStatus shape: ${JSON.stringify(body.data)}`
      );
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(storageDir, { recursive: true, force: true });
    delete process.env.CYBERLAB_STORAGE_DIR;
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

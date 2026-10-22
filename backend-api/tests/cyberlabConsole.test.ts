/**
 * RED->GREEN gate for Task 7 — consola AI (POST /ai/plan).
 *
 * Design notes: same FakePool harness as tests/cyberlabExport.test.ts (every
 * SQL statement recorded), plus a require-cache mock of src/services/opencode —
 * the module routes/hermes.ts /ai calls — so isOpencodeConfigured() and
 * aiComplete() are scripted per test: no provider, provider failure, valid
 * plan, non-JSON answer and schema violations all run offline with no network.
 * The security invariant (the endpoint never creates jobs) is asserted over
 * the whole run: zero INSERT INTO cyberlab_jobs in the recorded SQL and no
 * job-shaped key in any plan response — the client submits each step itself
 * later via POST /jobs.
 * Run: npx tsx tests/cyberlabConsole.test.ts
 */
import './testEnv';
import assert from 'assert';
import express from 'express';
import http from 'http';
import jwt from 'jsonwebtoken';
import { JWT } from '../src/config/constants';

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

// ---- Fake pg: permissions + session only; every statement recorded ---------
type Row = Record<string, unknown>;

const rolePermissions = new Map<string, Row[]>();
const setRolePermissions = (roleId: string, codes: string[]): void => {
  rolePermissions.set(roleId, codes.map((code) => ({ code })));
};

const sqlCalls: Array<{ sql: string; params: unknown[] }> = [];

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

// ---- Mocked AI service (require-cache, per the brief) ----------------------
type AiScript = { kind: 'text'; text: string } | { kind: 'throw'; message: string };

const aiScripts: AiScript[] = [];
const aiCalls: Array<{ prompt: string; system: string | undefined }> = [];
let aiConfigured = false;

const queueAi = (script: AiScript): void => {
  aiScripts.push(script);
};

async function mockAiComplete(
  prompt: string,
  system?: string
): Promise<{ text: string; provider: 'zen'; model: string }> {
  aiCalls.push({ prompt, system });
  const script = aiScripts.shift();
  assert.ok(script, 'no scripted AI response queued for this call');
  if (script.kind === 'throw') throw new Error(script.message);
  return { text: script.text, provider: 'zen', model: 'test-model' };
}

const opencodePath = require.resolve('../src/services/opencode');
const realOpencode = require(opencodePath) as Record<string, unknown>;
require.cache[opencodePath]!.exports = {
  ...realOpencode,
  isOpencodeConfigured: () => aiConfigured,
  aiComplete: mockAiComplete,
};

async function main(): Promise<void> {
  await initDatabase();
  // The recorded SQL must only cover route traffic: initDatabase's DDL text
  // mentions cyberlab_jobs (CREATE TABLE) and would poison the security filter.
  sqlCalls.length = 0;
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

  const viewToken = sessionToken('user-viewer', 'role-viewer', ['cyberlab.view']);
  const noPermToken = sessionToken('user-none', 'role-none', ['devices.view']);

  const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  // Captures every plan response body so the security test can assert that no
  // response ever carried a job (or any key beyond state/steps).
  const planBodies: Array<Record<string, any>> = [];
  const postPlan = (token: string, body: unknown): Promise<Response> =>
    fetch(`${base}/ai/plan`, {
      method: 'POST',
      headers: auth(token),
      body: JSON.stringify(body),
    });
  const readPlan = async (res: Response): Promise<Record<string, any>> => {
    const parsed = (await res.json()) as Record<string, any>;
    planBodies.push(parsed);
    return parsed;
  };

  try {
    // ---- RBAC ---------------------------------------------------------------
    await checkAsync('test_ai_plan_requires_cyberlab_view_permission', async () => {
      const res = await postPlan(noPermToken, { question: 'What does this artifact contain?' });
      assert.strictEqual(res.status, 403, `expected 403, got ${res.status}`);
      const body = await readPlan(res);
      assert.strictEqual(body.success, false, JSON.stringify(body));
      assert.strictEqual(body.error.code, 'AUTH_PERMISSION_DENIED', JSON.stringify(body));
      assert.deepStrictEqual(body.error.required, ['cyberlab.view']);
      assert.deepStrictEqual(body.error.missing, ['cyberlab.view']);
    });

    // ---- Body validation ----------------------------------------------------
    await checkAsync('test_ai_plan_validates_the_question_body_with_400', async () => {
      const cases: Array<[string, unknown]> = [
        ['missing question', {}],
        ['too short', { question: 'ab' }],
        ['too long', { question: 'x'.repeat(2001) }],
        ['non-string question', { question: 42 }],
      ];
      for (const [label, payload] of cases) {
        const res = await postPlan(viewToken, payload);
        assert.strictEqual(res.status, 400, `${label}: expected 400, got ${res.status}`);
        const body = await readPlan(res);
        assert.strictEqual(body.success, false, label);
        assert.strictEqual(body.error.code, 'VALIDATION_ERROR', `${label}: ${JSON.stringify(body)}`);
        assert.ok(
          Array.isArray(body.error.details) &&
            body.error.details.some((detail: { field: string }) => detail.field === 'question'),
          `${label}: details must name the question field: ${JSON.stringify(body)}`
        );
      }
    });

    // ---- State: not_configured ---------------------------------------------
    await checkAsync('test_ai_plan_without_provider_returns_not_configured', async () => {
      aiConfigured = false;
      const before = aiCalls.length;
      const res = await postPlan(viewToken, { question: 'Summarise the risk of the uploaded artifact' });
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const body = await readPlan(res);
      assert.strictEqual(body.success, true, JSON.stringify(body));
      assert.deepStrictEqual(body.data, { state: 'not_configured' }, JSON.stringify(body));
      assert.strictEqual(aiCalls.length, before, 'no AI call may happen when no provider is configured');
    });

    // A configured provider that fails is NOT the same as no provider at all.
    // Reporting a crash as "not configured" sends the operator to look in the
    // wrong place: they will add configuration that is already there, while
    // the real fault — a timeout, a 500, a rejected key — stays invisible.
    await checkAsync('test_ai_plan_ai_failure_returns_error_state_not_not_configured', async () => {
      aiConfigured = true;
      queueAi({ kind: 'throw', message: 'provider exploded' });
      const res = await postPlan(viewToken, { question: 'Which modules look obfuscated in this build?' });
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const body = await readPlan(res);
      assert.strictEqual(body.success, true, JSON.stringify(body));
      assert.strictEqual(
        body.data.state,
        'error',
        `an AI failure must not be reported as not_configured: ${JSON.stringify(body)}`
      );
      assert.strictEqual(body.data.message, 'provider exploded', JSON.stringify(body));
    });

    // The provider's own error text can carry the endpoint it called and the
    // key it called it with. The operator needs the reason; they do not need
    // the credential.
    await checkAsync('test_ai_plan_ai_failure_message_does_not_leak_the_url_or_key', async () => {
      aiConfigured = true;
      queueAi({ kind: 'throw', message: 'POST https://api.example.com/v1?key=sk-secret-value failed' });
      const res = await postPlan(viewToken, { question: 'Analisa este artefacto' });
      const body = await readPlan(res);
      assert.strictEqual(body.data.state, 'error', JSON.stringify(body));
      assert.ok(
        !String(body.data.message).includes('sk-secret-value'),
        `the message must not carry the credential: ${body.data.message}`
      );
      assert.ok(
        !String(body.data.message).includes('https://'),
        `the message must not carry the URL: ${body.data.message}`
      );
    });

    // ---- State: ok ----------------------------------------------------------
    await checkAsync('test_ai_plan_valid_response_returns_ok_with_normalized_steps', async () => {
      aiConfigured = true;
      const steps = [
        { op: 'js_analysis', risk: 'low', needsApproval: false },
        { op: 'go_binary', risk: 'medium', needsApproval: true },
        { op: 'rust_binary', risk: 'high', needsApproval: true },
      ];
      queueAi({ kind: 'text', text: JSON.stringify({ steps }) });
      const question = 'Que riscos se encontram no artefacto carregado?';
      const res = await postPlan(viewToken, { question });
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const body = await readPlan(res);
      assert.strictEqual(body.success, true, JSON.stringify(body));
      assert.deepStrictEqual(body.data, { state: 'ok', steps }, JSON.stringify(body));

      // Normalized: each step carries exactly op/risk/needsApproval.
      for (const step of body.data.steps) {
        assert.deepStrictEqual(Object.keys(step).sort(), ['needsApproval', 'op', 'risk'], JSON.stringify(step));
      }

      // Prompt assembly mirrors routes/hermes.ts /ai: the operator question is
      // the prompt, the fixed system prompt carries the plan-only contract.
      const call = aiCalls[aiCalls.length - 1];
      assert.strictEqual(call.prompt, question, 'the question must be the prompt');
      assert.ok(typeof call.system === 'string' && call.system.length > 0, 'a fixed system prompt must be sent');
      for (const op of ['js_analysis', 'go_binary', 'rust_binary']) {
        assert.ok(call.system.includes(op), `system prompt must name the ${op} operation`);
      }
      assert.ok(/never/i.test(call.system), 'system prompt must forbid execution');
      assert.ok(/propos/i.test(call.system), 'system prompt must state it only proposes');
    });

    // ---- State: invalid_plan ------------------------------------------------
    await checkAsync('test_ai_plan_non_json_response_returns_invalid_plan', async () => {
      aiConfigured = true;
      queueAi({ kind: 'text', text: 'Desculpe, nao consigo gerar um plano para essa pergunta.' });
      const res = await postPlan(viewToken, { question: 'Analisa o modulo principal desta aplicacao' });
      assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
      const body = await readPlan(res);
      assert.strictEqual(body.success, true, JSON.stringify(body));
      assert.deepStrictEqual(body.data, { state: 'invalid_plan' }, JSON.stringify(body));
    });

    await checkAsync('test_ai_plan_schema_violations_return_invalid_plan', async () => {
      aiConfigured = true;
      const invalid: Array<[string, unknown]> = [
        ['unknown op', { steps: [{ op: 'shell', risk: 'low', needsApproval: false }] }],
        ['unknown risk', { steps: [{ op: 'js_analysis', risk: 'critical', needsApproval: false }] }],
        ['non-boolean needsApproval', { steps: [{ op: 'js_analysis', risk: 'low', needsApproval: 'yes' }] }],
        [
          'extra field on a step',
          { steps: [{ op: 'js_analysis', risk: 'low', needsApproval: false, notes: 'extra shape' }] },
        ],
        ['extra field on the envelope', { steps: [{ op: 'js_analysis', risk: 'low', needsApproval: false }], notes: 'extra' }],
        ['missing steps', {}],
        ['steps is not an array', { steps: 'js_analysis' }],
        ['envelope is an array', []],
        ['fenced JSON is not raw JSON', null],
      ];
      for (const [label, payload] of invalid) {
        const text =
          payload === null
            ? '```json\n{"steps":[{"op":"js_analysis","risk":"low","needsApproval":false}]}\n```'
            : JSON.stringify(payload);
        queueAi({ kind: 'text', text });
        const res = await postPlan(viewToken, { question: 'Analisa este artefacto e lista os passos' });
        assert.strictEqual(res.status, 200, `${label}: expected 200, got ${res.status}`);
        const body = await readPlan(res);
        assert.strictEqual(body.success, true, label);
        assert.deepStrictEqual(body.data, { state: 'invalid_plan' }, `${label}: ${JSON.stringify(body)}`);
      }
    });

    // ---- Security invariant -------------------------------------------------
    await checkAsync('test_ai_plan_never_creates_jobs', async () => {
      const jobInserts = sqlCalls.filter((call) => /INSERT\s+INTO\s+cyberlab_jobs/i.test(call.sql));
      assert.strictEqual(
        jobInserts.length,
        0,
        `the plan endpoint must never INSERT into cyberlab_jobs: ${JSON.stringify(jobInserts)}`
      );
      const jobTouches = sqlCalls.filter((call) => /cyberlab_jobs/i.test(call.sql));
      assert.strictEqual(jobTouches.length, 0, `plan must not touch cyberlab_jobs at all: ${JSON.stringify(jobTouches)}`);
      const successBodies = planBodies.filter((body) => body && body.success === true);
      assert.ok(successBodies.length >= 6, `expected the successful plan responses, got ${successBodies.length}`);
      for (const body of successBodies) {
        assert.ok(!('job' in body.data), `a plan response must not carry a job: ${JSON.stringify(body)}`);
        // An error state carries the reason and nothing else; every other
        // state carries the plan and nothing else.
        const allowed = body.data.state === 'error' ? ['state', 'message'] : ['state', 'steps'];
        for (const key of Object.keys(body.data)) {
          assert.ok(
            allowed.includes(key),
            `unexpected key '${key}' in plan response: ${JSON.stringify(body)}`
          );
        }
      }
      assert.ok(aiCalls.length >= 8, `expected the scripted AI calls to have run, got ${aiCalls.length}`);
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

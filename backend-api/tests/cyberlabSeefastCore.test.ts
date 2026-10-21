/**
 * RED->GREEN gate for Task 2 — seefast core: limits + capabilities + adapter.
 *
 * Design notes: same FakePool harness as tests/networkDiscovery.test.ts (a
 * stubbed pg.Pool installed in require.cache before config/database loads) so
 * getLimits() reads scripted app_settings rows; child_process.execFile is
 * swapped through require.cache the same way, so every probe/adapter call is
 * captured in-process and nothing is ever spawned.
 * Covers brief assertions (a)-(e) + controller rulings (env > settings >
 * defaults precedence, invalidateLimitsCache PUT-simulation).
 * Run: npx tsx tests/cyberlabSeefastCore.test.ts
 */
import './testEnv';
import assert from 'assert';
import type { SeefastLimits } from '../src/services/seefast/limits';
import type { JobType } from '../src/services/seefast/adapter';

type LimitsModule = typeof import('../src/services/seefast/limits');
type CapabilitiesModule = typeof import('../src/services/seefast/capabilities');
type AdapterModule = typeof import('../src/services/seefast/adapter');

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

// ---- Fake execFile (require.cache, installed before seefast modules load) --
type ExecCall = { file: string; args: string[]; options: Record<string, unknown> };
type ExecScript = { error: Error | null; stdout?: string; stderr?: string };

const execCalls: ExecCall[] = [];
let execScript: ExecScript | null = null;
const setExecScript = (next: ExecScript | null): void => {
  execScript = next;
};

function fakeExecFile(
  file: string,
  args: string[],
  options: Record<string, unknown>,
  callback?: (error: Error | null, stdout: string, stderr: string) => void
): void {
  execCalls.push({ file, args, options });
  if (!callback) return;
  const script = execScript;
  if (!script) {
    // Unscripted call: fail loudly at the assertion layer instead of hanging.
    setImmediate(() => callback(new Error('unexpected execFile call (no script)'), '', ''));
    return;
  }
  setImmediate(() => callback(script.error, script.stdout ?? '', script.stderr ?? ''));
}

const cpPath = require.resolve('child_process');
const realCp = require(cpPath) as Record<string, unknown>;
realCp.execFile = fakeExecFile;
(require.cache as unknown as Record<string, unknown>)[cpPath] = { exports: realCp, loaded: true };

// ---- Fake pg (installed before config/database is first required) --------
let appSettingsRows: Record<string, unknown>[] = [];
const settingsQueries: Array<{ sql: string; params: unknown[] }> = [];

const respond = (sql: string, params: unknown[] = []) => {
  if (sql.includes('FROM app_settings WHERE key = ANY')) {
    settingsQueries.push({ sql, params });
    return { rows: appSettingsRows, rowCount: appSettingsRows.length };
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDatabase } = require('../src/config/database') as {
  initDatabase: () => Promise<void>;
};

function loadModule(name: string, loader: () => unknown): unknown {
  try {
    return loader();
  } catch {
    console.error(`      (module ${name} could not be loaded)`);
    return null;
  }
}

const CLI = 'C:\\engine\\seefast-cli.exe';
const ARTIFACT = 'C:\\cyberlab\\artifacts\\demo.js';
const DEFAULT_LIMITS: SeefastLimits = {
  maxArtifactBytes: 25 * 1024 * 1024,
  jobTimeoutMs: 120_000,
  maxStdoutBytes: 5 * 1024 * 1024,
  maxConcurrentJobs: 1,
};

async function main(): Promise<void> {
  await initDatabase();

  delete process.env.CYBERLAB_MAX_ARTIFACT_MB;
  delete process.env.CYBERLAB_JOB_TIMEOUT_S;
  delete process.env.CYBERLAB_MAX_CONCURRENT;
  delete process.env.CYBERLAB_MAX_STDOUT_MB;
  delete process.env.SEEFAST_CLI;

  const limitsMod = loadModule('limits.ts', () => require('../src/services/seefast/limits')) as LimitsModule | null;
  const capsMod = loadModule('capabilities.ts', () => require('../src/services/seefast/capabilities')) as
    | CapabilitiesModule
    | null;
  const adapterMod = loadModule('adapter.ts', () => require('../src/services/seefast/adapter')) as AdapterModule | null;

  // (a) defaults when no env and no settings rows
  await checkAsync('test_get_limits_returns_exact_defaults_without_env', async () => {
    const { getLimits, invalidateLimitsCache } = limitsMod as LimitsModule;
    appSettingsRows = [];
    invalidateLimitsCache();
    const limits = await getLimits();
    assert.deepStrictEqual(limits, DEFAULT_LIMITS, `expected the 4 exact defaults, got ${JSON.stringify(limits)}`);
  });

  // Ruling 2: settings values are MB/seconds/jobs, converted internally
  await checkAsync('test_get_limits_applies_settings_values_with_conversion', async () => {
    const { getLimits, invalidateLimitsCache } = limitsMod as LimitsModule;
    appSettingsRows = [
      { key: 'cyberlab_max_artifact_mb', value: '10' },
      { key: 'cyberlab_job_timeout_s', value: '60' },
      { key: 'cyberlab_max_concurrent', value: '2' },
    ];
    invalidateLimitsCache();
    settingsQueries.length = 0;
    const limits = await getLimits();
    assert.deepStrictEqual(
      limits,
      {
        maxArtifactBytes: 10 * 1024 * 1024,
        jobTimeoutMs: 60_000,
        maxStdoutBytes: 5 * 1024 * 1024, // no settings key for stdout — env/default only
        maxConcurrentJobs: 2,
      },
      `settings must convert MB/s → bytes/ms: ${JSON.stringify(limits)}`
    );
    assert.strictEqual(settingsQueries.length, 1, 'expected exactly one settings round trip per cache refresh');
    assert.deepStrictEqual(
      settingsQueries[0].params[0],
      ['cyberlab_max_artifact_mb', 'cyberlab_job_timeout_s', 'cyberlab_max_concurrent'],
      'settings keys must be read exactly as ruled'
    );

    appSettingsRows = [
      { key: 'cyberlab_max_artifact_mb', value: 'abc' },
      { key: 'cyberlab_job_timeout_s', value: '0' },
      { key: 'cyberlab_max_concurrent', value: '-3' },
    ];
    invalidateLimitsCache();
    const unparsable = await getLimits();
    assert.deepStrictEqual(unparsable, DEFAULT_LIMITS, `unparsable settings must fall back to defaults: ${JSON.stringify(unparsable)}`);
  });

  // Ruling 3: PUT /config writes a settings row → invalidateLimitsCache() must make GET reflect it
  await checkAsync('test_put_simulation_needs_invalidate_to_see_new_settings', async () => {
    const { getLimits, invalidateLimitsCache } = limitsMod as LimitsModule;
    appSettingsRows = [{ key: 'cyberlab_job_timeout_s', value: '60' }];
    invalidateLimitsCache();
    assert.strictEqual((await getLimits()).jobTimeoutMs, 60_000, 'seed value must be visible');

    appSettingsRows = [{ key: 'cyberlab_job_timeout_s', value: '300' }];
    const stale = await getLimits();
    assert.strictEqual(stale.jobTimeoutMs, 60_000, 'the warm cache must still serve the old value');

    invalidateLimitsCache(); // what Task 6's PUT /config calls after writing
    const fresh = await getLimits();
    assert.strictEqual(fresh.jobTimeoutMs, 300_000, 'after invalidation the new settings row must be visible');
    appSettingsRows = [];
    invalidateLimitsCache();
  });

  // Ruling 1: env CYBERLAB_* wins over settings cyberlab_*
  await checkAsync('test_env_overrides_settings_for_limits', async () => {
    const { getLimits, invalidateLimitsCache } = limitsMod as LimitsModule;
    appSettingsRows = [
      { key: 'cyberlab_max_artifact_mb', value: '10' },
      { key: 'cyberlab_job_timeout_s', value: '60' },
      { key: 'cyberlab_max_concurrent', value: '2' },
    ];
    process.env.CYBERLAB_MAX_ARTIFACT_MB = '7';
    process.env.CYBERLAB_JOB_TIMEOUT_S = '99';
    process.env.CYBERLAB_MAX_CONCURRENT = '4';
    process.env.CYBERLAB_MAX_STDOUT_MB = '3';
    invalidateLimitsCache();
    const limits = await getLimits();
    assert.deepStrictEqual(
      limits,
      {
        maxArtifactBytes: 7 * 1024 * 1024,
        jobTimeoutMs: 99_000,
        maxStdoutBytes: 3 * 1024 * 1024,
        maxConcurrentJobs: 4,
      },
      `env must beat settings on every knob: ${JSON.stringify(limits)}`
    );
    delete process.env.CYBERLAB_MAX_ARTIFACT_MB;
    delete process.env.CYBERLAB_JOB_TIMEOUT_S;
    delete process.env.CYBERLAB_MAX_CONCURRENT;
    delete process.env.CYBERLAB_MAX_STDOUT_MB;
    appSettingsRows = [];
    invalidateLimitsCache();
  });

  // (b) probe without SEEFAST_CLI → not_configured, spawn never called
  await checkAsync('test_probe_without_cli_is_not_configured_and_never_spawns', async () => {
    const { probeCapabilities } = capsMod as CapabilitiesModule;
    delete process.env.SEEFAST_CLI;
    execCalls.length = 0;
    const status = await probeCapabilities();
    assert.deepStrictEqual(
      status,
      { available: false, reason: 'not_configured', version: null, detail: null },
      `unexpected status: ${JSON.stringify(status)}`
    );
    assert.strictEqual(execCalls.length, 0, 'probe must never spawn without SEEFAST_CLI');
  });

  // probe success → available + version parsed from --json output
  await checkAsync('test_probe_success_reports_available_and_version', async () => {
    const { probeCapabilities } = capsMod as CapabilitiesModule;
    process.env.SEEFAST_CLI = CLI;
    execCalls.length = 0;
    setExecScript({ error: null, stdout: '{"version":"1.4.2","targets":["js"]}', stderr: '' });
    const status = await probeCapabilities();
    assert.deepStrictEqual(
      status,
      { available: true, reason: null, version: '1.4.2', detail: null },
      `unexpected status: ${JSON.stringify(status)}`
    );
    assert.strictEqual(execCalls.length, 1, 'exactly one probe invocation');
    assert.deepStrictEqual(
      execCalls[0],
      { file: CLI, args: ['capabilities', '--json'], options: { timeout: 15000 } },
      'probe must execFile the CLI with the documented argv and timeout, never shell'
    );

    setExecScript({ error: null, stdout: 'plain build output', stderr: '' });
    const noJson = await probeCapabilities();
    assert.deepStrictEqual(
      noJson,
      { available: true, reason: null, version: null, detail: null },
      `non-JSON output must yield version null, never a guess: ${JSON.stringify(noJson)}`
    );
    setExecScript(null);
    delete process.env.SEEFAST_CLI;
  });

  // (d) probe with env but exit 1 → probe_failed + detail ≤200 chars, no internal paths
  await checkAsync('test_probe_exit_1_is_probe_failed_with_sanitized_detail', async () => {
    const { probeCapabilities } = capsMod as CapabilitiesModule;
    process.env.SEEFAST_CLI = CLI;
    execCalls.length = 0;
    const raw = `engine refused probe at ${CLI}: ${'x'.repeat(400)}`;
    setExecScript({ error: Object.assign(new Error(raw), { code: 1 }), stdout: '', stderr: '' });
    const status = await probeCapabilities();
    setExecScript(null);
    delete process.env.SEEFAST_CLI;

    assert.strictEqual(status.available, false, 'failed probe must not report available');
    assert.strictEqual(status.reason, 'probe_failed');
    assert.strictEqual(status.version, null);
    assert.ok(status.detail, 'probe_failed must carry a detail');
    assert.ok(status.detail!.length <= 200, `detail must be ≤200 chars, got ${status.detail!.length}`);
    assert.ok(!status.detail!.includes(CLI), `detail must not leak the engine path: ${status.detail}`);
    assert.strictEqual(execCalls.length, 1, 'probe with env must spawn exactly once');
    assert.deepStrictEqual(
      execCalls[0],
      { file: CLI, args: ['capabilities', '--json'], options: { timeout: 15000 } },
      'probe argv/options must match the brief exactly'
    );
  });

  // (c) allowlisted argv, verbatim
  check('test_job_ops_returns_exact_argv_for_the_three_types', () => {
    const { JOB_OPS } = adapterMod as AdapterModule;
    assert.deepStrictEqual(JOB_OPS.js_analysis('/tmp/app.js'), [
      'analyze-javascript-application',
      '/tmp/app.js',
      '--json',
    ]);
    assert.deepStrictEqual(JOB_OPS.go_binary('/tmp/tool.bin'), ['inspect-go-binary', '/tmp/tool.bin', '--json']);
    assert.deepStrictEqual(JOB_OPS.rust_binary('/tmp/tool.bin'), ['inspect-rust-binary', '/tmp/tool.bin', '--json']);
    assert.strictEqual(
      (JOB_OPS as unknown as Record<string, unknown>)['shell_exec'],
      undefined,
      'unknown types must be undefined in JOB_OPS'
    );
  });

  // (c) unknown type → runOperation throws Error('UNSUPPORTED_OPERATION')
  await checkAsync('test_run_operation_rejects_types_outside_the_allowlist', async () => {
    const { runOperation } = adapterMod as AdapterModule;
    await assert.rejects(
      () => runOperation('shell_exec' as JobType, ARTIFACT, DEFAULT_LIMITS),
      (error: Error) => error.message === 'UNSUPPORTED_OPERATION',
      'unknown job type must throw UNSUPPORTED_OPERATION'
    );
    await assert.rejects(
      () => runOperation('constructor' as JobType, ARTIFACT, DEFAULT_LIMITS),
      (error: Error) => error.message === 'UNSUPPORTED_OPERATION',
      'inherited Object keys must not slip through the allowlist'
    );
  });

  process.env.SEEFAST_CLI = CLI;

  // (e) exit 0 → ok
  await checkAsync('test_run_operation_exit_zero_maps_ok_run', async () => {
    const { runOperation } = adapterMod as AdapterModule;
    execCalls.length = 0;
    setExecScript({ error: null, stdout: '{"status":"ok"}', stderr: 'warn: heuristic' });
    const run = await runOperation('js_analysis', ARTIFACT, DEFAULT_LIMITS);
    setExecScript(null);
    assert.deepStrictEqual(
      {
        exitCode: run.exitCode,
        signal: run.signal,
        truncated: run.truncated,
        timedOut: run.timedOut,
        stdout: run.stdout,
      },
      { exitCode: 0, signal: null, truncated: false, timedOut: false, stdout: '{"status":"ok"}' },
      `unexpected run: ${JSON.stringify(run)}`
    );
    assert.strictEqual(run.stderrTail, 'warn: heuristic', 'stderr tail must be kept');
    assert.ok(typeof run.durationMs === 'number' && run.durationMs >= 0, 'durationMs must be measured');
    assert.deepStrictEqual(
      execCalls[0],
      {
        file: CLI,
        args: ['analyze-javascript-application', ARTIFACT, '--json'],
        options: { timeout: 120_000, killSignal: 'SIGTERM', maxBuffer: 5 * 1024 * 1024 },
      },
      'runOperation must pass limits into execFile (argv array, never shell)'
    );
  });

  // (e) exit 1 → {exitCode: 1}
  await checkAsync('test_run_operation_exit_1_maps_exit_code', async () => {
    const { runOperation } = adapterMod as AdapterModule;
    execCalls.length = 0;
    setExecScript({
      error: Object.assign(new Error('Command failed'), { code: 1 }),
      stdout: '',
      stderr: 'unsupported construct',
    });
    const run = await runOperation('go_binary', ARTIFACT, DEFAULT_LIMITS);
    setExecScript(null);
    assert.strictEqual(run.exitCode, 1, `expected exitCode 1, got ${JSON.stringify(run)}`);
    assert.strictEqual(run.signal, null);
    assert.strictEqual(run.timedOut, false);
    assert.strictEqual(run.truncated, false);
    assert.strictEqual(run.stderrTail, 'unsupported construct');
    assert.deepStrictEqual(execCalls[0].args, ['inspect-go-binary', ARTIFACT, '--json']);
  });

  // (e) SIGTERM / exit 143 → {signal: 'SIGTERM'}
  await checkAsync('test_run_operation_signal_sigterm_maps_signal', async () => {
    const { runOperation } = adapterMod as AdapterModule;
    execCalls.length = 0;
    setExecScript({
      error: Object.assign(new Error('killed'), { code: null, signal: 'SIGTERM', killed: false }),
      stdout: '',
      stderr: '',
    });
    const run = await runOperation('rust_binary', ARTIFACT, DEFAULT_LIMITS);
    assert.strictEqual(run.signal, 'SIGTERM', `expected signal SIGTERM, got ${JSON.stringify(run)}`);
    assert.strictEqual(run.exitCode, null);
    assert.strictEqual(run.timedOut, false, 'an external kill is not a timeout');
    assert.deepStrictEqual(execCalls[0].args, ['inspect-rust-binary', ARTIFACT, '--json']);

    setExecScript({
      error: Object.assign(new Error('Command failed'), { code: 143, killed: false }),
      stdout: '',
      stderr: '',
    });
    const shellStyle = await runOperation('rust_binary', ARTIFACT, DEFAULT_LIMITS);
    setExecScript(null);
    assert.strictEqual(shellStyle.signal, 'SIGTERM', 'exit 143 (128+SIGTERM) must report as SIGTERM');
    assert.strictEqual(shellStyle.exitCode, null);
  });

  // (e) stdout > maxBuffer → truncated:true with partial stdout preserved
  await checkAsync('test_run_operation_max_buffer_overflow_truncates', async () => {
    const { runOperation } = adapterMod as AdapterModule;
    const partial = 'a'.repeat(2048);
    setExecScript({
      error: Object.assign(new Error('stdout maxBuffer length exceeded'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      }),
      stdout: partial,
      stderr: '',
    });
    const run = await runOperation('js_analysis', ARTIFACT, DEFAULT_LIMITS);
    setExecScript(null);
    assert.strictEqual(run.truncated, true, `expected truncated:true, got ${JSON.stringify(run)}`);
    assert.strictEqual(run.stdout, partial, 'the partial stdout must be preserved for the job record');
    assert.strictEqual(run.exitCode, null);
    assert.strictEqual(run.timedOut, false);
    assert.ok(run.stderrTail.length <= 4096, 'stderrTail must never exceed 4096 chars');
  });

  // timeout → timedOut:true (interface requirement of runOperation)
  await checkAsync('test_run_operation_timeout_marks_timed_out', async () => {
    const { runOperation } = adapterMod as AdapterModule;
    setExecScript({
      error: Object.assign(new Error('Command failed'), { code: null, signal: 'SIGTERM', killed: true }),
      stdout: '',
      stderr: '',
    });
    const run = await runOperation('js_analysis', ARTIFACT, DEFAULT_LIMITS);
    setExecScript(null);
    assert.strictEqual(run.timedOut, true, `expected timedOut:true, got ${JSON.stringify(run)}`);
    assert.strictEqual(run.signal, 'SIGTERM');
    assert.strictEqual(run.truncated, false);
    assert.strictEqual(run.exitCode, null);
  });

  // stderr tail cap holds on a very long stderr
  await checkAsync('test_run_operation_stderr_is_tailed_to_4096_chars', async () => {
    const { runOperation } = adapterMod as AdapterModule;
    const longStderr = 'e'.repeat(10_000);
    setExecScript({
      error: Object.assign(new Error('Command failed'), { code: 2 }),
      stdout: '',
      stderr: longStderr,
    });
    const run = await runOperation('js_analysis', ARTIFACT, DEFAULT_LIMITS);
    setExecScript(null);
    assert.strictEqual(run.exitCode, 2);
    assert.strictEqual(run.stderrTail.length, 4096, `stderrTail must be the last 4096 chars, got ${run.stderrTail.length}`);
    assert.strictEqual(run.stderrTail, longStderr.slice(-4096));
  });

  delete process.env.SEEFAST_CLI;

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

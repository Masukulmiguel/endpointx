import { execFile } from 'child_process';
import type { SeefastLimits } from './limits';

/**
 * Adapter around the external engine CLI (operator-supplied binary via the
 * `SEEFAST_CLI` env var). Invocations are `execFile` with an argv array —
 * never a shell, never interpolation — restricted to the operation allowlist
 * below. Static analysis only: the engine is pointed at a server-stored
 * artifact path, nothing else.
 */

export type JobType = 'js_analysis' | 'go_binary' | 'rust_binary';

export const JOB_OPS: Record<JobType, (path: string) => string[]> = {
  js_analysis: (path) => ['analyze-javascript-application', path, '--json'],
  go_binary: (path) => ['inspect-go-binary', path, '--json'],
  rust_binary: (path) => ['inspect-rust-binary', path, '--json'],
};

export type RawRun = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderrTail: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
};

const STDERR_TAIL_CHARS = 4096;
const SHELL_EXIT_SIGTERM = 143; // 128 + SIGTERM, how a shell would report the kill

function sanitizeErrorDetail(raw: string, cli: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  const redacted = cli ? oneLine.split(cli).join('SEEFAST_CLI') : oneLine;
  return redacted.length > STDERR_TAIL_CHARS ? redacted.slice(0, STDERR_TAIL_CHARS) : redacted;
}

function toRawRun(
  error: Error | null,
  stdout: string | Buffer,
  stderr: string | Buffer,
  durationMs: number,
  cli: string
): RawRun {
  const out = stdout === undefined || stdout === null ? '' : String(stdout);
  const errOut = stderr === undefined || stderr === null ? '' : String(stderr);

  const code = (error as { code?: unknown } | null)?.code;
  const truncated = code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  const killed = (error as { killed?: unknown } | null)?.killed === true;
  const errSignal = (error as { signal?: unknown } | null)?.signal;

  const numericExit = typeof code === 'number' ? code : null;
  let exitCode = error === null ? 0 : numericExit;
  let signal = typeof errSignal === 'string' ? (errSignal as NodeJS.Signals) : null;
  if (signal === null && exitCode === SHELL_EXIT_SIGTERM) {
    signal = 'SIGTERM';
    exitCode = null;
  }
  const timedOut = error !== null && !truncated && killed;

  let stderrTail = errOut.slice(-STDERR_TAIL_CHARS);
  if (error !== null && stderrTail === '' && exitCode === null && signal === null && !truncated && !killed) {
    // Spawn-level failure (the binary never ran): keep a redacted tail so the
    // job record explains itself instead of failing with an empty error.
    stderrTail = sanitizeErrorDetail(error.message || 'engine run failed', cli);
  }

  return { exitCode, signal, stdout: out, stderrTail, truncated, timedOut, durationMs };
}

/** Run one allowlisted operation. Throws on types outside the allowlist. */
export async function runOperation(
  type: JobType,
  artifactPath: string,
  limits: SeefastLimits
): Promise<RawRun> {
  const buildArgs = Object.prototype.hasOwnProperty.call(JOB_OPS, type) ? JOB_OPS[type] : undefined;
  if (typeof buildArgs !== 'function') throw new Error('UNSUPPORTED_OPERATION');

  const cli = (process.env.SEEFAST_CLI || '').trim();
  if (!cli) throw new Error('SEEFAST_CLI_NOT_CONFIGURED');

  const args = buildArgs(artifactPath);
  const startedAt = Date.now();

  return new Promise<RawRun>((resolve) => {
    const done = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer): void => {
      resolve(toRawRun(error, stdout, stderr, Date.now() - startedAt, cli));
    };
    try {
      execFile(
        cli,
        args,
        { timeout: limits.jobTimeoutMs, killSignal: 'SIGTERM', maxBuffer: limits.maxStdoutBytes },
        done
      );
    } catch (error) {
      done(error as Error, '', '');
    }
  });
}

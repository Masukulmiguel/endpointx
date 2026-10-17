import crypto from 'crypto';
import { query } from '../../config/database';
import logger from '../../utils/logger';
import { JOB_OPS, runOperation, JobType, RawRun } from './adapter';
import { getLimits, SeefastLimits } from './limits';

/**
 * In-process job lifecycle runner (no external queue — the repo pattern):
 * `queued → running → completed | failed | cancelled | partial`.
 *
 * Concurrency is capped at `getLimits().maxConcurrentJobs`: the slot check and
 * the `running` insert are one conditional statement, so a second near-
 * simultaneous start lands in `queued` and is promoted FIFO (oldest first) by
 * `promoteQueued()` on every completion. Cancellation is cooperative:
 * `cancel_requested` in the DB plus SIGTERM to the exact ChildProcess held in
 * the Map below; the process's `close` decides the final state (a cancel
 * requested mid-kill always wins over the exit code). The adapter creates no
 * temp files (it runs over the stored artifact), so `finally` only removes
 * the process from the Map — artifacts persist as evidence.
 */

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial';

export type JobRow = {
  id: string;
  type: string;
  status: string;
  target_ref: string | null;
  result: unknown;
  error: string | null;
  progress: number;
  cancel_requested: boolean;
  started_by: string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
};

/** Route-mappable failure raised by the runner (never leaks to a 500). */
export class JobsRunnerError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'JobsRunnerError';
  }
}

const MAX_ERROR_CHARS = 500;

function newId(): string {
  return crypto.randomUUID();
}

/** ≤500 chars, no internal paths: engine path → SEEFAST_CLI, storage path → artifact. */
function sanitizeErrorMessage(raw: string, artifactPath: string | null): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  const cli = (process.env.SEEFAST_CLI || '').trim();
  if (cli) text = text.split(cli).join('SEEFAST_CLI');
  if (artifactPath) text = text.split(artifactPath).join('artifact');
  if (text.length > MAX_ERROR_CHARS) text = text.slice(0, MAX_ERROR_CHARS);
  return text || 'engine run failed';
}

async function auditJob(action: string, jobId: string, actorId: string | null, description: string): Promise<void> {
  try {
    await query(
      'INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [newId(), actorId, null, action, 'cyberlab_job', jobId, description, null]
    );
  } catch (error) {
    // The state transition already happened; an audit hiccup must not undo it.
    logger.warn('cyberlab job audit write failed', { action, error: (error as Error).message });
  }
}

// Exact ChildProcess per running job, so cancelJob SIGTERMs the right process.
type Killable = { kill: (signal: NodeJS.Signals) => boolean };
const runningProcesses = new Map<string, Killable>();

/**
 * In-process FIFO lock for the slot decision (count → insert). The runner is
 * single-process, so serialising start-vs-queue and promote-vs-start here
 * closes the READ COMMITTED window where two truly simultaneous requests
 * could both read `running < max` and both insert a running row.
 */
let slotLock: Promise<unknown> = Promise.resolve();
function withSlotLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = slotLock.then(fn);
  slotLock = next.catch(() => undefined);
  return next;
}

/**
 * runOperation's signature is fixed by Task 2 and does not expose the child
 * it spawns, so the ChildProcess is captured here by wrapping
 * child_process.execFile for the synchronous duration of the call (the
 * adapter invokes execFile before its returned promise can settle). The wrap
 * is always restored in `finally`.
 */
async function startRun(jobId: string, type: JobType, artifactPath: string, limits: SeefastLimits): Promise<RawRun> {
  /* eslint-disable-next-line @typescript-eslint/no-var-requires */
  const cp = require('child_process') as { execFile: (...args: unknown[]) => unknown };
  const original = cp.execFile;
  let captured: Killable | null = null;
  cp.execFile = (...args: unknown[]) => {
    const child = original(...args) as { kill?: unknown } | undefined;
    if (child && typeof child.kill === 'function') captured = child as Killable;
    return child;
  };
  let run: Promise<RawRun>;
  try {
    run = runOperation(type, artifactPath, limits);
  } finally {
    cp.execFile = original;
  }
  if (captured) {
    runningProcesses.set(jobId, captured);
    // Cancel may have landed between the pre-start check and the spawn.
    const flag = await query('SELECT cancel_requested FROM cyberlab_jobs WHERE id = $1', [jobId]);
    if (flag.rows[0]?.cancel_requested === true) {
      try {
        captured.kill('SIGTERM');
      } catch {
        // Already dead — the close watcher still decides the final state.
      }
    }
  }
  return run;
}

function parseStdout(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return { raw: stdout };
  }
}

type FinalOutcome = { status: 'completed' | 'failed' | 'cancelled' | 'partial'; result?: unknown; error?: string | null };

function mapRunToOutcome(raw: RawRun, artifactPath: string): FinalOutcome {
  if (raw.timedOut) return { status: 'failed', error: 'TIMEOUT' };
  if (raw.signal !== null) return { status: 'cancelled' };
  if (raw.truncated) return { status: 'partial', result: { truncated: true } };
  if (raw.exitCode === 0) return { status: 'completed', result: parseStdout(raw.stdout) };
  const detail = raw.stderrTail && raw.stderrTail.trim() ? raw.stderrTail : `engine exited with code ${raw.exitCode}`;
  return { status: 'failed', error: sanitizeErrorMessage(detail, artifactPath) };
}

/**
 * Store the final state, remove the process from the Map, promote the next
 * queued job. `cancel_requested` wins over the computed outcome — the close
 * watcher is the single decider when a kill lands mid-run. Task 5 hooks the
 * findings normalisation here; today `result` is stored as-is.
 */
async function finalize(jobId: string, outcome: FinalOutcome, artifactPath: string | null): Promise<void> {
  try {
    const flag = await query('SELECT cancel_requested FROM cyberlab_jobs WHERE id = $1', [jobId]);
    const cancelRequested = flag.rows[0]?.cancel_requested === true;
    const status = cancelRequested ? 'cancelled' : outcome.status;
    const error = status === 'cancelled' ? null : (outcome.error ?? null);
    const result = status === 'cancelled' ? null : (outcome.result ?? null);
    const updated = await query(
      `UPDATE cyberlab_jobs SET status = $2, error = $3, result = $4, finished_at = NOW() WHERE id = $1 AND status = 'running'`,
      [jobId, status, error, result]
    );
    if (updated.rowCount > 0 && status === 'cancelled') {
      // Audit only the actual running → cancelled transition.
      await auditJob('cyberlab.job_cancelled', jobId, null, 'Job cancelled during execution');
    }
  } catch (error) {
    logger.error('cyberlab job finalize failed', { jobId, error: (error as Error).message });
  } finally {
    runningProcesses.delete(jobId);
    await promoteQueued();
  }
}

async function executeJob(jobId: string, type: JobType): Promise<void> {
  let artifactPath: string | null = null;
  try {
    const pathRows = await query(
      `SELECT a.storage_path FROM cyberlab_jobs j JOIN cyberlab_artifacts a ON a.id::text = j.target_ref WHERE j.id = $1`,
      [jobId]
    );
    artifactPath = pathRows.rows[0]?.storage_path ?? null;
    if (!artifactPath) {
      await finalize(jobId, { status: 'failed', error: 'artifact for this job no longer exists' }, null);
      return;
    }

    const pre = await query('SELECT cancel_requested FROM cyberlab_jobs WHERE id = $1', [jobId]);
    if (pre.rows[0]?.cancel_requested === true) {
      await finalize(jobId, { status: 'cancelled' }, artifactPath);
      return;
    }

    const limits = await getLimits();
    let raw: RawRun;
    try {
      raw = await startRun(jobId, type, artifactPath, limits);
    } catch (error) {
      // Defensive mapping (ruling 2): the provider gate makes this
      // unreachable in practice, but SEEFAST_CLI_NOT_CONFIGURED must never
      // surface raw — it becomes a normal failed job with that code.
      const message = (error as Error).message || 'engine run failed';
      const sanitized = message.includes('SEEFAST_CLI_NOT_CONFIGURED')
        ? 'SEEFAST_CLI_NOT_CONFIGURED'
        : sanitizeErrorMessage(message, artifactPath);
      await finalize(jobId, { status: 'failed', error: sanitized }, artifactPath);
      return;
    }

    await finalize(jobId, mapRunToOutcome(raw, artifactPath), artifactPath);
  } catch (error) {
    logger.error('cyberlab job execution failed', { jobId, error: (error as Error).message });
    await finalize(
      jobId,
      { status: 'failed', error: sanitizeErrorMessage((error as Error).message || 'job execution failed', artifactPath) },
      artifactPath
    );
  } finally {
    // The adapter creates no temp files; the Map entry is the only thing to drop.
    runningProcesses.delete(jobId);
  }
}

/**
 * Create a job: allowlisted type (else 400 UNSUPPORTED_OPERATION), existing
 * artifact (else 404), then a single conditional INSERT decides running
 * (free slot: started_at + audit + scheduled execution) vs queued.
 */
export async function createJob(
  input: { type: JobType; artifactId: string },
  actorId: string | null
): Promise<{ job: JobRow; started: boolean }> {
  const { type, artifactId } = input;
  if (!Object.prototype.hasOwnProperty.call(JOB_OPS, type)) {
    throw new JobsRunnerError(`Unsupported operation type: ${String(type).slice(0, 50)}`, 'UNSUPPORTED_OPERATION', 400);
  }

  const artifact = await query('SELECT id FROM cyberlab_artifacts WHERE id = $1', [artifactId]);
  if (artifact.rowCount === 0) {
    throw new JobsRunnerError('Artifact not found', 'ARTIFACT_NOT_FOUND', 404);
  }

  const limits = await getLimits();
  return withSlotLock(async () => {
    const startedInsert = await query(
      `INSERT INTO cyberlab_jobs (type, status, target_ref, started_by, started_at)
       SELECT $1, 'running', $2, $3, NOW()
       WHERE (SELECT COUNT(*) FROM cyberlab_jobs WHERE status = 'running') < $4
       RETURNING *`,
      [type, artifactId, actorId, limits.maxConcurrentJobs]
    );
    if (startedInsert.rowCount > 0) {
      const job = startedInsert.rows[0] as JobRow;
      await auditJob('cyberlab.job_started', job.id, actorId, `Job started: ${type}`);
      setImmediate(() => {
        void executeJob(job.id, type);
      });
      return { job, started: true };
    }

    const queuedInsert = await query(
      `INSERT INTO cyberlab_jobs (type, status, target_ref, started_by) VALUES ($1, 'queued', $2, $3) RETURNING *`,
      [type, artifactId, actorId]
    );
    return { job: queuedInsert.rows[0] as JobRow, started: false };
  });
}

/**
 * Request cancellation. `queued` → direct `cancelled` (audited here).
 * `running` → set `cancel_requested` and SIGTERM the exact child from the
 * Map; the close watcher finalises to `cancelled` and audits the transition.
 * Returns `already_finished` when the job beat us to a terminal state.
 */
export async function cancelJob(id: string, actorId: string | null): Promise<'cancelled' | 'not_found' | 'already_finished'> {
  const existing = await query('SELECT id, status FROM cyberlab_jobs WHERE id = $1', [id]);
  const row = existing.rows[0] as { id: string; status: string } | undefined;
  if (!row) return 'not_found';
  if (row.status !== 'queued' && row.status !== 'running') return 'already_finished';

  if (row.status === 'queued') {
    const updated = await query(
      `UPDATE cyberlab_jobs SET status = 'cancelled', finished_at = NOW() WHERE id = $1 AND status = 'queued' RETURNING id`,
      [id]
    );
    if (updated.rowCount === 0) return 'already_finished'; // finished between the read and the update
    await auditJob('cyberlab.job_cancelled', id, actorId, 'Job cancelled while queued');
    return 'cancelled';
  }

  const flagged = await query(
    `UPDATE cyberlab_jobs SET cancel_requested = TRUE WHERE id = $1 AND status = 'running' RETURNING id`,
    [id]
  );
  if (flagged.rowCount === 0) return 'already_finished'; // the close watcher won the race
  const child = runningProcesses.get(id);
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch (error) {
      logger.warn('cyberlab job kill failed', { id, error: (error as Error).message });
    }
  }
  return 'cancelled';
}

/**
 * Promote the oldest `queued` job while a slot is free — called after every
 * completion/cancel so the queue drains FIFO. The guarded UPDATE keeps
 * concurrent promotions from starting the same job twice.
 */
export async function promoteQueued(): Promise<void> {
  try {
    for (;;) {
      const candidate = await withSlotLock(async (): Promise<{ id: string; type: string } | { retry: true } | undefined> => {
        const limits = await getLimits();
        const running = await query(`SELECT COUNT(*)::int AS count FROM cyberlab_jobs WHERE status = 'running'`);
        if ((running.rows[0]?.count ?? 0) >= limits.maxConcurrentJobs) return undefined;

        const oldest = await query(
          `SELECT id, type FROM cyberlab_jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`
        );
        const next = oldest.rows[0] as { id: string; type: string } | undefined;
        if (!next) return undefined;

        const promoted = await query(
          `UPDATE cyberlab_jobs SET status = 'running', started_at = NOW() WHERE id = $1 AND status = 'queued' RETURNING id`,
          [next.id]
        );
        // Lost the row to a concurrent cancel — re-evaluate from the top.
        return promoted.rowCount === 0 ? { retry: true } : next;
      });

      if (!candidate) return;
      if ('retry' in candidate) continue;

      await auditJob('cyberlab.job_started', candidate.id, null, `Job started: ${candidate.type}`);
      setImmediate(() => {
        void executeJob(candidate.id, candidate.type as JobType);
      });
    }
  } catch (error) {
    logger.error('cyberlab promoteQueued failed', { error: (error as Error).message });
  }
}

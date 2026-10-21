import crypto from 'crypto';
import { query } from '../../config/database';
import logger from '../../utils/logger';
import { JOB_OPS, runOperation, JobType, RawRun } from './adapter';
import { getLimits, SeefastLimits } from './limits';
import { normalizeJobResult, NewFinding, NormalizeOutcome } from './normalize';

/**
 * In-process job lifecycle runner (no external queue — the repo pattern):
 * `queued → running → completed | failed | cancelled | partial`.
 *
 * Concurrency is capped at `getLimits().maxConcurrentJobs`: the slot check and
 * the `running` insert are one conditional statement, so a second near-
 * simultaneous start lands in `queued` and is promoted FIFO (oldest first)
 * inside finalize's slot-lock section on every completion (so the freed slot
 * is never visible to a concurrent POST before the queue drains). Cancellation is cooperative:
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

type FinalOutcome = { status: 'completed' | 'failed' | 'cancelled' | 'partial'; result?: unknown; error?: string | null; rawStdout?: string };

function mapRunToOutcome(raw: RawRun, artifactPath: string): FinalOutcome {
  if (raw.timedOut) return { status: 'failed', error: 'TIMEOUT' };
  // A signal with no cancel_requested is an unexpected death (OOM kill,
  // segfault, external kill) — not something the operator asked for. Genuine
  // cancels set cancel_requested first and win in finalize, so they still land
  // on `cancelled` regardless of what is mapped here.
  if (raw.signal !== null) return { status: 'failed', error: `engine terminated by signal ${raw.signal}` };
  if (raw.truncated) return { status: 'partial', result: { truncated: true } };
  if (raw.exitCode === 0) return { status: 'completed', result: parseStdout(raw.stdout), rawStdout: raw.stdout };
  const detail = raw.stderrTail && raw.stderrTail.trim() ? raw.stderrTail : `engine exited with code ${raw.exitCode}`;
  return { status: 'failed', error: sanitizeErrorMessage(detail, artifactPath) };
}

/**
 * Store the final state and promote the next queued job — as ONE lock-held
 * critical section: the slot-freeing UPDATE and the promotion must not be
 * split, or a POST /jobs could count the freed slot in between and take it
 * from an older queued job (FIFO starvation). `cancel_requested` wins over
 * the computed outcome — the close watcher is the single decider when a kill
 * lands mid-run. The `completed` path normalises the raw stdout: ok:true
 * stores `result.summary` and inserts the findings; ok:false (unparsable or
 * truncated) downgrades the job to `partial` with a note — findings are never
 * invented from non-JSON output. Cancelled/failed/timeout paths never
 * normalise. Findings insert is best-effort (logged, never unsticks the
 * slot lock); promotion runs regardless.
 */
async function finalize(jobId: string, outcome: FinalOutcome, artifactPath: string | null, type: JobType): Promise<void> {
  try {
    await withSlotLock(async () => {
      const flag = await query('SELECT cancel_requested FROM cyberlab_jobs WHERE id = $1', [jobId]);
      const cancelRequested = flag.rows[0]?.cancel_requested === true;
      let status = cancelRequested ? 'cancelled' : outcome.status;
      const error = status === 'cancelled' ? null : (outcome.error ?? null);
      let result = status === 'cancelled' ? null : (outcome.result ?? null);
      let toInsert: NewFinding[] = [];

      if (status === 'completed') {
        let normalized: NormalizeOutcome;
        try {
          normalized = normalizeJobResult(type, outcome.rawStdout ?? '', false);
        } catch {
          normalized = { ok: false, reason: 'unparsable' };
        }
        if (normalized.ok === false) {
          status = 'partial';
          result = { note: `result not normalisable (${normalized.reason}); job downgraded to partial` };
        } else {
          result = { summary: normalized.summary };
          toInsert = normalized.findings;
        }
      }

      const updated = await query(
        `UPDATE cyberlab_jobs SET status = $2, error = $3, result = $4, finished_at = NOW() WHERE id = $1 AND status = 'running'`,
        [jobId, status, error, result]
      );
      if (updated.rowCount > 0 && status === 'cancelled') {
        // Audit only the actual running → cancelled transition.
        await auditJob('cyberlab.job_cancelled', jobId, null, 'Job cancelled during execution');
      }
      if (updated.rowCount > 0 && toInsert.length > 0) {
        await insertFindings(jobId, toInsert);
      }
      await promoteWhileLocked();
    });
  } catch (error) {
    logger.error('cyberlab job finalize failed', { jobId, error: (error as Error).message });
  } finally {
    // The adapter creates no temp files; the Map entry is the only thing to drop.
    runningProcesses.delete(jobId);
  }
}

/** Best-effort finding persistence: a failed insert is logged, never fatal. */
async function insertFindings(jobId: string, findings: NewFinding[]): Promise<void> {
  for (const finding of findings) {
    try {
      await query(
        'INSERT INTO cyberlab_findings (job_id, kind, title, severity, confidence, evidence) VALUES ($1, $2, $3, $4, $5, $6)',
        [jobId, finding.kind, finding.title, finding.severity, finding.confidence, finding.evidence]
      );
    } catch (error) {
      logger.warn('cyberlab finding insert failed', { jobId, error: (error as Error).message });
    }
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
      await finalize(jobId, { status: 'failed', error: 'artifact for this job no longer exists' }, null, type);
      return;
    }

    const pre = await query('SELECT cancel_requested FROM cyberlab_jobs WHERE id = $1', [jobId]);
    if (pre.rows[0]?.cancel_requested === true) {
      await finalize(jobId, { status: 'cancelled' }, artifactPath, type);
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
      await finalize(jobId, { status: 'failed', error: sanitized }, artifactPath, type);
      return;
    }

    await finalize(jobId, mapRunToOutcome(raw, artifactPath), artifactPath, type);
  } catch (error) {
    logger.error('cyberlab job execution failed', { jobId, error: (error as Error).message });
    await finalize(
      jobId,
      { status: 'failed', error: sanitizeErrorMessage((error as Error).message || 'job execution failed', artifactPath) },
      artifactPath,
      type
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
  // The port is bound before the database is ready, so a job can arrive while
  // the boot recovery is still scanning for orphans. Waiting here keeps the
  // recovery from failing a job that this very process just started.
  await bootGate;
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
 * Promote the oldest `queued` job while a slot is free — the loop body that
 * assumes the slot lock is already held (never call it without the lock).
 * The guarded UPDATE (`status = 'queued'`) additionally protects against a
 * concurrent cancel having taken the row.
 */
async function promoteWhileLocked(): Promise<void> {
  for (;;) {
    const limits = await getLimits();
    const running = await query(`SELECT COUNT(*)::int AS count FROM cyberlab_jobs WHERE status = 'running'`);
    if ((running.rows[0]?.count ?? 0) >= limits.maxConcurrentJobs) return;

    const oldest = await query(
      `SELECT id, type FROM cyberlab_jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`
    );
    const next = oldest.rows[0] as { id: string; type: string } | undefined;
    if (!next) return;

    const promoted = await query(
      `UPDATE cyberlab_jobs SET status = 'running', started_at = NOW() WHERE id = $1 AND status = 'queued' RETURNING id`,
      [next.id]
    );
    // Lost the row to a concurrent cancel — re-evaluate from the top.
    if (promoted.rowCount === 0) continue;

    await auditJob('cyberlab.job_started', next.id, null, `Job started: ${next.type}`);
    // executeJob never runs synchronously; the check phase fires only after
    // the lock is released, so the child cannot re-enter the lock from here.
    setImmediate(() => {
      void executeJob(next.id, next.type as JobType);
    });
  }
}

/**
 * Boot recovery: a process that dies mid-run leaves its row at `running` with
 * no ChildProcess left to finalise it. `promoteWhileLocked` only promotes from
 * `queued` when a slot frees via finalize, so with the default concurrency of 1
 * a single orphan wedges the whole queue forever. There is nothing honest to
 * resume — the engine run died with the process and no stdout survived — so
 * the row is closed as failed and the queue is drained. The guarded UPDATE
 * (`status = 'running'`) means a row finalised between our read and our write
 * is left alone. The drain is unconditional: a crash can also leave `queued`
 * jobs with no orphan at all, and skipping the drain there would let a later
 * POST jump the FIFO queue.
 *
 * Scope: single-process. The runner's slot lock, its ChildProcess map and
 * this recovery are all in-process, so the deployment is one API instance
 * against one database. Running two instances over the same database would
 * make the second one fail the first's legitimately running jobs.
 */
export async function recoverInterruptedJobs(): Promise<number> {
  try {
    return await withSlotLock(async () => {
      const recovered = await query(
        `UPDATE cyberlab_jobs
            SET status = 'failed',
                error = 'interrupted by server restart',
                finished_at = NOW()
          WHERE status = 'running'
          RETURNING id`
      );
      for (const row of recovered.rows) {
        // Distinct action: a restart-interrupted job is not the same event as a
        // runtime failure, and the audit trail must not conflate them.
        await auditJob('cyberlab.job_interrupted', row.id, null, 'Job failed: interrupted by server restart');
      }
      if (recovered.rowCount > 0) {
        logger.warn('cyberlab recovered interrupted jobs', { count: recovered.rowCount });
      }
      // Unconditional: a crash can also leave `queued` jobs with no orphan
      // (the window between finalize's slot-freeing UPDATE and its promotion).
      // Skipping the drain in that case would let a later POST jump the FIFO
      // queue instead of honouring it.
      await promoteWhileLocked();
      return recovered.rowCount ?? 0;
    });
  } catch (error) {
    logger.error('cyberlab restart recovery failed', { error: (error as Error).message });
    return 0;
  }
}

/**
 * Boot gate: the HTTP server binds its port before the database is ready, so a
 * job can be created while the boot recovery is still scanning for orphans.
 * Without a gate, that recovery would see the freshly started job as an
 * orphan and fail it — a job killed by our own restart handling. Every job
 * creation waits for the gate, so the recovery always sees the queue as it
 * was left by the previous process.
 */
let bootGate: Promise<unknown> = Promise.resolve();

/** Hold job creation until the boot recovery has finished. */
export function setBootGate(promise: Promise<unknown>): void {
  bootGate = promise.catch(() => undefined);
}

/**
 * Public promotion entry: after external events (e.g. limits changed) drain
 * the queue under the slot lock. Completions promote via finalize instead.
 */
export async function promoteQueued(): Promise<void> {
  try {
    // The boot gate applies here too: a config change can promote a job, and
    // that job would otherwise be started — and then failed by our own boot
    // recovery — inside the window between listen() and the end of recovery.
    await bootGate;
    await withSlotLock(() => promoteWhileLocked());
  } catch (error) {
    logger.error('cyberlab promoteQueued failed', { error: (error as Error).message });
  }
}

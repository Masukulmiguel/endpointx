import { Router, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { validate, validateQuery } from '../middleware/validation';
import { probeCapabilities, ProviderStatus } from '../services/seefast/capabilities';
import { getLimits, invalidateLimitsCache } from '../services/seefast/limits';
import { getSettingsMap, setSetting } from '../services/settings';
import { toCsv } from '../utils/csv';
import { redactSensitiveText } from '../utils/helpers';
import { aiComplete, isOpencodeConfigured } from '../services/opencode';
import { JOB_OPS, type JobType } from '../services/seefast/adapter';
import { cancelJob, createJob, JobsRunnerError, promoteQueued } from '../services/seefast/jobsRunner';
import logger from '../utils/logger';

const router = Router();

function newId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// Artifact storage root. Never under public/ — the engine's inputs and outputs
// are operator data, not site assets. Tests point this at a temp dir.
function storageRoot(): string {
  return process.env.CYBERLAB_STORAGE_DIR || path.join(__dirname, '..', '..', 'storage', 'cyberlab');
}

// Strict RFC 4648 base64 (padding required). Nothing is decoded before this
// passes: Buffer.from() silently drops invalid characters instead of failing.
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const isValidBase64 = (value: string): boolean => BASE64_RE.test(value);

// Extension taken from the original name, whitelist-sanitised. The original
// name itself never reaches the filesystem — only `uuid + ext` does.
function safeExtension(name: string): string {
  const ext = path.extname(name);
  return /^\.[A-Za-z0-9]{1,15}$/.test(ext) ? ext : '';
}

async function audit(action: string, req: AuthRequest, targetType: string, targetId: string, description: string): Promise<void> {
  try {
    await query(
      'INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [newId(), req.user?.id ?? null, req.user?.email ?? null, action, targetType, targetId, description, req.ip ?? null]
    );
  } catch (error) {
    // The artifact is already stored; an audit hiccup must not fail the upload.
    logger.warn('cyberlab audit write failed', { action, error: (error as Error).message });
  }
}

// GET /providers — engine capability probe (Task 11 reads available/reason/version/detail)
router.get('/providers', authenticate, requirePermission('cyberlab.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const status: ProviderStatus = await probeCapabilities();
    res.json({ success: true, data: status });
  } catch (error) {
    next(error);
  }
});

const ArtifactUploadSchema = z.object({
  name: z.string().min(1).max(200),
  contentBase64: z.string(),
});

// POST /artifacts — hard limits: oversize is rejected on the encoded length
// before any decoding, invalid base64 before any I/O, and the original name
// only ever lands in the database.
router.post('/artifacts', authenticate, requirePermission('cyberlab.manage'), validate(ArtifactUploadSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, contentBase64 } = req.body as z.infer<typeof ArtifactUploadSchema>;
    const limits = await getLimits();

    if ((contentBase64.length * 3) / 4 > limits.maxArtifactBytes) {
      res.status(413).json({
        success: false,
        error: {
          message: `Artifact exceeds the maximum size of ${limits.maxArtifactBytes} bytes`,
          code: 'PAYLOAD_TOO_LARGE',
        },
      });
      return;
    }

    if (!isValidBase64(contentBase64)) {
      res.status(400).json({
        success: false,
        error: { message: 'contentBase64 is not valid base64', code: 'VALIDATION_ERROR' },
      });
      return;
    }

    const buffer = Buffer.from(contentBase64, 'base64');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const id = crypto.randomUUID();
    const root = storageRoot();
    await fs.mkdir(root, { recursive: true });
    const storagePath = path.join(root, `${id}${safeExtension(name)}`);
    await fs.writeFile(storagePath, buffer);

    const inserted = await query(
      `INSERT INTO cyberlab_artifacts (id, sha256, original_name, size_bytes, storage_path, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING created_at`,
      [id, sha256, name, buffer.byteLength, storagePath, req.user?.id ?? null]
    );
    const createdAt = inserted.rows[0]?.created_at ?? new Date();

    await audit('cyberlab.artifact_uploaded', req, 'cyberlab_artifact', id, `Artifact uploaded: ${name}`);

    res.status(201).json({
      success: true,
      data: {
        artifact: {
          id,
          sha256,
          size_bytes: buffer.byteLength,
          original_name: name,
          created_at: createdAt,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

const ArtifactListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /artifacts — newest first. storage_path never leaves the server.
router.get('/artifacts', authenticate, requirePermission('cyberlab.view'), validateQuery(ArtifactListQuerySchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { limit, offset } = req.query as unknown as z.infer<typeof ArtifactListQuerySchema>;
    const [rows, totalResult] = await Promise.all([
      query(
        `SELECT a.id, a.sha256, a.original_name, a.size_bytes, a.created_at,
                (SELECT COUNT(*)::int FROM cyberlab_jobs j WHERE j.target_ref = a.id) AS job_count
         FROM cyberlab_artifacts a
         ORDER BY a.created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      query('SELECT COUNT(*)::int AS total FROM cyberlab_artifacts'),
    ]);
    res.json({
      success: true,
      data: {
        artifacts: rows.rows,
        total: totalResult.rows[0]?.total ?? 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const JOB_COLUMNS = 'id, type, status, target_ref, progress, cancel_requested, error, result, created_at, started_at, finished_at';

// Job payload: target_ref becomes artifact_id; internal columns never leave.
function publicJob(row: Record<string, unknown>): Record<string, unknown> {
  // The `progress` column stores a percentage in 1..100, and 0 is reserved
  // for "not measured". Nothing has ever written it: the column's default is
  // 0, so a stored 0 is the schema's value and not a measurement. Reporting
  // it as "0%" would tell the operator the engine measured nothing, which is
  // a different claim from "the engine never reported anything". A writer
  // that records a real percentage replaces this rule; it must then write
  // 1..100 and leave 0 alone.
  const stored = row.progress;
  const measured = typeof stored === 'number' && stored > 0 ? stored : null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    artifact_id: row.target_ref ?? null,
    progress: measured,
    cancel_requested: row.cancel_requested,
    error: row.error ?? null,
    result: row.result ?? null,
    created_at: row.created_at,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
  };
}

const JobCreateSchema = z.object({
  type: z.string().min(1).max(50),
  artifactId: z.string().min(1).max(100),
});

// POST /jobs — the provider gate runs first: a job must never be created in
// a state that cannot run (not_configured and probe_failed alike → 400 with
// no INSERT). The runner then decides running vs queued against the
// concurrency limit.
router.post('/jobs', authenticate, requirePermission('cyberlab.manage'), validate(JobCreateSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { type, artifactId } = req.body as z.infer<typeof JobCreateSchema>;
    const provider: ProviderStatus = await probeCapabilities();
    if (!provider.available) {
      res.status(400).json({
        success: false,
        error: {
          message: `Engine provider is not available (${provider.reason ?? 'unavailable'})`,
          code: 'PROVIDER_NOT_CONFIGURED',
        },
      });
      return;
    }

    const { job, started } = await createJob({ type: type as JobType, artifactId }, req.user?.id ?? null);
    res.status(201).json({
      success: true,
      data: { job: publicJob(job as unknown as Record<string, unknown>), started },
    });
  } catch (error) {
    if (error instanceof JobsRunnerError) {
      res.status(error.status).json({
        success: false,
        error: { message: error.message, code: error.code },
      });
      return;
    }
    next(error);
  }
});

const JobListQuerySchema = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'partial']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /jobs — newest first, optional status filter.
router.get('/jobs', authenticate, requirePermission('cyberlab.view'), validateQuery(JobListQuerySchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { status, limit, offset } = req.query as unknown as z.infer<typeof JobListQuerySchema>;
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (status) {
      values.push(status);
      conditions.push(`status = $${values.length}`);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const [rows, totalResult] = await Promise.all([
      query(
        `SELECT ${JOB_COLUMNS} FROM cyberlab_jobs${where} ORDER BY created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      ),
      query(`SELECT COUNT(*)::int AS total FROM cyberlab_jobs${where}`, values),
    ]);
    res.json({
      success: true,
      data: {
        jobs: rows.rows.map(publicJob),
        total: totalResult.rows[0]?.total ?? 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /jobs/:id — a malformed uuid can never reach pg (and never 500s).
router.get('/jobs/:id', authenticate, requirePermission('cyberlab.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!JOB_ID_RE.test(id)) {
      res.status(404).json({ success: false, error: { message: 'Job not found', code: 'JOB_NOT_FOUND' } });
      return;
    }
    const result = await query(`SELECT ${JOB_COLUMNS} FROM cyberlab_jobs WHERE id = $1`, [id]);
    const row = result.rows[0];
    if (!row) {
      res.status(404).json({ success: false, error: { message: 'Job not found', code: 'JOB_NOT_FOUND' } });
      return;
    }
    res.json({ success: true, data: { job: publicJob(row) } });
  } catch (error) {
    next(error);
  }
});

// POST /jobs/:id/cancel — 200 { status } | 404 unknown | 409 already finished.
router.post('/jobs/:id/cancel', authenticate, requirePermission('cyberlab.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!JOB_ID_RE.test(id)) {
      res.status(404).json({ success: false, error: { message: 'Job not found', code: 'JOB_NOT_FOUND' } });
      return;
    }
    const outcome = await cancelJob(id, req.user?.id ?? null);
    if (outcome === 'not_found') {
      res.status(404).json({ success: false, error: { message: 'Job not found', code: 'JOB_NOT_FOUND' } });
      return;
    }
    if (outcome === 'already_finished') {
      res.status(409).json({
        success: false,
        error: { message: 'Job already finished', code: 'ALREADY_FINISHED' },
      });
      return;
    }
    res.json({ success: true, data: { status: outcome } });
  } catch (error) {
    next(error);
  }
});

const FINDING_KINDS = ['fact', 'indicator', 'hypothesis', 'validated_vuln', 'inconclusive', 'false_positive', 'recommendation'] as const;
const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
const FINDING_STATUSES = ['open', 'acknowledged'] as const;

const FindingListQuerySchema = z.object({
  // Optional so the global Findings page keeps working; JobDetail relies on it
  // — without it the page fetches the newest N system-wide and filters in the
  // client, which renders a false "no findings" for any older job.
  job_id: z.string().regex(JOB_ID_RE, 'job_id must be a UUID').optional(),
  kind: z.enum(FINDING_KINDS).optional(),
  severity: z.enum(FINDING_SEVERITIES).optional(),
  status: z.enum(FINDING_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /findings — optional job_id/kind/severity/status filters, stable order
// (job, then id). Findings carry no timestamp column, so ordering within a
// job is insertion-independent; pagination stays consistent across pages.
router.get('/findings', authenticate, requirePermission('cyberlab.view'), validateQuery(FindingListQuerySchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { job_id, kind, severity, status, limit, offset } = req.query as unknown as z.infer<typeof FindingListQuerySchema>;
    const conditions: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of [['job_id', job_id], ['kind', kind], ['severity', severity], ['status', status]] as const) {
      if (value) {
        values.push(value);
        conditions.push(`${column} = $${values.length}`);
      }
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const [rows, totalResult] = await Promise.all([
      query(
        `SELECT id, job_id, kind, title, severity, confidence, evidence, asset_ref, status
           FROM cyberlab_findings${where}
          ORDER BY job_id, id
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset]
      ),
      query(`SELECT COUNT(*)::int AS total FROM cyberlab_findings${where}`, values),
    ]);
    res.json({
      success: true,
      data: {
        findings: rows.rows,
        total: totalResult.rows[0]?.total ?? 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /findings/:id/acknowledge — 200 on the open→acknowledged transition,
// 404 for unknown/malformed/already-acknowledged (audit only on the 200).
router.post('/findings/:id/acknowledge', authenticate, requirePermission('cyberlab.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!JOB_ID_RE.test(id)) {
      res.status(404).json({ success: false, error: { message: 'Finding not found', code: 'FINDING_NOT_FOUND' } });
      return;
    }
    const updated = await query(
      `UPDATE cyberlab_findings SET status = 'acknowledged' WHERE id = $1 AND status = 'open' RETURNING id`,
      [id]
    );
    if (updated.rowCount === 0) {
      res.status(404).json({ success: false, error: { message: 'Finding not found', code: 'FINDING_NOT_FOUND' } });
      return;
    }
    await audit('cyberlab.finding_acknowledged', req, 'cyberlab_finding', id, 'Finding acknowledged');
    res.json({ success: true, data: { status: 'acknowledged' } });
  } catch (error) {
    next(error);
  }
});

const ExportQuerySchema = z.object({
  format: z.enum(['json', 'csv']).default('json'),
});

const FINDING_EXPORT_COLUMNS = 'id, job_id, kind, title, severity, confidence, evidence, asset_ref, status';
const FINDING_CSV_HEADERS = ['ID', 'Job ID', 'Kind', 'Title', 'Severity', 'Confidence', 'Status', 'Asset Ref', 'Evidence'];

// Findings carry third-party content (titles/evidence sampled from analysed
// artifacts), so a cell can begin with =, +, -, @, TAB or CR. Excel/Sheets
// evaluate such a cell as a formula, which is CSV injection: opening the
// export can execute a crafted formula. csvCell() neutralises that.
// GET /jobs/:id/export — JSON carries the complete object (job + findings);
// CSV carries only the findings, quoted cell by cell and neutralised against
// formula injection (findings carry third-party content).
// The gate is cyberlab.export, not view: an export is a data-egress action.
router.get('/jobs/:id/export', authenticate, requirePermission('cyberlab.export'), validateQuery(ExportQuerySchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { format } = req.query as unknown as z.infer<typeof ExportQuerySchema>;
    if (!JOB_ID_RE.test(id)) {
      res.status(404).json({ success: false, error: { message: 'Job not found', code: 'JOB_NOT_FOUND' } });
      return;
    }
    const jobResult = await query(`SELECT ${JOB_COLUMNS} FROM cyberlab_jobs WHERE id = $1`, [id]);
    const jobRow = jobResult.rows[0];
    if (!jobRow) {
      res.status(404).json({ success: false, error: { message: 'Job not found', code: 'JOB_NOT_FOUND' } });
      return;
    }
    const findingsResult = await query(
      `SELECT ${FINDING_EXPORT_COLUMNS} FROM cyberlab_findings WHERE job_id = $1 ORDER BY id`,
      [id]
    );

    // Exports are egress: they belong in the audit trail the /audit route serves.
    await audit('cyberlab.exported', req, 'cyberlab_job', id, `Job exported as ${format.toUpperCase()}`);

    if (format === 'csv') {
      const rows = findingsResult.rows.map((finding: Record<string, unknown>) => [
        finding.id,
        finding.job_id,
        finding.kind,
        finding.title,
        finding.severity ?? '',
        finding.confidence ?? '',
        finding.status,
        finding.asset_ref ?? '',
        finding.evidence ? JSON.stringify(finding.evidence) : '',
      ]);
      const csvContent = toCsv([FINDING_CSV_HEADERS, ...rows]);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="cyberlab-job-${id}-findings.csv"`);
      res.send(csvContent);
      return;
    }

    res.json({ success: true, data: { job: publicJob(jobRow), findings: findingsResult.rows } });
  } catch (error) {
    next(error);
  }
});

const AuditListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /audit — the cyberlab slice of the global audit trail. The LIKE filter
// is the whole contract: hermes_* and every other subsystem stay out.
router.get('/audit', authenticate, requirePermission('cyberlab.view'), validateQuery(AuditListQuerySchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { limit, offset } = req.query as unknown as z.infer<typeof AuditListQuerySchema>;
    const [entries, totalResult] = await Promise.all([
      query(
        `SELECT id, user_id, user_email, action, target_type, target_id, description, ip_address, created_at
           FROM audit_logs
          WHERE action LIKE 'cyberlab.%'
          ORDER BY created_at DESC
          LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      query(`SELECT COUNT(*)::int AS total FROM audit_logs WHERE action LIKE 'cyberlab.%'`, []),
    ]);
    res.json({
      success: true,
      data: {
        entries: entries.rows,
        total: totalResult.rows[0]?.total ?? 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Settings keys and bounds for the operator-editable layer of getLimits().
// Precedence stays env CYBERLAB_* > settings cyberlab_* > defaults: these
// keys only ever move the settings layer.
const CONFIG_SETTING_KEYS = {
  maxArtifactMb: 'cyberlab_max_artifact_mb',
  jobTimeoutS: 'cyberlab_job_timeout_s',
  maxConcurrent: 'cyberlab_max_concurrent',
} as const;

// The scoped upload parser in index.ts caps request bodies at 40mb, and a
// base64 artifact grows ~4/3 on the wire — so a decoded artifact above ~28MB
// would be rejected by the parser before this schema could answer with the
// honest route-level 413. The bound stops below that ceiling.
const CONFIG_BOUNDS = {
  maxArtifactMb: { min: 1, max: 28 },
  jobTimeoutS: { min: 5, max: 600 },
  maxConcurrent: { min: 1, max: 4 },
} as const;

// Effective limits plus the stored overrides: GET returns what runs today,
// the overrides show what an operator last wrote (null = not set).
async function configPayload(): Promise<Record<string, unknown>> {
  const [limits, overrides] = await Promise.all([
    getLimits(),
    getSettingsMap(Object.values(CONFIG_SETTING_KEYS)),
  ]);
  return {
    limits: {
      max_artifact_mb: Math.floor(limits.maxArtifactBytes / (1024 * 1024)),
      job_timeout_s: Math.round(limits.jobTimeoutMs / 1000),
      max_concurrent: limits.maxConcurrentJobs,
    },
    overrides: {
      cyberlab_max_artifact_mb: overrides[CONFIG_SETTING_KEYS.maxArtifactMb] ?? null,
      cyberlab_job_timeout_s: overrides[CONFIG_SETTING_KEYS.jobTimeoutS] ?? null,
      cyberlab_max_concurrent: overrides[CONFIG_SETTING_KEYS.maxConcurrent] ?? null,
    },
    bounds: {
      max_artifact_mb: CONFIG_BOUNDS.maxArtifactMb,
      job_timeout_s: CONFIG_BOUNDS.jobTimeoutS,
      max_concurrent: CONFIG_BOUNDS.maxConcurrent,
    },
  };
}

// GET /config — effective limits (what getLimits resolves right now) plus the
// settings overrides Task 11's UI edits.
router.get('/config', authenticate, requirePermission('cyberlab.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await configPayload() });
  } catch (error) {
    next(error);
  }
});

const ConfigUpdateSchema = z
  .object({
    maxArtifactMb: z.coerce.number().int().min(CONFIG_BOUNDS.maxArtifactMb.min).max(CONFIG_BOUNDS.maxArtifactMb.max).optional(),
    jobTimeoutS: z.coerce.number().int().min(CONFIG_BOUNDS.jobTimeoutS.min).max(CONFIG_BOUNDS.jobTimeoutS.max).optional(),
    maxConcurrent: z.coerce.number().int().min(CONFIG_BOUNDS.maxConcurrent.min).max(CONFIG_BOUNDS.maxConcurrent.max).optional(),
  })
  .refine((body) => body.maxArtifactMb !== undefined || body.jobTimeoutS !== undefined || body.maxConcurrent !== undefined, {
    message: 'Provide at least one of maxArtifactMb, jobTimeoutS or maxConcurrent',
  });

// PUT /config — bounds live in the schema, so an out-of-range value is a 400
// before any write. On success the settings layer moves, the getLimits() cache
// is dropped and the next GET reflects immediately. Promotion is then drained:
// raising maxConcurrent frees slots that queued jobs are waiting on, and only
// the runner's lock decides which one takes each slot.
router.put('/config', authenticate, requirePermission('cyberlab.manage'), validate(ConfigUpdateSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const body = req.body as z.infer<typeof ConfigUpdateSchema>;
    const writes: Array<[string, string]> = [];
    if (body.maxArtifactMb !== undefined) writes.push([CONFIG_SETTING_KEYS.maxArtifactMb, String(body.maxArtifactMb)]);
    if (body.jobTimeoutS !== undefined) writes.push([CONFIG_SETTING_KEYS.jobTimeoutS, String(body.jobTimeoutS)]);
    if (body.maxConcurrent !== undefined) writes.push([CONFIG_SETTING_KEYS.maxConcurrent, String(body.maxConcurrent)]);

    for (const [key, value] of writes) {
      await setSetting(key, value, 'Cyber Lab run limit override', req.user?.id);
    }
    invalidateLimitsCache();

    await audit(
      'cyberlab.config_updated',
      req,
      'setting',
      writes.map(([key]) => key).join(','),
      `Cyber Lab limits updated: ${writes.map(([key, value]) => `${key}=${value}`).join(', ')}`
    );

    // Awaited: promoteQueued already swallows and logs its own errors, so a
    // promotion hiccup can never turn a successful config write into a 500 —
    // but awaiting makes the response observe a queue that is already drained.
    if (body.maxConcurrent !== undefined) {
      await promoteQueued();
    }

    res.json({ success: true, data: await configPayload() });
  } catch (error) {
    next(error);
  }
});

// ---- AI console: structured analysis plan, never a job --------------------

const PlanRequestSchema = z.object({
  question: z.string().min(3).max(2000),
});

// Fixed system prompt (controller ruling): the model only *proposes* analysis
// steps for the operator's question — it never executes anything, never writes
// commands and never claims a step already happened — and answers in the
// strict plan JSON below. Operations are referenced only through the op enum
// words; nothing else about how they run is described here.
const PLAN_SYSTEM_PROMPT = [
  'You are the Cyber Lab analysis planner.',
  'For the operator question you receive, ONLY propose the analysis steps that would answer it.',
  'You propose, never execute: do not run anything, do not write commands, do not claim any step already happened.',
  'Reply with raw JSON only — no markdown fences, no commentary — exactly this shape:',
  '{"steps":[{"op":"js_analysis"|"go_binary"|"rust_binary","risk":"low"|"medium"|"high","needsApproval":true|false}]}',
  'op is the analysis operation of the step, risk is how invasive it is (low|medium|high), needsApproval is true when the operator must approve the step before it may run.',
  'Return the steps in the order they should be submitted.',
].join('\n');

// Strict output schema: op is constrained to the three JobTypes via the keys
// of JOB_OPS (never re-declared), risk is the three-level enum, needsApproval
// is a boolean — and any unknown/extra shape, in a step or in the envelope,
// makes the whole plan invalid.
const PlanStepSchema = z
  .object({
    op: z.enum(Object.keys(JOB_OPS) as [JobType, ...JobType[]]),
    risk: z.enum(['low', 'medium', 'high']),
    needsApproval: z.boolean(),
  })
  .strict();

const PlanSchema = z.object({ steps: z.array(PlanStepSchema) }).strict();

// Raw JSON only: fenced or chatty answers are not plans → invalid_plan.
function parsePlan(text: string): z.infer<typeof PlanSchema> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = PlanSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// POST /ai/plan — propose-only console: no provider or a failed AI call →
// state 'not_configured' (same not_configured path as routes/hermes.ts /ai),
// unparseable or schema-invalid output → 'invalid_plan', a strict plan →
// 'ok' with the normalized steps. The endpoint never writes cyberlab_jobs —
// proposing is not creating: the client submits each step itself via POST /jobs.
router.post('/ai/plan', authenticate, requirePermission('cyberlab.view'), validate(PlanRequestSchema), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { question } = req.body as z.infer<typeof PlanRequestSchema>;

    if (!isOpencodeConfigured()) {
      res.json({ success: true, data: { state: 'not_configured' } });
      return;
    }

    let answer: string;
    try {
      const result = await aiComplete(question, PLAN_SYSTEM_PROMPT);
      answer = result.text;
    } catch (aiError) {
      // A configured provider that failed is not the same as no provider at
      // all. Reporting the crash as "not configured" sends the operator to add
      // configuration that is already there, while the real fault — a timeout,
      // a 500, a rejected key — stays invisible. The reason is returned, with
      // the endpoint and the credential taken out of it.
      const message = redactSensitiveText(
        (aiError as Error).message || 'AI provider failed'
      );
      logger.warn('CYBERLAB AI plan failed', { error: message });
      res.json({ success: true, data: { state: 'error', message } });
      return;
    }

    const plan = parsePlan(answer);
    if (!plan) {
      res.json({ success: true, data: { state: 'invalid_plan' } });
      return;
    }

    res.json({ success: true, data: { state: 'ok', steps: plan.steps } });
  } catch (error) {
    next(error);
  }
});

export default router;

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
import { getLimits } from '../services/seefast/limits';
import type { JobType } from '../services/seefast/adapter';
import { cancelJob, createJob, JobsRunnerError } from '../services/seefast/jobsRunner';
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
        'SELECT id, sha256, original_name, size_bytes, created_at FROM cyberlab_artifacts ORDER BY created_at DESC LIMIT $1 OFFSET $2',
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
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    artifact_id: row.target_ref ?? null,
    progress: row.progress,
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

export default router;

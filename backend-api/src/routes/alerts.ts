import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { sendAlertNotification } from '../services/emailService';

const router = Router();

function buildAlertFilters(req: AuthRequest): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const severity = req.query.severity as string | undefined;
  if (severity) {
    params.push(severity);
    clauses.push(`a.severity = $${params.length}`);
  }

  const alertType = req.query.alert_type as string | undefined;
  if (alertType) {
    params.push(alertType);
    clauses.push(`a.alert_type = $${params.length}`);
  }

  const dismissed = req.query.dismissed as string | undefined;
  if (dismissed === 'true' || dismissed === 'false') {
    clauses.push(`a.is_dismissed = ${dismissed === 'true' ? 'true' : 'false'}`);
  }

  const search = req.query.search as string | undefined;
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    clauses.push(`(a.title ILIKE $${params.length} OR a.description ILIKE $${params.length} OR a.alert_type ILIKE $${params.length} OR d.hostname ILIKE $${params.length})`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

router.get('/', authenticate, requirePermission('alerts.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit as string) || 100));
    const offset = (page - 1) * limit;

    const { where, params } = buildAlertFilters(req);

    const countResult = await query(
      `SELECT COUNT(*) as total FROM alerts a LEFT JOIN devices d ON a.device_id = d.id ${where}`,
      params
    );
    const total = parseInt(String(countResult.rows[0]?.total || 0), 10);

    const listParams = [...params, limit, offset];
    const result = await query(
      `SELECT a.*, d.hostname, d.hostname as device_name
       FROM alerts a LEFT JOIN devices d ON a.device_id = d.id
       ${where}
       ORDER BY a.created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    res.json({
      success: true,
      data: {
        alerts: result.rows,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      },
    });
  } catch (error) { next(error); }
});

router.get('/stats', authenticate, requirePermission('alerts.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const totalResult = await query('SELECT COUNT(*) as count FROM alerts', []);
    const bySeverity = await query('SELECT severity, COUNT(*) as count FROM alerts GROUP BY severity', []);
    const byType = await query('SELECT alert_type, COUNT(*) as count FROM alerts GROUP BY alert_type ORDER BY COUNT(*) DESC', []);
    const unresolvedResult = await query("SELECT COUNT(*) as count FROM alerts WHERE is_dismissed = false", []);

    const sevMap: Record<string, number> = {};
    for (const row of bySeverity.rows) {
      sevMap[row.severity] = parseInt(String(row.count), 10) || 0;
    }

    res.json({
      success: true,
      data: {
        total: parseInt(String(totalResult.rows[0]?.count || 0), 10),
        critical: sevMap.critical || 0,
        high: sevMap.high || 0,
        medium: sevMap.medium || 0,
        low: sevMap.low || 0,
        unresolved: parseInt(String(unresolvedResult.rows[0]?.count || 0), 10),
        by_severity: bySeverity.rows,
        by_type: byType.rows,
      },
    });
  } catch (error) { next(error); }
});

router.get('/:id', authenticate, requirePermission('alerts.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query('SELECT * FROM alerts WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Alert not found' } }); return; }
    res.json({ success: true, data: { alert: result.rows[0] } });
  } catch (error) { next(error); }
});

router.post('/dismiss', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string' && id) : [];
    if (ids.length === 0) {
      res.status(400).json({ success: false, error: { message: 'ids array is required' } });
      return;
    }
    const result = await query(
      `UPDATE alerts SET is_dismissed = true, dismissed_by = $1, dismissed_at = NOW()
       WHERE id = ANY($2::uuid[]) RETURNING id`,
      [req.user?.id, ids]
    );
    res.json({ success: true, data: { message: `${result.rowCount || 0} alert(s) dismissed`, count: result.rowCount || 0 } });
  } catch (error) { next(error); }
});

router.post('/', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { severity, title, message, device_id, alert_type } = req.body;
    if (!severity || !title || !device_id) {
      res.status(400).json({ success: false, error: { message: 'severity, title, and device_id are required.' } });
      return;
    }

    const result = await query(
      'INSERT INTO alerts (severity, title, description, device_id, alert_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [severity, title, message || '', device_id, alert_type || 'general']
    );

    const alert = result.rows[0];

    // Send email notification asynchronously (non-blocking)
    sendAlertNotification({ severity, title, message: message || '', device_id }).catch((err) =>
      console.error('Failed to send alert notification:', err.message)
    );

    res.status(201).json({ success: true, data: { alert } });
  } catch (error) { next(error); }
});

router.post('/:id/dismiss', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await query("UPDATE alerts SET is_dismissed = true, dismissed_by = $1, dismissed_at = NOW() WHERE id = $2", [req.user?.id, req.params.id]);
    res.json({ success: true, data: { message: 'Alert dismissed' } });
  } catch (error) { next(error); }
});

export default router;

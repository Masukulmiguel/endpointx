import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { sendAlertNotification } from '../services/emailService';
import { canViewAllDevices, ownsDevice } from '../utils/tenant';

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

  // Account isolation: non-admin sees system alerts (no device) + alerts of own devices only
  if (!canViewAllDevices(req.user)) {
    params.push(req.user!.id);
    clauses.push(`(a.device_id IS NULL OR d.created_by = $${params.length})`);
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

router.get('/stats', authenticate, requirePermission('alerts.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const viewAll = canViewAllDevices(req.user);
    const join = viewAll ? '' : ' LEFT JOIN devices d ON a.device_id = d.id';
    const w = viewAll ? '' : ' WHERE (a.device_id IS NULL OR d.created_by = $1)';
    const p = viewAll ? [] : [req.user!.id];
    const totalResult = await query(`SELECT COUNT(*) as count FROM alerts a${join}${w}`, p);
    const bySeverity = await query(`SELECT a.severity, COUNT(*) as count FROM alerts a${join}${w} GROUP BY a.severity`, p);
    const byType = await query(`SELECT a.alert_type, COUNT(*) as count FROM alerts a${join}${w} GROUP BY a.alert_type ORDER BY COUNT(*) DESC`, p);
    const unresolvedResult = await query(
      `SELECT COUNT(*) as count FROM alerts a${join}${viewAll ? ' WHERE a.is_dismissed = false' : `${w} AND a.is_dismissed = false`}`,
      p
    );

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
    const result = await query(
      'SELECT a.*, d.created_by as device_created_by FROM alerts a LEFT JOIN devices d ON a.device_id = d.id WHERE a.id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Alert not found' } }); return; }
    const alert = result.rows[0];
    if (!canViewAllDevices(req.user) && alert.device_id && alert.device_created_by !== req.user?.id) {
      res.status(404).json({ success: false, error: { message: 'Alert not found' } });
      return;
    }
    res.json({ success: true, data: { alert } });
  } catch (error) { next(error); }
});

router.post('/dismiss', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string' && id) : [];
    if (ids.length === 0) {
      res.status(400).json({ success: false, error: { message: 'ids array is required' } });
      return;
    }
    // Non-admin: only dismiss system alerts + alerts of owned devices
    let allowedIds = ids;
    if (!canViewAllDevices(req.user)) {
      const owned = await query(
        `SELECT a.id FROM alerts a LEFT JOIN devices d ON a.device_id = d.id
         WHERE a.id = ANY($1::uuid[]) AND (a.device_id IS NULL OR d.created_by = $2)`,
        [ids, req.user!.id]
      );
      allowedIds = owned.rows.map((r: { id: string }) => r.id);
    }
    const result = await query(
      `UPDATE alerts SET is_dismissed = true, dismissed_by = $1, dismissed_at = NOW()
       WHERE id = ANY($2::uuid[]) RETURNING id`,
      [req.user?.id, allowedIds]
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
    if (!canViewAllDevices(req.user) && !(await ownsDevice(req.user?.id, device_id))) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
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
    const existing = await query(
      'SELECT a.id, a.device_id, d.created_by as device_created_by FROM alerts a LEFT JOIN devices d ON a.device_id = d.id WHERE a.id = $1',
      [req.params.id]
    );
    if (existing.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Alert not found' } }); return; }
    const alert = existing.rows[0];
    if (!canViewAllDevices(req.user) && alert.device_id && alert.device_created_by !== req.user?.id) {
      res.status(404).json({ success: false, error: { message: 'Alert not found' } });
      return;
    }
    await query("UPDATE alerts SET is_dismissed = true, dismissed_by = $1, dismissed_at = NOW() WHERE id = $2", [req.user?.id, req.params.id]);
    res.json({ success: true, data: { message: 'Alert dismissed' } });
  } catch (error) { next(error); }
});

export default router;

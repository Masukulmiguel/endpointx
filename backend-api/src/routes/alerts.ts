import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import {
  acknowledgeAlert,
  createAlert,
  dismissAlert,
  rearmAlert,
} from '../services/alertService';
import { canAccessDevice, canSeeDevice, visibleDeviceRowsSql } from '../utils/tenant';

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

  // Backwards-compatible boolean filter kept alongside the richer `status` one.
  const dismissed = req.query.dismissed as string | undefined;
  if (dismissed === 'true' || dismissed === 'false') {
    clauses.push(`a.is_dismissed = ${dismissed === 'true' ? 'true' : 'false'}`);
  }

  const status = req.query.status as string | undefined;
  if (status === 'open') clauses.push(`a.is_dismissed = false AND a.acknowledged_at IS NULL`);
  else if (status === 'acknowledged') clauses.push(`a.is_dismissed = false AND a.acknowledged_at IS NOT NULL`);
  else if (status === 'resolved') clauses.push(`a.is_dismissed = true`);

  const source = req.query.source as string | undefined;
  if (source) {
    params.push(source);
    clauses.push(`a.source = $${params.length}`);
  }

  const search = req.query.search as string | undefined;
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    clauses.push(`(a.title ILIKE $${params.length} OR a.description ILIKE $${params.length} OR a.alert_type ILIKE $${params.length} OR d.hostname ILIKE $${params.length})`);
  }

  // Account isolation: system alerts (no device) + alerts of the caller's devices
  // (+ unassigned devices for admin)
  params.push(req.user!.id);
  clauses.push(visibleDeviceRowsSql('a.device_id', 'd.created_by', params.length, req.user));

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
    const join = ' LEFT JOIN devices d ON a.device_id = d.id';
    const w = ` WHERE ${visibleDeviceRowsSql('a.device_id', 'd.created_by', 1, req.user)}`;
    const p = [req.user!.id];
    const totalResult = await query(`SELECT COUNT(*) as count FROM alerts a${join}${w}`, p);
    const bySeverity = await query(`SELECT a.severity, COUNT(*) as count FROM alerts a${join}${w} GROUP BY a.severity`, p);
    const byType = await query(`SELECT a.alert_type, COUNT(*) as count FROM alerts a${join}${w} GROUP BY a.alert_type ORDER BY COUNT(*) DESC`, p);
    const unresolvedResult = await query(
      `SELECT COUNT(*) as count FROM alerts a${join}${w} AND a.is_dismissed = false`,
      p
    );
    const openResult = await query(
      `SELECT COUNT(*) as count FROM alerts a${join}${w} AND a.is_dismissed = false AND a.acknowledged_at IS NULL`,
      p
    );
    const ackResult = await query(
      `SELECT COUNT(*) as count FROM alerts a${join}${w} AND a.is_dismissed = false AND a.acknowledged_at IS NOT NULL`,
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
        open: parseInt(String(openResult.rows[0]?.count || 0), 10),
        acknowledged: parseInt(String(ackResult.rows[0]?.count || 0), 10),
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
    if (alert.device_id && !canSeeDevice(req.user, alert.device_created_by)) {
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
    // Only dismiss system alerts + alerts of devices this account may see
    const owned = await query(
      `SELECT a.id FROM alerts a LEFT JOIN devices d ON a.device_id = d.id
       WHERE a.id = ANY($1::uuid[]) AND ${visibleDeviceRowsSql('a.device_id', 'd.created_by', 2, req.user)}`,
      [ids, req.user!.id]
    );
    const allowedIds = owned.rows.map((r: { id: string }) => r.id);
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
    if (!(await canAccessDevice(req.user, device_id))) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const { created, alert } = await createAlert({
      device_id,
      alert_type: alert_type || 'general',
      severity,
      title,
      description: message || '',
      source: 'manual',
      notify: true,
    });

    res.status(201).json({ success: true, data: { alert, created } });
  } catch (error) { next(error); }
});

/** Load an alert and enforce device-level visibility, or null when hidden. */
async function loadVisibleAlert(req: AuthRequest, id: string): Promise<Record<string, any> | null> {
  const existing = await query(
    'SELECT a.id, a.device_id, d.created_by as device_created_by FROM alerts a LEFT JOIN devices d ON a.device_id = d.id WHERE a.id = $1',
    [id]
  );
  if (existing.rows.length === 0) return null;
  const alert = existing.rows[0];
  if (alert.device_id && !canSeeDevice(req.user, alert.device_created_by)) return null;
  return alert;
}

router.post('/:id/dismiss', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const alert = await loadVisibleAlert(req, req.params.id);
    if (!alert) { res.status(404).json({ success: false, error: { message: 'Alert not found' } }); return; }
    await dismissAlert(req.params.id, req.user?.id);
    res.json({ success: true, data: { message: 'Alert dismissed' } });
  } catch (error) { next(error); }
});

// Acknowledge: owns the alert, stops paging, keeps it open.
router.post('/:id/acknowledge', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const alert = await loadVisibleAlert(req, req.params.id);
    if (!alert) { res.status(404).json({ success: false, error: { message: 'Alert not found' } }); return; }
    const updated = await acknowledgeAlert(req.params.id, req.user?.id);
    if (!updated) {
      res.status(409).json({ success: false, error: { message: 'Alert is already resolved' } });
      return;
    }
    res.json({ success: true, data: { alert: updated, message: 'Alert acknowledged' } });
  } catch (error) { next(error); }
});

// Re-arm: clears the acknowledgement (and any manual dismissal) so the alert
// surfaces again — used when a condition is still true after being muted.
router.post('/:id/rearm', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const alert = await loadVisibleAlert(req, req.params.id);
    if (!alert) { res.status(404).json({ success: false, error: { message: 'Alert not found' } }); return; }
    const updated = await rearmAlert(req.params.id);
    res.json({ success: true, data: { alert: updated, message: 'Alert re-armed' } });
  } catch (error) { next(error); }
});

// Bulk acknowledge
router.post('/acknowledge', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string' && id) : [];
    if (ids.length === 0) {
      res.status(400).json({ success: false, error: { message: 'ids array is required' } });
      return;
    }
    const owned = await query(
      `SELECT a.id FROM alerts a LEFT JOIN devices d ON a.device_id = d.id
       WHERE a.id = ANY($1::uuid[]) AND ${visibleDeviceRowsSql('a.device_id', 'd.created_by', 2, req.user)}`,
      [ids, req.user!.id]
    );
    const allowedIds = owned.rows.map((r: { id: string }) => r.id);
    const result = await query(
      `UPDATE alerts SET acknowledged_by = $1, acknowledged_at = NOW()
        WHERE id = ANY($2::uuid[]) AND is_dismissed = false`,
      [req.user?.id, allowedIds]
    );
    res.json({ success: true, data: { message: `${result.rowCount || 0} alert(s) acknowledged`, count: result.rowCount || 0 } });
  } catch (error) { next(error); }
});

export default router;

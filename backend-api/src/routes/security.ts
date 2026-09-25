import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { canViewAllDevices } from '../utils/tenant';

const router = Router();

function buildEventFilters(req: AuthRequest): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const severity = req.query.severity as string | undefined;
  if (severity) {
    params.push(severity);
    clauses.push(`se.severity = $${params.length}`);
  }

  const eventType = req.query.event_type as string | undefined;
  if (eventType) {
    params.push(eventType);
    clauses.push(`se.event_type = $${params.length}`);
  }

  const search = req.query.search as string | undefined;
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    clauses.push(`(se.title ILIKE $${params.length} OR se.description ILIKE $${params.length} OR se.event_type ILIKE $${params.length} OR d.hostname ILIKE $${params.length})`);
  }

  const dateRange = req.query.date_range as string | undefined;
  if (dateRange === '24h') clauses.push(`se.created_at > NOW() - INTERVAL '24 hours'`);
  else if (dateRange === '7d') clauses.push(`se.created_at > NOW() - INTERVAL '7 days'`);
  else if (dateRange === '30d') clauses.push(`se.created_at > NOW() - INTERVAL '30 days'`);

  // Account isolation: non-admin sees system events (no device) + own devices only
  if (!canViewAllDevices(req.user)) {
    params.push(req.user!.id);
    clauses.push(`(se.device_id IS NULL OR d.created_by = $${params.length})`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

router.get('/events', authenticate, requirePermission('security.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;

    const { where, params } = buildEventFilters(req);

    const countResult = await query(
      `SELECT COUNT(*) as total FROM security_events se LEFT JOIN devices d ON se.device_id = d.id ${where}`,
      params
    );
    const total = parseInt(String(countResult.rows[0]?.total || 0), 10);

    const listParams = [...params, limit, offset];
    const result = await query(
      `SELECT se.*, d.hostname, d.hostname as device_name
       FROM security_events se LEFT JOIN devices d ON se.device_id = d.id
       ${where}
       ORDER BY se.created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );

    res.json({
      success: true,
      data: {
        events: result.rows,
        pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      },
    });
  } catch (error) { next(error); }
});

router.get('/events/stats', authenticate, requirePermission('security.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const viewAll = canViewAllDevices(req.user);
    const join = viewAll ? '' : ' LEFT JOIN devices d ON se.device_id = d.id';
    const w = viewAll ? '' : ' WHERE (se.device_id IS NULL OR d.created_by = $1)';
    const p = viewAll ? [] : [req.user!.id];
    const total = await query(`SELECT COUNT(*) as count FROM security_events se${join}${w}`, p);
    const resolved = await query(`SELECT COUNT(*) as count FROM security_events se${join}${viewAll ? ' WHERE se.is_resolved = true' : `${w} AND se.is_resolved = true`}`, p);
    const unresolved = await query(`SELECT COUNT(*) as count FROM security_events se${join}${viewAll ? ' WHERE se.is_resolved = false' : `${w} AND se.is_resolved = false`}`, p);
    const bySeverity = await query(`SELECT se.severity, COUNT(*) as count FROM security_events se${join}${w} GROUP BY se.severity`, p);
    const byType = await query(`SELECT se.event_type, COUNT(*) as count FROM security_events se${join}${w} GROUP BY se.event_type ORDER BY COUNT(*) DESC`, p);

    const sevMap: Record<string, number> = {};
    for (const row of bySeverity.rows) {
      sevMap[row.severity] = parseInt(String(row.count), 10) || 0;
    }

    res.json({
      success: true,
      data: {
        total: parseInt(String(total.rows[0]?.count || 0), 10),
        critical: sevMap.critical || 0,
        high: sevMap.high || 0,
        medium: sevMap.medium || 0,
        low: sevMap.low || 0,
        info: sevMap.info || 0,
        resolved: parseInt(String(resolved.rows[0]?.count || 0), 10),
        unresolved: parseInt(String(unresolved.rows[0]?.count || 0), 10),
        by_severity: bySeverity.rows,
        by_type: byType.rows,
      },
    });
  } catch (error) { next(error); }
});

router.get('/events/:id', authenticate, requirePermission('security.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      'SELECT se.*, d.hostname, d.hostname as device_name, d.created_by as device_created_by FROM security_events se LEFT JOIN devices d ON se.device_id = d.id WHERE se.id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Event not found' } }); return; }
    const event = result.rows[0];
    if (!canViewAllDevices(req.user) && event.device_id && event.device_created_by !== req.user?.id) {
      res.status(404).json({ success: false, error: { message: 'Event not found' } });
      return;
    }
    res.json({ success: true, data: { event } });
  } catch (error) { next(error); }
});

router.post('/events/:id/resolve', authenticate, requirePermission('security.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const existing = await query(
      'SELECT se.device_id, d.created_by as device_created_by FROM security_events se LEFT JOIN devices d ON se.device_id = d.id WHERE se.id = $1',
      [req.params.id]
    );
    if (existing.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Event not found' } }); return; }
    const ev = existing.rows[0];
    if (!canViewAllDevices(req.user) && ev.device_id && ev.device_created_by !== req.user?.id) {
      res.status(404).json({ success: false, error: { message: 'Event not found' } });
      return;
    }
    await query("UPDATE security_events SET is_resolved = true, resolved_by = $1, resolved_at = NOW() WHERE id = $2", [req.user?.id, req.params.id]);
    res.json({ success: true, data: { message: 'Event resolved' } });
  } catch (error) { next(error); }
});

export default router;

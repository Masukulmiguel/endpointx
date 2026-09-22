import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

router.get('/events', authenticate, requirePermission('security.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = (page - 1) * limit;

    const countResult = await query('SELECT COUNT(*) as total FROM security_events', []);
    const total = countResult.rows[0]?.total || 0;

    const result = await query('SELECT se.*, d.hostname FROM security_events se LEFT JOIN devices d ON se.device_id = d.id ORDER BY se.created_at DESC LIMIT ? OFFSET ?', [limit, offset]);
    res.json({ success: true, data: { events: result.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } } });
  } catch (error) { next(error); }
});

router.get('/events/stats', authenticate, requirePermission('security.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const total = await query('SELECT COUNT(*) as count FROM security_events', []);
    const resolved = await query('SELECT COUNT(*) as count FROM security_events WHERE is_resolved = 1', []);
    const unresolved = await query('SELECT COUNT(*) as count FROM security_events WHERE is_resolved = 0', []);
    const bySeverity = await query('SELECT severity, COUNT(*) as count FROM security_events GROUP BY severity', []);
    const byType = await query('SELECT event_type, COUNT(*) as count FROM security_events GROUP BY event_type', []);
    res.json({ success: true, data: { total: total.rows[0]?.count || 0, resolved: resolved.rows[0]?.count || 0, unresolved: unresolved.rows[0]?.count || 0, by_severity: bySeverity.rows, by_type: byType.rows } });
  } catch (error) { next(error); }
});

router.get('/events/:id', authenticate, requirePermission('security.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query('SELECT * FROM security_events WHERE id = ?', [req.params.id]);
    if (result.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Event not found' } }); return; }
    res.json({ success: true, data: { event: result.rows[0] } });
  } catch (error) { next(error); }
});

router.post('/events/:id/resolve', authenticate, requirePermission('security.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await query("UPDATE security_events SET is_resolved = 1, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?", [req.user?.id, req.params.id]);
    res.json({ success: true, data: { message: 'Event resolved' } });
  } catch (error) { next(error); }
});

export default router;

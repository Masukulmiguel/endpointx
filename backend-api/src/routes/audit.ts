import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

router.get('/', authenticate, requirePermission('logs.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = (page - 1) * limit;

    const countResult = await query('SELECT COUNT(*) as total FROM audit_logs', []);
    const total = countResult.rows[0]?.total || 0;
    const result = await query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, offset]);

    res.json({ success: true, data: { logs: result.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } } });
  } catch (error) { next(error); }
});

router.get('/stats', authenticate, requirePermission('logs.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const byAction = await query('SELECT action, COUNT(*) as count FROM audit_logs GROUP BY action ORDER BY count DESC', []);
    const recentCount = await query("SELECT COUNT(*) as count FROM audit_logs WHERE created_at > NOW() - INTERVAL '24 hours'", []);
    res.json({ success: true, data: { by_action: byAction.rows, recent_24h: recentCount.rows[0]?.count || 0 } });
  } catch (error) { next(error); }
});

router.get('/export', authenticate, requirePermission('logs.export'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 1000', []);
    const csv = 'ID,User,Action,Target,Description,IP,Date\n' + result.rows.map((r: any) =>
      `"${r.id}","${r.user_email || ''}","${r.action}","${r.target_type || ''}","${r.description || ''}","${r.ip_address || ''}","${r.created_at}"`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=audit-logs.csv');
    res.send(csv);
  } catch (error) { next(error); }
});

router.get('/:id', authenticate, requirePermission('logs.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query('SELECT * FROM audit_logs WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Log not found' } }); return; }
    res.json({ success: true, data: { log: result.rows[0] } });
  } catch (error) { next(error); }
});

export default router;

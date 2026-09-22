import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { sendAlertNotification } from '../services/emailService';

const router = Router();

router.get('/', authenticate, requirePermission('alerts.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const result = await query('SELECT a.*, d.hostname FROM alerts a LEFT JOIN devices d ON a.device_id = d.id ORDER BY a.created_at DESC LIMIT ?', [limit]);
    res.json({ success: true, data: { alerts: result.rows } });
  } catch (error) { next(error); }
});

router.get('/stats', authenticate, requirePermission('alerts.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const totalResult = await query('SELECT COUNT(*) as count FROM alerts', []);
    const bySeverity = await query('SELECT severity, COUNT(*) as count FROM alerts GROUP BY severity', []);
    const byType = await query('SELECT alert_type, COUNT(*) as count FROM alerts GROUP BY alert_type', []);
    const unresolvedResult = await query("SELECT COUNT(*) as count FROM alerts WHERE is_dismissed = 0", []);

    const sevMap: Record<string, number> = {};
    for (const row of bySeverity.rows) {
      sevMap[row.severity] = row.count;
    }

    res.json({
      success: true,
      data: {
        total: totalResult.rows[0]?.count || 0,
        critical: sevMap['critical'] || 0,
        high: sevMap['high'] || 0,
        medium: sevMap['medium'] || 0,
        low: sevMap['low'] || 0,
        unresolved: unresolvedResult.rows[0]?.count || 0,
        by_severity: bySeverity.rows,
        by_type: byType.rows,
      },
    });
  } catch (error) { next(error); }
});

router.get('/:id', authenticate, requirePermission('alerts.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query('SELECT * FROM alerts WHERE id = ?', [req.params.id]);
    if (result.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Alert not found' } }); return; }
    res.json({ success: true, data: { alert: result.rows[0] } });
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
      'INSERT INTO alerts (severity, title, message, device_id, alert_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
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
    await query("UPDATE alerts SET is_dismissed = 1, dismissed_by = ?, dismissed_at = datetime('now') WHERE id = ?", [req.user?.id, req.params.id]);
    res.json({ success: true, data: { message: 'Alert dismissed' } });
  } catch (error) { next(error); }
});

export default router;

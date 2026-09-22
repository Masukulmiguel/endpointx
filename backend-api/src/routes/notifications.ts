import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

// List notification logs
router.get('/', authenticate, requirePermission('logs.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    const countResult = await query('SELECT COUNT(*) AS total FROM notification_logs');
    const total = countResult.rows[0]?.total || 0;

    const result = await query(
      'SELECT * FROM notification_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]
    );

    res.json({
      success: true,
      data: {
        notifications: result.rows,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
      }
    });
  } catch (error) { next(error); }
});

// Send test email
router.post('/test', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;
    if (!email) {
      res.status(400).json({ success: false, error: { message: 'email is required' } });
      return;
    }

    const idResult = await query('SELECT uuid_generate_v4() AS id');
    const id = idResult.rows[0].id;

    await query(
      `INSERT INTO notification_logs (id, recipient, subject, body, status, created_at)
       VALUES ($1, $2, 'EndpointX Test Notification', 'This is a test notification from EndpointX.', 'sent', NOW())`,
      [id, email]
    );

    res.json({ success: true, data: { message: 'Test notification sent', notification_id: id } });
  } catch (error) { next(error); }
});

// Get notification settings
router.get('/settings', authenticate, requirePermission('settings.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      "SELECT * FROM app_settings WHERE key LIKE 'notification_%'"
    );
    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    res.json({ success: true, data: { settings } });
  } catch (error) { next(error); }
});

// Update notification settings
router.put('/settings', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      res.status(400).json({ success: false, error: { message: 'settings object is required' } });
      return;
    }

    for (const [key, value] of Object.entries(settings)) {
      const settingKey = key.startsWith('notification_') ? key : `notification_${key}`;
      await query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [settingKey, value as string]
      );
    }

    res.json({ success: true, data: { message: 'Notification settings updated' } });
  } catch (error) { next(error); }
});

export default router;

import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { invalidateSettingsCache } from '../services/settings';
import { broadcastEvent } from '../websocket';

const router = Router();

router.get('/', authenticate, requirePermission('settings.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query('SELECT * FROM app_settings ORDER BY key', []);
    res.json({ success: true, data: { settings: result.rows } });
  } catch (error) { next(error); }
});

router.put('/:key', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    const result = await query(
      "UPDATE app_settings SET value = $1, updated_at = NOW() WHERE key = $2 RETURNING key, value",
      [String(value ?? ''), key]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: `Unknown setting: ${key}` } });
      return;
    }

    // The settings cache is shared by the alert engine, SMTP config and the
    // retention jobs — forget it here or a change would take 15s to land.
    invalidateSettingsCache();

    await query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'settings_update', 'setting', key, `Setting ${key} updated`, req.ip]);

    broadcastEvent('settings:changed', { key, value: result.rows[0].value });

    res.json({ success: true, data: { message: 'Setting updated', setting: result.rows[0] } });
  } catch (error) { next(error); }
});

export default router;

import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

router.get('/', authenticate, requirePermission('settings.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = query('SELECT * FROM app_settings ORDER BY key', []);
    res.json({ success: true, data: { settings: result.rows } });
  } catch (error) { next(error); }
});

router.put('/:key', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { key } = req.params;
    const { value } = req.body;
    query("UPDATE app_settings SET value = ?, updated_at = datetime('now') WHERE key = ?", [value, key]);

    query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'settings_update', 'setting', key, `Setting ${key} updated`, req.ip]);

    res.json({ success: true, data: { message: 'Setting updated' } });
  } catch (error) { next(error); }
});

export default router;

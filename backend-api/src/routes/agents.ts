import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

router.get('/stats', authenticate, requirePermission('devices.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
        SUM(CASE WHEN agent_version IS NOT NULL AND agent_version < '1.0.0' THEN 1 ELSE 0 END) as outdated
      FROM devices
    `);

    const stats = result.rows[0] || { total: 0, online: 0, outdated: 0 };

    res.json({
      success: true,
      data: {
        total: stats.total,
        online: stats.online,
        outdated: stats.outdated,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;

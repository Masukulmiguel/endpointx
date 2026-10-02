import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { visibleDevicesSql } from '../utils/tenant';

const router = Router();

router.get('/stats', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online,
        SUM(CASE WHEN agent_version IS NOT NULL AND agent_version < '1.5.0' THEN 1 ELSE 0 END) as outdated
      FROM devices
      WHERE ${visibleDevicesSql('created_by', 1, req.user)}`,
      [req.user!.id]
    );

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

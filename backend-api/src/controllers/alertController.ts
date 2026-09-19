import { Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';
import { paginate } from '../utils/helpers';

export const getAlerts = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const severity = req.query.severity as string | undefined;
    const alert_type = req.query.alert_type as string | undefined;
    const device_id = req.query.device_id as string | undefined;
    const is_dismissed = req.query.is_dismissed as string | undefined;
    const { offset, limit: safeLimit } = paginate(page, limit);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (severity) {
      conditions.push(`a.severity = $${paramIndex}`);
      params.push(severity);
      paramIndex++;
    }

    if (alert_type) {
      conditions.push(`a.alert_type = $${paramIndex}`);
      params.push(alert_type);
      paramIndex++;
    }

    if (device_id) {
      conditions.push(`a.device_id = $${paramIndex}`);
      params.push(device_id);
      paramIndex++;
    }

    if (is_dismissed !== undefined) {
      conditions.push(`a.is_dismissed = $${paramIndex}`);
      params.push(is_dismissed === 'true');
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(
      `SELECT COUNT(*)::int as total FROM alerts a ${whereClause}`,
      params
    );

    const result = await query(
      `SELECT a.id, a.title, a.message, a.severity, a.alert_type, a.device_id,
              a.is_dismissed, a.dismissed_by, a.dismissed_at, a.created_at, a.updated_at,
              d.agent_id, d.hostname,
              u.first_name, u.last_name
       FROM alerts a
       LEFT JOIN devices d ON a.device_id = d.id
       LEFT JOIN users u ON a.dismissed_by = u.id
       ${whereClause}
       ORDER BY
         CASE a.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
         a.created_at DESC
       OFFSET $${paramIndex} LIMIT $${paramIndex + 1}`,
      [...params, offset, safeLimit]
    );

    res.json({
      success: true,
      data: {
        alerts: result.rows,
        pagination: {
          page,
          limit: safeLimit,
          total: countResult.rows[0].total,
          totalPages: Math.ceil(countResult.rows[0].total / safeLimit),
        },
      },
    });
  } catch (error) {
    logger.error('Get alerts error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getAlert = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT a.*, d.agent_id, d.hostname,
              u.first_name as dismissed_by_first_name, u.last_name as dismissed_by_last_name
       FROM alerts a
       LEFT JOIN devices d ON a.device_id = d.id
       LEFT JOIN users u ON a.dismissed_by = u.id
       WHERE a.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Alert not found.', code: 'ALERT_NOT_FOUND' },
      });
      return;
    }

    res.json({ success: true, data: { alert: result.rows[0] } });
  } catch (error) {
    logger.error('Get alert error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const dismissAlert = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: { message: 'Authentication required.', code: 'AUTH_TOKEN_MISSING' },
      });
      return;
    }

    const result = await query(
      `UPDATE alerts
       SET is_dismissed = true,
           dismissed_by = $1,
           dismissed_at = NOW(),
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, title, is_dismissed, dismissed_by, dismissed_at`,
      [userId, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Alert not found.', code: 'ALERT_NOT_FOUND' },
      });
      return;
    }

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'dismiss_alert', 'alert', $2, $3, $4)`,
      [userId, id, JSON.stringify({ title: result.rows[0].title }), req.ip]
    );

    logger.info('Alert dismissed', { alertId: id, userId });

    res.json({ success: true, data: { alert: result.rows[0] } });
  } catch (error) {
    logger.error('Dismiss alert error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getAlertStats = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const [severityCounts, typeCounts, recentTrend] = await Promise.all([
      query(
        `SELECT severity, COUNT(*)::int as count
         FROM alerts
         WHERE is_dismissed = false
         GROUP BY severity
         ORDER BY
           CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END`
      ),
      query(
        `SELECT alert_type, COUNT(*)::int as count
         FROM alerts
         WHERE is_dismissed = false
         GROUP BY alert_type
         ORDER BY count DESC`
      ),
      query(
        `SELECT
           DATE_TRUNC('day', created_at)::date as date,
           COUNT(*)::int as count
         FROM alerts
         WHERE created_at >= NOW() - INTERVAL '30 days'
         GROUP BY DATE_TRUNC('day', created_at)
         ORDER BY date ASC`
      ),
    ]);

    res.json({
      success: true,
      data: {
        by_severity: severityCounts.rows,
        by_type: typeCounts.rows,
        trend: recentTrend.rows,
      },
    });
  } catch (error) {
    logger.error('Get alert stats error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const createAlert = async (
  title: string,
  message: string,
  severity: string,
  alert_type: string,
  device_id?: string,
  extraDetails?: Record<string, any>
): Promise<string | null> => {
  try {
    const result = await query(
      `INSERT INTO alerts (title, message, severity, alert_type, device_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        title,
        message,
        severity,
        alert_type,
        device_id || null,
        extraDetails ? JSON.stringify(extraDetails) : null,
      ]
    );

    const alertId = result.rows[0].id;

    logger.info('Alert created', { alertId, title, severity, alert_type, device_id });

    return alertId;
  } catch (error) {
    logger.error('Create alert error', { error: (error as Error).message, title, severity });
    return null;
  }
};

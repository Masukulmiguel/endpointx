import { Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';
import { paginate } from '../utils/helpers';

export const getSecurityEvents = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const device_id = req.query.device_id as string | undefined;
    const severity = req.query.severity as string | undefined;
    const event_type = req.query.event_type as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const { offset, limit: safeLimit } = paginate(page, limit);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (device_id) {
      conditions.push(`se.device_id = $${paramIndex}`);
      params.push(device_id);
      paramIndex++;
    }

    if (severity) {
      conditions.push(`se.severity = $${paramIndex}`);
      params.push(severity);
      paramIndex++;
    }

    if (event_type) {
      conditions.push(`se.event_type = $${paramIndex}`);
      params.push(event_type);
      paramIndex++;
    }

    if (from) {
      conditions.push(`se.created_at >= $${paramIndex}`);
      params.push(from);
      paramIndex++;
    }

    if (to) {
      conditions.push(`se.created_at <= $${paramIndex}`);
      params.push(to);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(
      `SELECT COUNT(*)::int as total FROM security_events se ${whereClause}`,
      params
    );

    const result = await query(
      `SELECT se.id, se.device_id, se.event_type, se.severity, se.title, se.description,
              se.details, se.is_resolved, se.resolved_by, se.resolved_at,
              se.created_at,
              d.agent_id, d.hostname,
              u.first_name, u.last_name
       FROM security_events se
       LEFT JOIN devices d ON se.device_id = d.id
       LEFT JOIN users u ON se.resolved_by = u.id
       ${whereClause}
       ORDER BY
         CASE se.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END,
         se.created_at DESC
       OFFSET $${paramIndex} LIMIT $${paramIndex + 1}`,
      [...params, offset, safeLimit]
    );

    res.json({
      success: true,
      data: {
        events: result.rows,
        pagination: {
          page,
          limit: safeLimit,
          total: countResult.rows[0].total,
          totalPages: Math.ceil(countResult.rows[0].total / safeLimit),
        },
      },
    });
  } catch (error) {
    logger.error('Get security events error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getSecurityEvent = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT se.*, d.agent_id, d.hostname,
              u.first_name as resolved_by_first_name, u.last_name as resolved_by_last_name
       FROM security_events se
       LEFT JOIN devices d ON se.device_id = d.id
       LEFT JOIN users u ON se.resolved_by = u.id
       WHERE se.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Security event not found.', code: 'SECURITY_EVENT_NOT_FOUND' },
      });
      return;
    }

    res.json({ success: true, data: { event: result.rows[0] } });
  } catch (error) {
    logger.error('Get security event error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const resolveSecurityEvent = async (
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
      `UPDATE security_events
       SET is_resolved = true,
           resolved_by = $1,
           resolved_at = NOW()
       WHERE id = $2
       RETURNING id, event_type, severity, title, is_resolved, resolved_by, resolved_at`,
      [userId, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Security event not found.', code: 'SECURITY_EVENT_NOT_FOUND' },
      });
      return;
    }

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'resolve_security_event', 'security_event', $2, $3, $4)`,
      [
        userId,
        id,
        JSON.stringify({ event_type: result.rows[0].event_type, severity: result.rows[0].severity }),
        req.ip,
      ]
    );

    logger.info('Security event resolved', { eventId: id, userId });

    res.json({ success: true, data: { event: result.rows[0] } });
  } catch (error) {
    logger.error('Resolve security event error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getSecurityStats = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const [severityCounts, typeCounts, topDevices] = await Promise.all([
      query(
        `SELECT severity, COUNT(*)::int as count
         FROM security_events
         WHERE is_resolved = false
         GROUP BY severity
         ORDER BY
           CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END`
      ),
      query(
        `SELECT event_type, COUNT(*)::int as count
         FROM security_events
         WHERE is_resolved = false
         GROUP BY event_type
         ORDER BY count DESC`
      ),
      query(
        `SELECT d.id, d.agent_id, d.hostname, COUNT(se.id)::int as event_count
         FROM security_events se
         JOIN devices d ON se.device_id = d.id
         WHERE se.is_resolved = false
         GROUP BY d.id, d.agent_id, d.hostname
         ORDER BY event_count DESC
         LIMIT 10`
      ),
    ]);

    res.json({
      success: true,
      data: {
        by_severity: severityCounts.rows,
        by_type: typeCounts.rows,
        top_affected_devices: topDevices.rows,
      },
    });
  } catch (error) {
    logger.error('Get security stats error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

import { Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';
import { paginate } from '../utils/helpers';

export const getAuditLogs = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const user_id = req.query.user_id as string | undefined;
    const action = req.query.action as string | undefined;
    const target_type = req.query.target_type as string | undefined;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const exportFormat = req.query.export as string | undefined;
    const { offset, limit: safeLimit } = paginate(page, limit);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (user_id) {
      conditions.push(`al.user_id = $${paramIndex}`);
      params.push(user_id);
      paramIndex++;
    }

    if (action) {
      conditions.push(`al.action = $${paramIndex}`);
      params.push(action);
      paramIndex++;
    }

    if (target_type) {
      conditions.push(`al.target_type = $${paramIndex}`);
      params.push(target_type);
      paramIndex++;
    }

    if (from) {
      conditions.push(`al.created_at >= $${paramIndex}`);
      params.push(from);
      paramIndex++;
    }

    if (to) {
      conditions.push(`al.created_at <= $${paramIndex}`);
      params.push(to);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    if (exportFormat === 'csv') {
      const exportResult = await query(
        `SELECT al.id, al.user_id, al.action, al.target_type, al.target_id,
                al.details, al.ip_address, al.created_at,
                u.email, u.first_name, u.last_name
         FROM audit_logs al
         LEFT JOIN users u ON al.user_id = u.id
         ${whereClause}
         ORDER BY al.created_at DESC
         LIMIT 1000`,
        params
      );

      const headers = 'id,user_email,user_first_name,user_last_name,action,target_type,target_id,details,ip_address,created_at\n';
      const rows = exportResult.rows.map((r: any) =>
        [
          r.id,
          r.email || '',
          r.first_name || '',
          r.last_name || '',
          r.action,
          r.target_type,
          r.target_id || '',
          r.details ? JSON.stringify(r.details).replace(/"/g, '""') : '',
          r.ip_address || '',
          r.created_at,
        ].join(',')
      ).join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(headers + rows);
      return;
    }

    const countResult = await query(
      `SELECT COUNT(*)::int as total FROM audit_logs al ${whereClause}`,
      params
    );

    const result = await query(
      `SELECT al.id, al.user_id, al.action, al.target_type, al.target_id,
              al.details, al.ip_address, al.created_at,
              u.email, u.first_name, u.last_name
       FROM audit_logs al
       LEFT JOIN users u ON al.user_id = u.id
       ${whereClause}
       ORDER BY al.created_at DESC
       OFFSET $${paramIndex} LIMIT $${paramIndex + 1}`,
      [...params, offset, safeLimit]
    );

    res.json({
      success: true,
      data: {
        logs: result.rows,
        pagination: {
          page,
          limit: safeLimit,
          total: countResult.rows[0].total,
          totalPages: Math.ceil(countResult.rows[0].total / safeLimit),
        },
      },
    });
  } catch (error) {
    logger.error('Get audit logs error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getAuditLog = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT al.*, u.email, u.first_name, u.last_name
       FROM audit_logs al
       LEFT JOIN users u ON al.user_id = u.id
       WHERE al.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Audit log not found.', code: 'AUDIT_LOG_NOT_FOUND' },
      });
      return;
    }

    res.json({ success: true, data: { log: result.rows[0] } });
  } catch (error) {
    logger.error('Get audit log error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getAuditStats = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const [actionCounts, topUsers, activityTimeline] = await Promise.all([
      query(
        `SELECT action, COUNT(*)::int as count
         FROM audit_logs
         WHERE created_at >= NOW() - INTERVAL '30 days'
         GROUP BY action
         ORDER BY count DESC`
      ),
      query(
        `SELECT u.id, u.email, u.first_name, u.last_name, COUNT(al.id)::int as action_count
         FROM audit_logs al
         JOIN users u ON al.user_id = u.id
         WHERE al.created_at >= NOW() - INTERVAL '30 days'
         GROUP BY u.id, u.email, u.first_name, u.last_name
         ORDER BY action_count DESC
         LIMIT 10`
      ),
      query(
        `SELECT
           DATE_TRUNC('hour', created_at)::timestamp as time_bucket,
           COUNT(*)::int as count
         FROM audit_logs
         WHERE created_at >= NOW() - INTERVAL '24 hours'
         GROUP BY DATE_TRUNC('hour', created_at)
         ORDER BY time_bucket ASC`
      ),
    ]);

    res.json({
      success: true,
      data: {
        by_action: actionCounts.rows,
        top_users: topUsers.rows,
        activity_timeline: activityTimeline.rows,
      },
    });
  } catch (error) {
    logger.error('Get audit stats error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

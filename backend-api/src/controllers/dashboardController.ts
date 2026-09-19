import { Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';

export const getOverview = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const [
      deviceStats,
      userStats,
      recentSecurityEvents,
      criticalAlerts,
      deviceStatusDistribution,
      recentHeartbeats,
      topDevicesByCpu,
      topDevicesByRam,
      alertsByType,
      securityEventsBySeverity,
    ] = await Promise.all([
      query(
        `SELECT
           COUNT(*)::int as total_devices,
           COUNT(*) FILTER (WHERE status = 'online')::int as online_devices,
           COUNT(*) FILTER (WHERE status = 'offline')::int as offline_devices,
           COUNT(*) FILTER (WHERE status = 'blocked')::int as blocked_devices,
           COUNT(*) FILTER (WHERE status = 'quarantine')::int as quarantine_devices
         FROM devices`
      ),
      query(
        `SELECT
           COUNT(*)::int as total_users,
           COUNT(*) FILTER (WHERE last_login >= NOW() - INTERVAL '24 hours')::int as active_users
         FROM users
         WHERE is_active = true`
      ),
      query(
        `SELECT se.id, se.event_type, se.severity, se.title, se.created_at,
                d.hostname, d.agent_id
         FROM security_events se
         LEFT JOIN devices d ON se.device_id = d.id
         ORDER BY se.created_at DESC
         LIMIT 10`
      ),
      query(
        `SELECT a.id, a.title, a.severity, a.alert_type, a.created_at,
                d.hostname, d.agent_id
         FROM alerts a
         LEFT JOIN devices d ON a.device_id = d.id
         WHERE a.is_dismissed = false AND a.severity IN ('critical', 'high')
         ORDER BY
           CASE a.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,
           a.created_at DESC
         LIMIT 20`
      ),
      query(
        `SELECT status, COUNT(*)::int as count
         FROM devices
         GROUP BY status
         ORDER BY count DESC`
      ),
      query(
        `SELECT
           DATE_TRUNC('hour', created_at)::timestamp as time_bucket,
           COUNT(*)::int as count
         FROM device_heartbeats
         WHERE created_at >= NOW() - INTERVAL '24 hours'
         GROUP BY DATE_TRUNC('hour', created_at)
         ORDER BY time_bucket ASC`
      ),
      query(
        `SELECT d.id, d.hostname, d.agent_id, dh.cpu_usage, dh.created_at
         FROM device_heartbeats dh
         JOIN devices d ON dh.device_id = d.id
         WHERE dh.cpu_usage IS NOT NULL
           AND dh.created_at >= NOW() - INTERVAL '1 hour'
         ORDER BY dh.cpu_usage DESC
         LIMIT 5`
      ),
      query(
        `SELECT d.id, d.hostname, d.agent_id, dh.memory_usage, dh.created_at
         FROM device_heartbeats dh
         JOIN devices d ON dh.device_id = d.id
         WHERE dh.memory_usage IS NOT NULL
           AND dh.created_at >= NOW() - INTERVAL '1 hour'
         ORDER BY dh.memory_usage DESC
         LIMIT 5`
      ),
      query(
        `SELECT alert_type, COUNT(*)::int as count
         FROM alerts
         WHERE created_at >= NOW() - INTERVAL '30 days'
         GROUP BY alert_type
         ORDER BY count DESC`
      ),
      query(
        `SELECT severity, COUNT(*)::int as count
         FROM security_events
         WHERE created_at >= NOW() - INTERVAL '30 days'
         GROUP BY severity
         ORDER BY
           CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END`
      ),
    ]);

    const ds = deviceStats.rows[0];
    const us = userStats.rows[0];

    res.json({
      success: true,
      data: {
        devices: {
          total: ds.total_devices,
          online: ds.online_devices,
          offline: ds.offline_devices,
          blocked: ds.blocked_devices,
          quarantine: ds.quarantine_devices,
        },
        users: {
          total: us.total_users,
          active_24h: us.active_users,
        },
        recent_security_events: recentSecurityEvents.rows,
        critical_alerts: criticalAlerts.rows,
        device_status_distribution: deviceStatusDistribution.rows,
        recent_heartbeats: recentHeartbeats.rows,
        top_devices_by_cpu: topDevicesByCpu.rows,
        top_devices_by_ram: topDevicesByRam.rows,
        alerts_by_type: alertsByType.rows,
        security_events_by_severity: securityEventsBySeverity.rows,
      },
    });
  } catch (error) {
    logger.error('Get dashboard overview error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

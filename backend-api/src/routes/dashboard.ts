import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { canViewAllDevices } from '../utils/tenant';

const router = Router();

// Mark devices as offline if no heartbeat within threshold
async function updateOfflineDevices() {
  try {
    const offlineThresholdSeconds = parseInt(process.env.OFFLINE_THRESHOLD || '300', 10);
    const thresholdMinutes = Math.max(1, Math.ceil(offlineThresholdSeconds / 60));
    await query(`UPDATE devices SET status = 'offline' WHERE status = 'online' AND last_heartbeat < NOW() - INTERVAL '${thresholdMinutes} minutes'`);
  } catch (e) { /* ignore */ }
}

router.get('/overview', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    updateOfflineDevices();
    const viewAll = canViewAllDevices(req.user);
    const userId = req.user?.id;
    // Device-scoped filters (non-admin => own devices only)
    const devWhere = (extra?: string) =>
      `${extra ? `WHERE ${extra}${viewAll ? '' : ` AND created_by = $1`}` : viewAll ? '' : `WHERE created_by = $1`}`;
    const devP = viewAll ? [] : [userId];
    // Alerts/events join devices; NULL device_id = system-level, visible to everyone
    const joinWhere = (alias: string, extra?: string) => {
      const own = `(${alias}.device_id IS NULL OR d.created_by = $1)`;
      if (viewAll) return extra ? `WHERE ${extra}` : '';
      return `WHERE ${extra ? `${extra} AND ` : ''}${own}`;
    };
    const jP = viewAll ? [] : [userId];
    const canSeeUsers = (req.user?.permissions || []).includes('users.view');

    const totalDevices = await query(`SELECT COUNT(*) as count FROM devices${devWhere()}`, devP);
    const onlineDevices = await query(`SELECT COUNT(*) as count FROM devices${devWhere("status = 'online'")}`, devP);
    const offlineDevices = await query(`SELECT COUNT(*) as count FROM devices${devWhere("status = 'offline'")}`, devP);
    const alertDevices = await query(`SELECT COUNT(*) as count FROM devices${devWhere("status = 'alert'")}`, devP);
    const blockedDevices = await query(`SELECT COUNT(*) as count FROM devices${devWhere("status = 'blocked'")}`, devP);
    const totalAlerts = await query(
      `SELECT COUNT(*) as count FROM alerts a LEFT JOIN devices d ON a.device_id = d.id${joinWhere('a')}`,
      jP
    );
    const unresolvedAlerts = await query(
      `SELECT COUNT(*) as count FROM alerts a LEFT JOIN devices d ON a.device_id = d.id${joinWhere('a', 'a.is_dismissed = false')}`,
      jP
    );
    const quarantineDevices = await query(`SELECT COUNT(*) as count FROM devices${devWhere("status = 'quarantine'")}`, devP);
    const totalUsers = canSeeUsers
      ? await query('SELECT COUNT(*) as count FROM users', [])
      : { rows: [{ count: 0 }] };
    const activeUsers = canSeeUsers
      ? await query("SELECT COUNT(*) as count FROM users WHERE is_active = true", [])
      : { rows: [{ count: 0 }] };
    const recentEvents = await query(
      `SELECT se.*, d.hostname as device_name FROM security_events se LEFT JOIN devices d ON se.device_id = d.id${joinWhere('se')} ORDER BY se.created_at DESC LIMIT 10`,
      jP
    );
    const criticalAlerts = await query(
      `SELECT a.*, d.hostname as device_name FROM alerts a LEFT JOIN devices d ON a.device_id = d.id${joinWhere('a', "a.severity IN ('critical', 'high') AND a.is_dismissed = false")} ORDER BY a.created_at DESC LIMIT 10`,
      jP
    );
    const statusDistribution = await query(
      `SELECT status, COUNT(*) as count FROM devices${devWhere()} GROUP BY status`,
      devP
    );

    // Heartbeat trend - count heartbeats per hour for last 24h
    const heartbeatTrend = await query(
      viewAll
        ? `
      SELECT TO_CHAR(date_trunc('hour', recorded_at), 'HH24:MI') as time, COUNT(*) as count
      FROM device_heartbeats
      WHERE recorded_at > NOW() - INTERVAL '24 hours'
      GROUP BY date_trunc('hour', recorded_at)
      ORDER BY date_trunc('hour', recorded_at) ASC
    `
        : `
      SELECT TO_CHAR(date_trunc('hour', dh.recorded_at), 'HH24:MI') as time, COUNT(*) as count
      FROM device_heartbeats dh
      JOIN devices d ON d.id = dh.device_id
      WHERE dh.recorded_at > NOW() - INTERVAL '24 hours' AND d.created_by = $1
      GROUP BY date_trunc('hour', dh.recorded_at)
      ORDER BY date_trunc('hour', dh.recorded_at) ASC
    `,
      devP
    );

    // Alerts by type
    const alertsByType = await query(
      `SELECT a.alert_type as type, COUNT(*) as count
       FROM alerts a LEFT JOIN devices d ON a.device_id = d.id
       ${joinWhere('a')}
       GROUP BY a.alert_type
       ORDER BY count DESC`,
      jP
    );

    // Security events by severity
    const eventsBySeverity = await query(
      `SELECT se.severity, COUNT(*) as count
       FROM security_events se LEFT JOIN devices d ON se.device_id = d.id
       ${joinWhere('se')}
       GROUP BY se.severity
       ORDER BY count DESC`,
      jP
    );

    res.json({
      success: true,
      data: {
        total_devices: totalDevices.rows[0]?.count || 0,
        online_devices: onlineDevices.rows[0]?.count || 0,
        offline_devices: offlineDevices.rows[0]?.count || 0,
        alert_devices: alertDevices.rows[0]?.count || 0,
        blocked_devices: blockedDevices.rows[0]?.count || 0,
        total_alerts: totalAlerts.rows[0]?.count || 0,
        unresolved_alerts: unresolvedAlerts.rows[0]?.count || 0,
        quarantine_devices: quarantineDevices.rows[0]?.count || 0,
        total_users: totalUsers.rows[0]?.count || 0,
        active_users: activeUsers.rows[0]?.count || 0,
        recent_events: recentEvents.rows,
        critical_alerts: criticalAlerts.rows,
        device_status_distribution: statusDistribution.rows,
        heartbeat_trend: heartbeatTrend.rows,
        alerts_by_type: alertsByType.rows,
        events_by_severity: eventsBySeverity.rows,
      },
    });
  } catch (error) { next(error); }
});

export default router;

import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';

const router = Router();

// Mark devices as offline if no heartbeat within threshold
async function updateOfflineDevices() {
  try {
    const offlineThresholdSeconds = parseInt(process.env.OFFLINE_THRESHOLD || '300', 10);
    const thresholdMinutes = Math.max(1, Math.ceil(offlineThresholdSeconds / 60));
    await query(`UPDATE devices SET status = 'offline' WHERE status = 'online' AND last_heartbeat < datetime('now', '-${thresholdMinutes} minutes')`);
  } catch (e) { /* ignore */ }
}

router.get('/overview', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    updateOfflineDevices();
    const totalDevices = await query('SELECT COUNT(*) as count FROM devices', []);
    const onlineDevices = await query("SELECT COUNT(*) as count FROM devices WHERE status = 'online'", []);
    const offlineDevices = await query("SELECT COUNT(*) as count FROM devices WHERE status = 'offline'", []);
    const alertDevices = await query("SELECT COUNT(*) as count FROM devices WHERE status = 'alert'", []);
    const blockedDevices = await query("SELECT COUNT(*) as count FROM devices WHERE status = 'blocked'", []);
    const totalAlerts = await query('SELECT COUNT(*) as count FROM alerts', []);
    const unresolvedAlerts = await query("SELECT COUNT(*) as count FROM alerts WHERE is_dismissed = 0", []);
    const quarantineDevices = await query("SELECT COUNT(*) as count FROM devices WHERE status = 'quarantine'", []);
    const totalUsers = await query('SELECT COUNT(*) as count FROM users', []);
    const activeUsers = await query("SELECT COUNT(*) as count FROM users WHERE is_active = 1", []);
    const recentEvents = await query('SELECT se.*, d.hostname as device_name FROM security_events se LEFT JOIN devices d ON se.device_id = d.id ORDER BY se.created_at DESC LIMIT 10', []);
    const criticalAlerts = await query("SELECT a.*, d.hostname as device_name FROM alerts a LEFT JOIN devices d ON a.device_id = d.id WHERE a.severity IN ('critical', 'high') AND a.is_dismissed = 0 ORDER BY a.created_at DESC LIMIT 10", []);
    const statusDistribution = await query('SELECT status, COUNT(*) as count FROM devices GROUP BY status', []);

    // Heartbeat trend - count heartbeats per hour for last 24h
    const heartbeatTrend = await query(`
      SELECT strftime('%H:%M', recorded_at) as time, COUNT(*) as count
      FROM device_heartbeats
      WHERE recorded_at > datetime('now', '-24 hours')
      GROUP BY strftime('%Y-%m-%d %H', recorded_at)
      ORDER BY time ASC
    `, []);

    // Alerts by type
    const alertsByType = await query(`
      SELECT alert_type as type, COUNT(*) as count
      FROM alerts
      GROUP BY alert_type
      ORDER BY count DESC
    `, []);

    // Security events by severity
    const eventsBySeverity = await query(`
      SELECT severity, COUNT(*) as count
      FROM security_events
      GROUP BY severity
      ORDER BY count DESC
    `, []);

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

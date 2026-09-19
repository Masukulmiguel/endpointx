import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';

const router = Router();

// Mark devices as offline if no heartbeat in last 2 minutes
function updateOfflineDevices() {
  try {
    query("UPDATE devices SET status = 'offline' WHERE status = 'online' AND last_heartbeat < datetime('now', '-2 minutes')");
  } catch (e) { /* ignore */ }
}

router.get('/overview', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    updateOfflineDevices();
    const totalDevices = query('SELECT COUNT(*) as count FROM devices', []);
    const onlineDevices = query("SELECT COUNT(*) as count FROM devices WHERE status = 'online'", []);
    const offlineDevices = query("SELECT COUNT(*) as count FROM devices WHERE status = 'offline'", []);
    const alertDevices = query("SELECT COUNT(*) as count FROM devices WHERE status = 'alert'", []);
    const blockedDevices = query("SELECT COUNT(*) as count FROM devices WHERE status = 'blocked'", []);
    const quarantineDevices = query("SELECT COUNT(*) as count FROM devices WHERE status = 'quarantine'", []);
    const totalUsers = query('SELECT COUNT(*) as count FROM users', []);
    const activeUsers = query("SELECT COUNT(*) as count FROM users WHERE is_active = 1", []);
    const recentEvents = query('SELECT * FROM security_events ORDER BY created_at DESC LIMIT 10', []);
    const criticalAlerts = query("SELECT * FROM alerts WHERE severity IN ('critical', 'high') AND is_dismissed = 0 ORDER BY created_at DESC LIMIT 10", []);
    const statusDistribution = query('SELECT status, COUNT(*) as count FROM devices GROUP BY status', []);

    res.json({
      success: true,
      data: {
        total_devices: totalDevices.rows[0]?.count || 0,
        online_devices: onlineDevices.rows[0]?.count || 0,
        offline_devices: offlineDevices.rows[0]?.count || 0,
        alert_devices: alertDevices.rows[0]?.count || 0,
        blocked_devices: blockedDevices.rows[0]?.count || 0,
        quarantine_devices: quarantineDevices.rows[0]?.count || 0,
        total_users: totalUsers.rows[0]?.count || 0,
        active_users: activeUsers.rows[0]?.count || 0,
        recent_events: recentEvents.rows,
        critical_alerts: criticalAlerts.rows,
        device_status_distribution: statusDistribution.rows,
      },
    });
  } catch (error) { next(error); }
});

export default router;

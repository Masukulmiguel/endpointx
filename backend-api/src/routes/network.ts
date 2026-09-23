import { Router } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { Response, NextFunction } from 'express';

const router = Router();

// Network stats
router.get('/stats', authenticate, requirePermission('network.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const totalResult = await query('SELECT COUNT(*) as total FROM devices WHERE is_authorized = true');
    const onlineResult = await query("SELECT COUNT(*) as online FROM devices WHERE is_authorized = true AND status = 'online'");
    const latencyResult = await query("SELECT AVG(ram_usage) as avg_ram FROM device_heartbeats WHERE recorded_at > NOW() - INTERVAL '5 minutes'");

    const total = totalResult.rows[0]?.total || 0;
    const online = onlineResult.rows[0]?.online || 0;
    const avgRam = latencyResult.rows[0]?.avg_ram || 0;

    res.json({
      success: true,
      data: {
        total_devices: total,
        online_devices: online,
        average_latency: Math.round(avgRam * 100) / 100,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Bandwidth (heartbeats)
router.get('/bandwidth', authenticate, requirePermission('network.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const deviceId = req.query.device_id as string;
    let sql = `
      SELECT h.id, h.device_id, h.cpu_usage, h.ram_usage, h.disk_usage,
             h.network_in, h.network_out, h.active_processes, h.ip_address, h.recorded_at,
             d.hostname, d.agent_id
      FROM device_heartbeats h
      JOIN devices d ON h.device_id = d.id
    `;
    const params: any[] = [];

    if (deviceId) {
      sql += ' WHERE h.device_id = $1';
      params.push(deviceId);
    }

    sql += ' ORDER BY h.recorded_at DESC LIMIT 100';

    const result = await query(sql, params);

    res.json({
      success: true,
      data: { heartbeats: result.rows },
    });
  } catch (error) {
    next(error);
  }
});

// Network interfaces
router.get('/interfaces', authenticate, requirePermission('network.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const deviceId = req.query.device_id as string;
    let sql = `
      SELECT ni.id, ni.device_id, ni.name, ni.mac_address, ni.ipv4_address, ni.ipv6_address,
             ni.is_connected, ni.speed_mbps, ni.recorded_at,
             d.hostname as device_name, d.agent_id as device_id_ref
      FROM device_network_interfaces ni
      JOIN devices d ON ni.device_id = d.id
    `;
    const params: any[] = [];

    if (deviceId) {
      sql += ' WHERE ni.device_id = $1';
      params.push(deviceId);
    }

    sql += ' ORDER BY d.hostname, ni.name';

    const result = await query(sql, params);

    const interfaces = result.rows.map((row: any) => ({
      id: row.id,
      device_id: row.device_id,
      device_name: row.device_name,
      name: row.name,
      mac_address: row.mac_address,
      ipv4_address: row.ipv4_address,
      ipv6_address: row.ipv6_address,
      is_connected: !!row.is_connected,
      speed_mbps: row.speed_mbps,
      recorded_at: row.recorded_at,
    }));

    res.json({
      success: true,
      data: { interfaces },
    });
  } catch (error) {
    next(error);
  }
});

export default router;

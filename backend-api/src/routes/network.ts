import { Router } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { Response, NextFunction } from 'express';
import { visibleDevicesSql } from '../utils/tenant';
import { fetchHeartbeatSeries, resolveInterval, resolveRange } from '../services/metrics';

const router = Router();

// Network stats
//
// This endpoint used to report `AVG(ram_usage)` as "average latency", which is
// neither latency nor meaningful. Agents do not measure round-trip time, so we
// now report the numbers we can actually measure: how fresh the data is
// (heartbeat interval), how busy the fleet is (CPU), and aggregate throughput.
router.get('/stats', authenticate, requirePermission('network.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const totalResult = await query(`SELECT COUNT(*) as total FROM devices WHERE is_authorized = true AND ${visibleDevicesSql('created_by', 1, req.user)}`, [req.user!.id]);
    const onlineResult = await query(`SELECT COUNT(*) as online FROM devices WHERE is_authorized = true AND status = 'online' AND ${visibleDevicesSql('created_by', 1, req.user)}`, [req.user!.id]);

    const freshness = await query(
      `SELECT AVG(seconds)::float AS avg_interval,
              MAX(seconds)::float AS max_interval
         FROM (
           SELECT EXTRACT(EPOCH FROM (NOW() - last_heartbeat)) AS seconds
             FROM devices
            WHERE is_authorized = true AND last_heartbeat IS NOT NULL
              AND ${visibleDevicesSql('created_by', 2, req.user)}
         ) t`,
      [req.user!.id]
    );

    const load = await query(
      `SELECT AVG(h.cpu_usage)::float AS avg_cpu,
              AVG(h.ram_usage)::float AS avg_ram
         FROM device_heartbeats h
         JOIN devices d ON d.id = h.device_id
        WHERE h.recorded_at > NOW() - INTERVAL '5 minutes'
          AND ${visibleDevicesSql('d.created_by', 1, req.user)}`,
      [req.user!.id]
    );

    const series = await fetchHeartbeatSeries({
      interval: '5m',
      visibilitySql: visibleDevicesSql('d.created_by', 1, req.user),
      visibilityParams: [req.user!.id],
    });
    const withRate = series.filter((p) => p.network_in_rate !== null || p.network_out_rate !== null);
    const avgRateIn = withRate.length
      ? withRate.reduce((sum, p) => sum + (p.network_in_rate || 0), 0) / withRate.length
      : 0;
    const avgRateOut = withRate.length
      ? withRate.reduce((sum, p) => sum + (p.network_out_rate || 0), 0) / withRate.length
      : 0;

    const total = parseInt(String(totalResult.rows[0]?.total || 0), 10) || 0;
    const online = parseInt(String(onlineResult.rows[0]?.online || 0), 10) || 0;
    const avgInterval = Math.round(Number(freshness.rows[0]?.avg_interval ?? 0) * 10) / 10;
    const maxInterval = Math.round(Number(freshness.rows[0]?.max_interval ?? 0) * 10) / 10;

    res.json({
      success: true,
      data: {
        total_devices: total,
        online_devices: online,
        // Seconds since the last heartbeat, fleet-wide. Lower is fresher.
        avg_heartbeat_interval: avgInterval,
        oldest_heartbeat_age: maxInterval,
        avg_cpu_usage: Math.round(Number(load.rows[0]?.avg_cpu ?? 0) * 10) / 10,
        avg_ram_usage: Math.round(Number(load.rows[0]?.avg_ram ?? 0) * 10) / 10,
        avg_throughput_in: Math.round(avgRateIn * 100) / 100,
        avg_throughput_out: Math.round(avgRateOut * 100) / 100,
        // Deprecated: was AVG(ram_usage). Kept as null so old clients show 0
        // rather than a fabricated millisecond figure.
        average_latency: null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Bandwidth (heartbeats) — bytes/sec rates with ?from=&to=&interval= support.
router.get('/bandwidth', authenticate, requirePermission('network.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const deviceId = req.query.device_id as string | undefined;
    const hasRange = Boolean(req.query.from || req.query.to || req.query.interval);

    const range = resolveRange(req.query.from, req.query.to);
    const interval = resolveInterval(req.query.interval as string | undefined, range.seconds);

    const series = await fetchHeartbeatSeries({
      deviceId: deviceId || undefined,
      from: range.from,
      to: range.to,
      interval,
      visibilitySql: visibleDevicesSql('d.created_by', 1, req.user),
      visibilityParams: [req.user!.id],
    });

    // Legacy shape: newest-first raw heartbeats (still capped) for any caller
    // that reads `heartbeats` directly.
    const clauses = ['d.created_by = $1'];
    const params: unknown[] = [req.user!.id];
    if (deviceId) { params.push(deviceId); clauses.push(`h.device_id = $${params.length}`); }
    if (!hasRange) {
      params.push(range.from, range.to);
      clauses.push(`h.recorded_at >= $${params.length - 1} AND h.recorded_at < $${params.length}`);
    }
    const legacy = await query(
      `SELECT h.id, h.device_id, h.cpu_usage, h.ram_usage, h.disk_usage,
              h.network_in, h.network_out, h.active_processes, h.ip_address, h.recorded_at,
              d.hostname, d.agent_id
         FROM device_heartbeats h
         JOIN devices d ON h.device_id = d.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY h.recorded_at DESC
        LIMIT 500`,
      params
    );

    res.json({
      success: true,
      data: {
        heartbeats: legacy.rows,
        series,
        interval,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Per-interface throughput (rates, not raw cumulative counters).
router.get('/interfaces/:deviceId/throughput', authenticate, requirePermission('network.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { deviceId } = req.params;
    const result = await query(
      `SELECT m.interface_name, m.rate_in, m.rate_out, m.bytes_in, m.bytes_out, m.recorded_at
         FROM device_interface_metrics m
         JOIN devices d ON d.id = m.device_id
        WHERE m.device_id = $2
          AND ${visibleDevicesSql('d.created_by', 1, req.user)}
        ORDER BY m.recorded_at DESC
        LIMIT 500`,
      [req.user!.id, deviceId]
    );
    if (result.rows.length === 0) {
      const owned = await query(`SELECT 1 FROM devices d WHERE d.id = $2 AND ${visibleDevicesSql('d.created_by', 1, req.user)}`, [req.user!.id, deviceId]);
      if (owned.rows.length === 0) {
        res.status(404).json({ success: false, error: { message: 'Device not found' } });
        return;
      }
    }
    res.json({ success: true, data: { metrics: result.rows } });
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
      WHERE ${visibleDevicesSql('d.created_by', 1, req.user)}
    `;
    const params: any[] = [req.user!.id];

    if (deviceId) {
      sql += ' AND ni.device_id = $2';
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

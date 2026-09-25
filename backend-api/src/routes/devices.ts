import { Router } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { Response, NextFunction } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import logger from '../utils/logger';
import jwt from 'jsonwebtoken';
import { JWT } from '../config/constants';
import { canViewAllDevices, ownsDevice } from '../utils/tenant';

const router = Router();

// Enrollment token (JWT, 30d) embedded in install script / mobile link — ties devices to the installing account
function verifyEnrollToken(raw: unknown): string | null {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT.ACCESS_SECRET) as { sub?: unknown; typ?: unknown };
    if (payload?.typ === 'enroll' && typeof payload.sub === 'string' && payload.sub) return payload.sub;
  } catch {
    /* invalid/expired => unowned device */
  }
  return null;
}

// Non-admin accounts can only touch devices they own; others get 404 (no existence leak)
async function denyUnlessOwns(req: AuthRequest, res: Response, deviceId: string): Promise<boolean> {
  if (canViewAllDevices(req.user)) return true;
  if (await ownsDevice(req.user?.id, deviceId)) return true;
  res.status(404).json({ success: false, error: { message: 'Device not found' } });
  return false;
}

// Mark devices as offline if no heartbeat within threshold
// Uses configurable threshold (default 5 minutes) instead of hardcoded 2 minutes
export async function updateOfflineDevices() {
  try {
    const offlineThresholdSeconds = parseInt(process.env.OFFLINE_THRESHOLD || '300', 10);
    const thresholdMinutes = Math.max(1, Math.ceil(offlineThresholdSeconds / 60));
    await query(`UPDATE devices SET status = 'offline' WHERE status = 'online' AND last_heartbeat < NOW() - INTERVAL '${thresholdMinutes} minutes'`);
  } catch (e) {
    // ignore
  }
}

// Agent registration (no auth required, uses agent secret)
router.post('/register', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { agent_id, hostname, os_type, os_version, os_build, mac_address, ip_address } = req.body;

    if (!agent_id) {
      res.status(400).json({ success: false, error: { message: 'agent_id is required' } });
      return;
    }

    const agentSecret = req.headers['x-agent-secret'];
    if (agentSecret !== process.env.AGENT_SECRET) {
      res.status(401).json({ success: false, error: { message: 'Invalid agent secret' } });
      return;
    }

    const ownerUserId =
      verifyEnrollToken(req.body?.enroll_token) || verifyEnrollToken(req.headers['x-enroll-token']);

    const existing = await query('SELECT id, status FROM devices WHERE agent_id = $1', [agent_id]);
    if (existing.rows.length > 0) {
      if (ownerUserId) {
        await query(
          "UPDATE devices SET status = 'online', last_heartbeat = NOW(), created_by = COALESCE(created_by, $2) WHERE id = $1",
          [existing.rows[0].id, ownerUserId]
        );
      } else {
        await query("UPDATE devices SET status = 'online', last_heartbeat = NOW() WHERE id = $1", [existing.rows[0].id]);
      }
      res.json({ success: true, data: { id: existing.rows[0].id, agent_id, status: 'online', is_new: false } });
      return;
    }

    // Classify device type on registration when possible
    const inferredType = (() => {
      const os = (os_type || '').toLowerCase();
      if (os.includes('android') || os.includes('ios')) return 'MOBILE';
      if (os.includes('windows server') || os.includes('server')) return 'SERVER';
      if (os.includes('windows')) return 'DESKTOP';
      return 'UNKNOWN';
    })();

    const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    await query(
      `INSERT INTO devices (id, agent_id, hostname, os_type, os_version, os_build, mac_address, ip_address, status, last_heartbeat, is_authorized, device_type, ownership, trust_level, approval_status, first_seen, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, 'CORPORATE', 'KNOWN', 'approved', NOW(), $12)`,
      [id, agent_id, hostname || '', os_type || 'unknown', os_version || '', os_build || '', mac_address || '', ip_address || '', 'online', new Date(), inferredType, ownerUserId || null]
    );

    logger.info('New device registered', { deviceId: id, agent_id });
    res.status(201).json({ success: true, data: { id, agent_id, status: 'online', is_new: true } });
  } catch (error) {
    next(error);
  }
});

// Agent heartbeat
router.post('/heartbeat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { agent_id, cpu_usage, ram_usage, disk_usage, network_in, network_out, active_processes, agent_hash, current_version } = req.body;

    if (!agent_id) {
      res.status(400).json({ success: false, error: { message: 'agent_id is required' } });
      return;
    }

    const deviceResult = await query(
      "SELECT id, last_agent_hash, status, quarantine_status FROM devices WHERE agent_id = $1 AND is_authorized = true",
      [agent_id]
    );

    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found or not authorized' } });
      return;
    }

    const device = deviceResult.rows[0];
    const isContained = device.status === 'blocked' || device.status === 'quarantine'
      || device.quarantine_status === 'QUARANTINED' || device.quarantine_status === 'BLOCKED';
    const agentVersion = typeof current_version === 'string' && current_version.trim()
      ? current_version.trim().slice(0, 20)
      : null;

    // Contained devices: keep status (do NOT flip back to online); still accept metrics.
    if (isContained) {
      if (agentVersion) {
        await query(
          "UPDATE devices SET last_heartbeat = NOW(), cpu_usage = $1, ram_usage = $2, disk_usage = $3, agent_version = $4 WHERE id = $5",
          [cpu_usage || 0, ram_usage || 0, disk_usage || 0, agentVersion, device.id]
        );
      } else {
        await query(
          'UPDATE devices SET last_heartbeat = NOW(), cpu_usage = $1, ram_usage = $2, disk_usage = $3 WHERE id = $4',
          [cpu_usage || 0, ram_usage || 0, disk_usage || 0, device.id]
        );
      }
    } else if (agentVersion) {
      await query(
        "UPDATE devices SET status = 'online', last_heartbeat = NOW(), cpu_usage = $1, ram_usage = $2, disk_usage = $3, agent_version = $4 WHERE id = $5",
        [cpu_usage || 0, ram_usage || 0, disk_usage || 0, agentVersion, device.id]
      );
    } else {
      await query(
        "UPDATE devices SET status = 'online', last_heartbeat = NOW(), cpu_usage = $1, ram_usage = $2, disk_usage = $3 WHERE id = $4",
        [cpu_usage || 0, ram_usage || 0, disk_usage || 0, device.id]
      );
    }

    // Store agent hash if provided; detect tamper if it changes
    if (agent_hash) {
      if (device.last_agent_hash && device.last_agent_hash !== agent_hash) {
        // Hash mismatch — create a tamper alert
        const alertId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        const hostname = (await query('SELECT hostname FROM devices WHERE id = $1', [device.id])).rows[0]?.hostname || device.id;
        await query(
          'INSERT INTO alerts (id, device_id, alert_type, severity, title, description, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [
            alertId,
            device.id,
            'tamper_detected',
            'critical',
            'Agent Integrity Check Failed',
            `Agent file hash changed on ${hostname}. Expected: ${device.last_agent_hash}, Got: ${agent_hash}`,
            JSON.stringify({ device_hostname: hostname, expected_hash: device.last_agent_hash, current_hash: agent_hash }),
          ]
        );
        logger.warn('Agent tamper detected via heartbeat', { agent_id, expected: device.last_agent_hash, actual: agent_hash });
      }
      await query('UPDATE devices SET last_agent_hash = $1 WHERE id = $2', [agent_hash, device.id]);
    }

    const hbId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    await query('INSERT INTO device_heartbeats (id, device_id, cpu_usage, ram_usage, disk_usage, network_in, network_out, active_processes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [hbId, device.id, cpu_usage || 0, ram_usage || 0, disk_usage || 0, network_in || 0, network_out || 0, active_processes || 0]);

    // Contained devices: only receive containment-related commands (isolate/unisolate/quarantine)
    const commands = await query(
      isContained
        ? `SELECT id, command_type, parameters FROM agent_commands
            WHERE device_id = $1 AND status = 'pending'
              AND command_type IN ('isolate', 'unisolate', 'quarantine')
            ORDER BY created_at ASC LIMIT 5`
        : `SELECT id, command_type, parameters FROM agent_commands
            WHERE device_id = $1 AND status = 'pending'
            ORDER BY created_at ASC LIMIT 10`,
      [device.id]
    );
    for (const cmd of commands.rows) {
      await query("UPDATE agent_commands SET status = 'processing' WHERE id = $1", [cmd.id]);
    }

    res.json({
      success: true,
      data: {
        device_id: device.id,
        commands: commands.rows,
        agent_version: '1.1.0',
        status: device.status,
        contained: isContained,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Enrollment token for the logged-in account (embedded in install script / mobile QR link)
router.get('/enroll-token', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: { message: 'Not authenticated' } });
      return;
    }
    const token = jwt.sign({ sub: userId, typ: 'enroll' }, JWT.ACCESS_SECRET, { expiresIn: '30d' });
    res.json({ success: true, data: { token, expires_in: '30d' } });
  } catch (error) {
    next(error);
  }
});

// List devices
router.get('/', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    updateOfflineDevices();
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string || '';
    const status = req.query.status as string || '';
    const offset = (page - 1) * limit;
    const viewAll = canViewAllDevices(req.user);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (search) {
      conditions.push(`(d.hostname LIKE $${paramIdx} OR d.agent_id LIKE $${paramIdx + 1} OR d.ip_address::text LIKE $${paramIdx + 2})`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      paramIdx += 3;
    }
    if (status) {
      conditions.push(`d.status = $${paramIdx}`);
      params.push(status);
      paramIdx += 1;
    }
    if (!viewAll) {
      conditions.push(`d.created_by = $${paramIdx}`);
      params.push(req.user!.id);
      paramIdx += 1;
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(`SELECT COUNT(*) as total FROM devices d ${whereClause}`, params);
    const total = countResult.rows[0]?.total || 0;

    const result = await query(
      `SELECT d.*, u.email as owner_email
         FROM devices d LEFT JOIN users u ON u.id = d.created_by
        ${whereClause}
        ORDER BY d.last_heartbeat DESC
        LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    res.json({ success: true, data: { devices: result.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } } });
  } catch (error) {
    next(error);
  }
});

// Map locations: mobile GPS + IP geolocation fallback for PCs
const geoCache = new Map<string, { lat: number; lng: number; expires: number }>();

function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  if (ip.startsWith('10.') || ip.startsWith('127.') || ip.startsWith('169.254.')) return true;
  if (ip.startsWith('192.168.')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m) {
    const octet = parseInt(m[1], 10);
    if (octet >= 16 && octet <= 31) return true;
  }
  return false;
}

router.get('/map', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    updateOfflineDevices();
    const viewAll = canViewAllDevices(req.user);
    const result = await query(
      `SELECT d.id, d.hostname, d.display_name, d.os_type, d.device_type, d.status, d.latitude, d.longitude,
              d.battery_level, d.last_heartbeat, d.ip_address, d.location_updated_at, d.approval_status, d.agent_id,
              u.email as owner_email
         FROM devices d
         LEFT JOIN users u ON u.id = d.created_by
        ${viewAll ? '' : 'WHERE d.created_by = $1'}
        ORDER BY d.last_heartbeat DESC NULLS LAST`,
      viewAll ? [] : [req.user!.id]
    );
    const devices = result.rows as Array<Record<string, unknown> & { latitude: number | null; longitude: number | null; ip_address: string | null }>;
    for (const d of devices) {
      d.geo_source = d.latitude != null && d.longitude != null ? 'gps' : null;
    }

    // IP geolocation for devices without GPS (public IPs only, cached 6h)
    const needsIpGeo = devices
      .filter((d) => d.latitude == null && d.ip_address && !isPrivateIp(d.ip_address))
      .slice(0, 25);
    await Promise.all(
      needsIpGeo.map(async (d) => {
        const now = Date.now();
        const cached = geoCache.get(d.ip_address!);
        if (cached && cached.expires > now) {
          d.latitude = cached.lat;
          d.longitude = cached.lng;
          d.geo_source = 'ip';
          return;
        }
        try {
          const resp = await fetch(`http://ip-api.com/json/${encodeURIComponent(d.ip_address!)}?fields=status,lat,lon`);
          const body = (await resp.json()) as { status?: string; lat?: number; lon?: number };
          if (body?.status === 'success' && typeof body.lat === 'number' && typeof body.lon === 'number') {
            geoCache.set(d.ip_address!, { lat: body.lat, lng: body.lon, expires: now + 6 * 60 * 60 * 1000 });
            d.latitude = body.lat;
            d.longitude = body.lon;
            d.geo_source = 'ip';
          }
        } catch {
          // ignore lookup failures
        }
      })
    );

    res.json({ success: true, data: { devices } });
  } catch (error) {
    next(error);
  }
});

// Get single device
router.get('/:id', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const deviceResult = await query(
      'SELECT d.*, u.email as owner_email FROM devices d LEFT JOIN users u ON u.id = d.created_by WHERE d.id = $1',
      [id]
    );
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }
    if (!canViewAllDevices(req.user) && deviceResult.rows[0].created_by !== req.user?.id) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const heartbeats = await query('SELECT * FROM device_heartbeats WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 24', [id]);
    const events = await query('SELECT * FROM security_events WHERE device_id = $1 ORDER BY created_at DESC LIMIT 10', [id]);
    const software = await query('SELECT * FROM device_software WHERE device_id = $1 ORDER BY name ASC', [id]);
    const services = await query('SELECT * FROM device_services WHERE device_id = $1 ORDER BY name ASC', [id]);
    const processes = await query('SELECT * FROM device_processes WHERE device_id = $1 ORDER BY cpu_usage DESC LIMIT 100', [id]);
    const networkInterfaces = await query('SELECT * FROM device_network_interfaces WHERE device_id = $1', [id]);
    const commands = await query('SELECT * FROM agent_commands WHERE device_id = $1 ORDER BY created_at DESC LIMIT 50', [id]);

    res.json({
      success: true,
      data: {
        device: {
          ...deviceResult.rows[0],
          recent_heartbeats: heartbeats.rows,
          recent_events: events.rows,
          software: software.rows,
          services: services.rows,
          processes: processes.rows,
          network_interfaces: networkInterfaces.rows,
          recent_commands: commands.rows,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// Update device
router.put('/:id', authenticate, requirePermission('devices.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!(await denyUnlessOwns(req, res, id))) return;
    const { display_name, user_id, notes, is_authorized } = req.body;

    await query('UPDATE devices SET display_name = COALESCE($1, display_name), user_id = COALESCE($2, user_id), notes = COALESCE($3, notes), is_authorized = COALESCE($4, is_authorized) WHERE id = $5',
      [display_name ?? null, user_id ?? null, notes ?? null, is_authorized ?? null, id]);

    await query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'device_update', 'device', id, 'Device updated', req.ip]);

    res.json({ success: true, data: { message: 'Device updated' } });
  } catch (error) {
    next(error);
  }
});

// Delete device
router.delete('/:id', authenticate, requirePermission('devices.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!(await denyUnlessOwns(req, res, id))) return;
    await query('DELETE FROM devices WHERE id = $1', [id]);

    await query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'device_delete', 'device', id, 'Device deleted', req.ip]);

    res.json({ success: true, data: { message: 'Device deleted' } });
  } catch (error) {
    next(error);
  }
});

async function queueContainmentCommand(deviceId: string, commandType: 'isolate' | 'unisolate', issuedBy: string | null, reason: string) {
  const cmdId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  await query(
    'INSERT INTO agent_commands (id, device_id, command_type, parameters, status, issued_by) VALUES ($1, $2, $3, $4, $5, $6)',
    [cmdId, deviceId, commandType, JSON.stringify({ reason, queued_at: new Date().toISOString() }), 'pending', issuedBy]
  );
  return cmdId;
}

// Block device (containment: status + isolate agent firewall)
router.post('/:id/block', authenticate, requirePermission('devices.block'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!(await denyUnlessOwns(req, res, id))) return;
    await query(
      "UPDATE devices SET status = 'blocked', quarantine_status = 'BLOCKED', trust_level = 'BLOCKED', updated_at = NOW() WHERE id = $1",
      [id]
    );
    const cmdId = await queueContainmentCommand(id, 'isolate', req.user?.id || null, 'device_block');

    await query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'device_block', 'device', id, 'Device blocked + isolate queued', req.ip]);

    res.json({ success: true, data: { message: 'Device blocked', command_id: cmdId } });
  } catch (error) {
    next(error);
  }
});

// Update agent on device (sends update command)
router.post('/:id/update-agent', authenticate, requirePermission('devices.commands'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!(await denyUnlessOwns(req, res, id))) return;
    const deviceResult = await query('SELECT agent_id FROM devices WHERE id = $1', [id]);
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const updateUrl = 'https://raw.githubusercontent.com/Masukulmiguel/endpointx/main/endpoint-agent';
    const params = { update_url: updateUrl, ...(req.body || {}) };
    const cmdId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    await query('INSERT INTO agent_commands (id, device_id, command_type, parameters, status, issued_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [cmdId, id, 'update_agent', JSON.stringify(params), 'pending', req.user?.id]);

    await query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'agent_update', 'device', id, 'Agent update command sent', req.ip]);

    res.json({ success: true, data: { message: 'Agent update command sent', command_id: cmdId } });
  } catch (error) {
    next(error);
  }
});

// Unblock device (lift containment)
router.post('/:id/unblock', authenticate, requirePermission('devices.block'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!(await denyUnlessOwns(req, res, id))) return;
    await query(
      "UPDATE devices SET status = 'online', quarantine_status = 'NORMAL', trust_level = CASE WHEN trust_level IN ('BLOCKED','QUARANTINED') THEN 'KNOWN' ELSE trust_level END, updated_at = NOW() WHERE id = $1",
      [id]
    );
    const cmdId = await queueContainmentCommand(id, 'unisolate', req.user?.id || null, 'device_unblock');

    await query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'device_unblock', 'device', id, 'Device unblocked + unisolate queued', req.ip]);

    res.json({ success: true, data: { message: 'Device unblocked', command_id: cmdId } });
  } catch (error) {
    next(error);
  }
});

// Quarantine device (containment)
router.post('/:id/quarantine', authenticate, requirePermission('devices.quarantine'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!(await denyUnlessOwns(req, res, id))) return;
    await query(
      "UPDATE devices SET status = 'quarantine', quarantine_status = 'QUARANTINED', trust_level = 'QUARANTINED', updated_at = NOW() WHERE id = $1",
      [id]
    );
    const cmdId = await queueContainmentCommand(id, 'isolate', req.user?.id || null, 'device_quarantine');

    await query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'device_quarantine', 'device', id, 'Device quarantined + isolate queued', req.ip]);

    res.json({ success: true, data: { message: 'Device quarantined', command_id: cmdId } });
  } catch (error) {
    next(error);
  }
});

// Get device history
router.get('/:id/history', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!(await denyUnlessOwns(req, res, id))) return;
    const heartbeats = await query('SELECT * FROM device_heartbeats WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 100', [id]);
    res.json({ success: true, data: { heartbeats: heartbeats.rows } });
  } catch (error) {
    next(error);
  }
});

// Agent inventory (no auth required, uses agent secret)
router.post('/inventory', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { agent_id, software, services, processes, network_interfaces } = req.body;

    if (!agent_id) {
      res.status(400).json({ success: false, error: { message: 'agent_id is required' } });
      return;
    }

    const agentSecret = req.headers['x-agent-secret'];
    if (agentSecret !== process.env.AGENT_SECRET) {
      res.status(401).json({ success: false, error: { message: 'Invalid agent secret' } });
      return;
    }

    const deviceResult = await query('SELECT id FROM devices WHERE agent_id = $1', [agent_id]);
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const deviceId = deviceResult.rows[0].id;

    // Clear old data and insert new
    await query('DELETE FROM device_software WHERE device_id = $1', [deviceId]);
    if (Array.isArray(software)) {
      for (const sw of software) {
        const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        await query('INSERT INTO device_software (id, device_id, name, version, publisher, install_date) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, deviceId, sw.name || '', sw.version || '', sw.publisher || '', sw.install_date || null]);
      }
    }

    await query('DELETE FROM device_services WHERE device_id = $1', [deviceId]);
    if (Array.isArray(services)) {
      for (const svc of services) {
        const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        await query('INSERT INTO device_services (id, device_id, name, display_name, status, startup_type) VALUES ($1, $2, $3, $4, $5, $6)',
          [id, deviceId, svc.name || '', svc.display_name || svc.name || '', svc.status || '', svc.startup_type || '']);
      }
    }

    await query('DELETE FROM device_processes WHERE device_id = $1', [deviceId]);
    if (Array.isArray(processes)) {
      for (const proc of processes) {
        const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        await query('INSERT INTO device_processes (id, device_id, pid, name, cpu_usage, memory_usage, user_name) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [id, deviceId, proc.pid || 0, proc.name || '', proc.cpu_percent || proc.cpu_usage || 0, proc.memory_bytes || proc.memory_usage || 0, proc.user || proc.user_name || '']);
      }
    }

    await query('DELETE FROM device_network_interfaces WHERE device_id = $1', [deviceId]);
    if (Array.isArray(network_interfaces)) {
      for (const iface of network_interfaces) {
        const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        await query('INSERT INTO device_network_interfaces (id, device_id, name, mac_address, ipv4_address, ipv6_address, is_connected, speed_mbps) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [id, deviceId, iface.name || '', iface.mac || iface.mac_address || '', iface.ipv4 || iface.ipv4_address || '', iface.ipv6 || iface.ipv6_address || '', iface.is_connected ? true : false, iface.speed || iface.speed_mbps || 0]);
      }
    }

    await query("UPDATE devices SET last_inventory = NOW() WHERE id = $1", [deviceId]);

    logger.info('Inventory updated', { deviceId, agent_id });
    res.json({ success: true, data: { message: 'Inventory updated' } });
  } catch (error) {
    next(error);
  }
});

// Agent reports command result (no auth required, uses agent secret)
router.post('/command-result', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { agent_id, command_id, status, result, error_message } = req.body;

    if (!agent_id || !command_id) {
      res.status(400).json({ success: false, error: { message: 'agent_id and command_id are required' } });
      return;
    }

    const agentSecret = req.headers['x-agent-secret'];
    if (agentSecret !== process.env.AGENT_SECRET) {
      res.status(401).json({ success: false, error: { message: 'Invalid agent secret' } });
      return;
    }

    const deviceResult = await query('SELECT id FROM devices WHERE agent_id = $1', [agent_id]);
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const validStatus = ['completed', 'failed'].includes(status) ? status : 'failed';
    const resultStr = result ? (typeof result === 'string' ? result : JSON.stringify(result)) : null;
    const errorStr = error_message || null;

    await query("UPDATE agent_commands SET status = $1, result = $2, error_message = $3, executed_at = NOW(), completed_at = NOW() WHERE id = $4 AND device_id = $5",
      [validStatus, resultStr, errorStr, command_id, deviceResult.rows[0].id]);

    logger.info('Command result received', { command_id, status: validStatus });
    res.json({ success: true, data: { message: 'Command result recorded' } });
  } catch (error) {
    next(error);
  }
});

// Agent security scan - receives security data and generates events + alerts
router.post('/security-scan', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { agent_id, scan_type, firewall, antivirus, high_cpu_processes, suspicious_connections, findings } = req.body;

    if (!agent_id) {
      res.status(400).json({ success: false, error: { message: 'agent_id is required' } });
      return;
    }

    const agentSecret = req.headers['x-agent-secret'];
    if (agentSecret !== process.env.AGENT_SECRET) {
      res.status(401).json({ success: false, error: { message: 'Invalid agent secret' } });
      return;
    }

    const deviceResult = await query('SELECT id, hostname FROM devices WHERE agent_id = $1', [agent_id]);
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const device = deviceResult.rows[0];
    const events: Array<{ event_type: string; severity: string; title: string; description: string }> = [];

    // Check firewall
    if (firewall && !firewall.enabled) {
      events.push({
        event_type: 'firewall_disabled',
        severity: 'high',
        title: 'Firewall Disabled',
        description: `Firewall is disabled on ${device.hostname}`,
      });
    }

    // Check antivirus
    if (antivirus && !antivirus.enabled) {
      events.push({
        event_type: 'antivirus_disabled',
        severity: 'high',
        title: 'Antivirus Disabled',
        description: `Antivirus is not running on ${device.hostname}`,
      });
    }

    // Check high CPU processes
    if (high_cpu_processes && high_cpu_processes.length > 0) {
      const procs = high_cpu_processes.slice(0, 5);
      events.push({
        event_type: 'high_cpu_usage',
        severity: 'medium',
        title: 'High CPU Usage Detected',
        description: `${procs.length} processes using high CPU: ${procs.map((p: any) => p.name || p).join(', ')}`,
      });
    }

    // Check suspicious connections
    if (suspicious_connections && suspicious_connections.length > 0) {
      events.push({
        event_type: 'suspicious_network',
        severity: 'critical',
        title: 'Suspicious Network Activity',
        description: `${suspicious_connections.length} suspicious connections detected on ${device.hostname}`,
      });
    }

    // Custom findings from agent
    if (findings && Array.isArray(findings)) {
      for (const f of findings) {
        events.push({
          event_type: f.type || 'security_finding',
          severity: f.severity || 'info',
          title: f.title || 'Security Finding',
          description: f.description || '',
        });
      }
    }

    // Insert events and auto-create alerts
    for (const evt of events) {
      const eventId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      await query('INSERT INTO security_events (id, device_id, event_type, severity, title, description, source) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [eventId, device.id, evt.event_type, evt.severity, evt.title, evt.description, 'agent_scan']);

      // Auto-create alerts for critical and high severity
      if (evt.severity === 'critical' || evt.severity === 'high') {
        const alertId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        await query('INSERT INTO alerts (id, device_id, alert_type, severity, title, description, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [alertId, device.id, evt.event_type, evt.severity, evt.title, evt.description, JSON.stringify({ device_hostname: device.hostname })]);
      }
    }

    logger.info('Security scan received', { agent_id, events: events.length });
    res.json({ success: true, data: { message: 'Security scan processed', events_created: events.length } });
  } catch (error) {
    next(error);
  }
});

// Agent heartbeat report alerts
router.post('/alerts', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { agent_id, alerts } = req.body;

    if (!agent_id || !alerts || !Array.isArray(alerts)) {
      res.status(400).json({ success: false, error: { message: 'agent_id and alerts array required' } });
      return;
    }

    const agentSecret = req.headers['x-agent-secret'];
    if (agentSecret !== process.env.AGENT_SECRET) {
      res.status(401).json({ success: false, error: { message: 'Invalid agent secret' } });
      return;
    }

    const deviceResult = await query('SELECT id, hostname FROM devices WHERE agent_id = $1', [agent_id]);
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const device = deviceResult.rows[0];
    let created = 0;

    for (const alert of alerts) {
      // Check if similar alert already exists in last hour
      const existing = await query("SELECT id FROM alerts WHERE device_id = $1 AND alert_type = $2 AND created_at > NOW() - INTERVAL '1 hour' LIMIT 1",
        [device.id, alert.alert_type || alert.type]);
      if (existing.rows.length > 0) continue;

      const alertId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      await query('INSERT INTO alerts (id, device_id, alert_type, severity, title, description, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [alertId, device.id, alert.alert_type || alert.type, alert.severity || 'medium', alert.title, alert.description || '', JSON.stringify({ device_hostname: device.hostname })]);
      created++;
    }

    res.json({ success: true, data: { message: 'Alerts processed', created } });
  } catch (error) {
    next(error);
  }
});

// Download agent installer script
router.get('/download/installer', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const serverUrl = `${req.protocol}://${req.get('host')}/api`;
    const agentSecret = process.env.AGENT_SECRET || 'dev_agent_secret_123';
    const platform = (req.query.platform as string) || 'windows';
    const enrollToken = req.user?.id
      ? jwt.sign({ sub: req.user.id, typ: 'enroll' }, JWT.ACCESS_SECRET, { expiresIn: '30d' })
      : '';

    if (platform === 'linux') {
      const filePath = join(__dirname, '..', '..', 'endpoint-agent', 'install-linux.sh');
      if (!existsSync(filePath)) {
        res.status(404).json({ success: false, error: { message: 'Linux install script not found' } });
        return;
      }
      let script = readFileSync(filePath, 'utf-8');
      script = script.replace(/##SERVER_URL##/g, serverUrl.replace('/api', ''));
      script = script.replace(/##AGENT_SECRET##/g, agentSecret);
      script = script.replace(/##ENROLL_TOKEN##/g, enrollToken);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="install-endpointx-linux.sh"');
      res.send(script);
      return;
    }

    if (platform === 'macos') {
      const filePath = join(__dirname, '..', '..', 'endpoint-agent', 'install-macos.sh');
      if (!existsSync(filePath)) {
        res.status(404).json({ success: false, error: { message: 'macOS install script not found' } });
        return;
      }
      let script = readFileSync(filePath, 'utf-8');
      script = script.replace(/##SERVER_URL##/g, serverUrl.replace('/api', ''));
      script = script.replace(/##AGENT_SECRET##/g, agentSecret);
      script = script.replace(/##ENROLL_TOKEN##/g, enrollToken);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="install-endpointx-macos.sh"');
      res.send(script);
      return;
    }

    // Default: Windows PowerShell
    const script = `$ErrorActionPreference = "SilentlyContinue"
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  EndpointX Agent Installer" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Check Python
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
    Write-Host "ERROR: Python not found!" -ForegroundColor Red
    Write-Host "Download from: https://www.python.org/downloads/" -ForegroundColor Yellow
    Write-Host "Check: Add Python to PATH" -ForegroundColor Yellow
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "[1/5] Creating folder..." -ForegroundColor Green
New-Item -ItemType Directory -Force -Path "C:\\endpointx\\endpoint-agent" | Out-Null

Write-Host "[2/5] Downloading agent files..." -ForegroundColor Green
$base = "${serverUrl.replace('/api', '')}"
Invoke-WebRequest -Uri "$base/download/agent/agent.py" -OutFile "C:\\endpointx\\endpoint-agent\\agent.py"
Invoke-WebRequest -Uri "$base/download/agent/system_info.py" -OutFile "C:\\endpointx\\endpoint-agent\\system_info.py"
Invoke-WebRequest -Uri "$base/download/agent/requirements.txt" -OutFile "C:\\endpointx\\endpoint-agent\\requirements.txt"

# Create config
Write-Host "[3/5] Creating config..." -ForegroundColor Green
@"
agent_id: AUTO
agent_secret: ${agentSecret}
enroll_token: ${enrollToken}
heartbeat_interval: 60
log_file: endpointx-agent.log
log_level: INFO
server_url: ${serverUrl}
"@ | Out-File -FilePath "C:\\endpointx\\endpoint-agent\\config.yaml" -Encoding utf8

Write-Host "[4/5] Installing dependencies..." -ForegroundColor Green
pip install psutil requests pyyaml 2>$null

Write-Host "[5/5] Registering device..." -ForegroundColor Green
cd C:\\endpointx\\endpoint-agent
python agent.py --register

# Create background launcher
echo Set WshShell = CreateObject("WScript.Shell") > "C:\\endpointx\\endpoint-agent\\start_agent.vbs"
echo WshShell.CurrentDirectory = "C:\\endpointx\\endpoint-agent" >> "C:\\endpointx\\endpoint-agent\\start_agent.vbs"
echo WshShell.Run "pythonw.exe agent.py", 0, False >> "C:\\endpointx\\endpoint-agent\\start_agent.vbs"

# Add to startup
Copy-Item "C:\\endpointx\\endpoint-agent\\start_agent.vbs" "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\endpointx.vbs" -Force

# Start agent
Write-Host "[6/6] Starting agent..." -ForegroundColor Green
Start-Process -FilePath "wscript.exe" -ArgumentList "C:\\endpointx\\endpoint-agent\\start_agent.vbs"

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Installation complete!" -ForegroundColor Green
Write-Host "  Agent is running in background." -ForegroundColor Green
Write-Host "  Auto-starts on login." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Read-Host "Press Enter to close"`;

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="install-endpointx.ps1"');
    res.send(script);
  } catch (error) {
    next(error);
  }
});

// Download agent files
router.get('/download/agent/:filename', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { filename } = req.params;
    const allowedFiles = ['agent.py', 'system_info.py', 'requirements.txt', 'crypto_utils.py'];

    if (!allowedFiles.includes(filename)) {
      res.status(404).json({ success: false, error: { message: 'File not found' } });
      return;
    }

    const filePath = join(__dirname, '..', '..', 'endpoint-agent', filename);
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'File not found on server' } });
      return;
    }

    const content = readFileSync(filePath, 'utf-8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
  } catch (error) {
    next(error);
  }
});

// PUBLIC - Download installer (no auth required)
router.get('/public/install.ps1', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const host = req.get('host') || 'endpointx.onrender.com';
    const protocol = req.protocol === 'https' ? 'https' : 'https';
    const serverUrl = `${protocol}://${host}`;
    const agentSecret = process.env.AGENT_SECRET || 'dev_agent_secret_123';

    const filePath = join(__dirname, '..', '..', 'public', 'install.ps1');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'Install script not found' } });
      return;
    }

    let script = readFileSync(filePath, 'utf-8');
    script = script.replace(/##SERVER_URL##/g, serverUrl);
    script = script.replace(/##AGENT_SECRET##/g, agentSecret);
    script = script.replace(/##ENROLL_TOKEN##/g, verifyEnrollToken(req.query.t) || '');

    // text/plain (no attachment) so `irm ... | iex` receives a clean string
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(script);
  } catch (error) {
    next(error);
  }
});

// PUBLIC - Download Linux install script (no auth required)
router.get('/public/install-linux.sh', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const host = req.get('host') || 'endpointx.onrender.com';
    const protocol = req.protocol === 'https' ? 'https' : 'https';
    const serverUrl = `${protocol}://${host}`;
    const agentSecret = process.env.AGENT_SECRET || 'dev_agent_secret_123';

    const filePath = join(__dirname, '..', '..', 'endpoint-agent', 'install-linux.sh');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'Linux install script not found' } });
      return;
    }

    let script = readFileSync(filePath, 'utf-8');
    script = script.replace(/##SERVER_URL##/g, serverUrl);
    script = script.replace(/##AGENT_SECRET##/g, agentSecret);
    script = script.replace(/##ENROLL_TOKEN##/g, verifyEnrollToken(req.query.t) || '');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="install-endpointx-linux.sh"');
    res.send(script);
  } catch (error) {
    next(error);
  }
});

// PUBLIC - Download macOS install script (no auth required)
router.get('/public/install-macos.sh', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const host = req.get('host') || 'endpointx.onrender.com';
    const protocol = req.protocol === 'https' ? 'https' : 'https';
    const serverUrl = `${protocol}://${host}`;
    const agentSecret = process.env.AGENT_SECRET || 'dev_agent_secret_123';

    const filePath = join(__dirname, '..', '..', 'endpoint-agent', 'install-macos.sh');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'macOS install script not found' } });
      return;
    }

    let script = readFileSync(filePath, 'utf-8');
    script = script.replace(/##SERVER_URL##/g, serverUrl);
    script = script.replace(/##AGENT_SECRET##/g, agentSecret);
    script = script.replace(/##ENROLL_TOKEN##/g, verifyEnrollToken(req.query.t) || '');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="install-endpointx-macos.sh"');
    res.send(script);
  } catch (error) {
    next(error);
  }
});

// PUBLIC - Download agent files (no auth required)
router.get('/download/public/:filename', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { filename } = req.params;
    const allowedFiles = ['agent.py', 'system_info.py', 'requirements.txt', 'crypto_utils.py'];

    if (!allowedFiles.includes(filename)) {
      res.status(404).json({ success: false, error: { message: 'File not found' } });
      return;
    }

    const filePath = join(__dirname, '..', '..', 'endpoint-agent', filename);
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'File not found on server' } });
      return;
    }

    const content = readFileSync(filePath, 'utf-8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(content);
  } catch (error) {
    next(error);
  }
});

// PUBLIC - Download update script (no auth required)
router.get('/public/update.ps1', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filePath = join(__dirname, '..', '..', 'public', 'update.ps1');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'Update script not found' } });
      return;
    }

    const script = readFileSync(filePath, 'utf-8');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(script);
  } catch (error) {
    next(error);
  }
});

// PUBLIC - Mobile enrollment page (Android / iOS)
router.get('/public/install-mobile.html', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filePath = join(__dirname, '..', '..', 'public', 'install-mobile.html');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'Mobile page not found' } });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    next(error);
  }
});

router.get('/public/mobile', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filePath = join(__dirname, '..', '..', 'public', 'install-mobile.html');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'Mobile page not found' } });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    next(error);
  }
});

// PUBLIC - PWA service worker (keeps enrollment reachable + background sync heartbeats)
router.get('/public/sw.js', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filePath = join(__dirname, '..', '..', 'public', 'sw.js');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'Service worker not found' } });
      return;
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    next(error);
  }
});

// PUBLIC - PWA manifest (install to home screen; persists until uninstall/factory reset)
router.get('/public/manifest.webmanifest', async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filePath = join(__dirname, '..', '..', 'public', 'manifest.webmanifest');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'Manifest not found' } });
      return;
    }
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    next(error);
  }
});

// PUBLIC - Mobile self-registration (device identity only, no private content)
router.post('/mobile/register', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const {
      device_name,
      owner,
      ownership,
      department,
      os_type,
      device_type,
      model,
      user_agent,
      source,
      agent_id: clientAgentId,
      enroll_token,
    } = req.body as Record<string, string | undefined>;

    const ownerUserId = verifyEnrollToken(enroll_token);

    const name = (device_name || '').trim().slice(0, 80);
    if (!name) {
      res.status(400).json({ success: false, error: { message: 'device_name is required' } });
      return;
    }

    const ownershipValue = ['BYOD', 'CORPORATE', 'GUEST'].includes(ownership || '')
      ? ownership!
      : 'BYOD';
    const os = ['android', 'ios', 'ipados'].includes((os_type || '').toLowerCase())
      ? os_type!.toLowerCase()
      : 'android';
    const inferredType = ['MOBILE', 'TABLET'].includes((device_type || '').toUpperCase())
      ? device_type!.toUpperCase()
      : 'MOBILE';

    let agentId = (clientAgentId || '').trim().slice(0, 64);
    if (!agentId) {
      agentId = `mobile-${Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;
    }
    if (!agentId.startsWith('mobile-')) {
      agentId = `mobile-${agentId}`;
    }

    const existing = await query('SELECT id, approval_status FROM devices WHERE agent_id = $1', [agentId]);
    if (existing.rows.length > 0) {
      const deviceId = existing.rows[0].id;
      await query(
        `UPDATE devices SET
           hostname = $1,
           display_name = $1,
           device_type = $2,
           os_type = $3,
           manufacturer = COALESCE(NULLIF($4, ''), manufacturer),
           model = COALESCE(NULLIF($5, ''), model),
           ownership = $6,
           department = COALESCE(NULLIF($7, ''), department),
           notes = COALESCE(NULLIF($8, ''), notes),
           trust_level = CASE WHEN approval_status = 'pending' THEN 'UNKNOWN' ELSE trust_level END,
           created_by = COALESCE(created_by, $10),
           updated_at = NOW()
         WHERE id = $9`,
        [
          name,
          inferredType,
          os,
          (user_agent || '').includes('iPhone') ? 'Apple' : (user_agent || '').includes('Android') ? 'Android' : '',
          model || '',
          ownershipValue,
          (department || '').trim().slice(0, 80),
          `Mobile enrollment (${source || 'page'})`,
          deviceId,
          ownerUserId || null,
        ]
      );
      res.json({
        success: true,
        data: {
          device_id: deviceId,
          agent_id: agentId,
          approval_status: existing.rows[0].approval_status || 'pending',
          is_new: false,
        },
      });
      return;
    }

    const deviceId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    await query(
      `INSERT INTO devices (
         id, agent_id, hostname, display_name, os_type, device_type, manufacturer, model,
         ownership, department, status, is_authorized, trust_level, approval_status,
         managed, mdm_enrolled, quarantine_status, first_seen, registered_at, notes, created_by
       ) VALUES (
         $1, $2, $3, $3, $4, $5, $6, $7,
         $8, $9, 'offline', false, 'UNKNOWN', 'pending',
         false, false, 'none', NOW(), NOW(), $10, $11
       )`,
      [
        deviceId,
        agentId,
        name,
        os,
        inferredType,
        (user_agent || '').includes('iPhone') || (user_agent || '').includes('iPad') ? 'Apple'
          : (user_agent || '').includes('Android') ? 'Android' : '',
        (model || '').trim().slice(0, 80),
        ownershipValue,
        (department || '').trim().slice(0, 80),
        `Mobile enrollment (${source || 'page'})${owner ? `; owner=${String(owner).slice(0, 80)}` : ''}`,
        ownerUserId || null,
      ]
    );

    logger.info('Mobile device enrolled', { deviceId, agentId, ownership: ownershipValue });
    res.status(201).json({
      success: true,
      data: {
        device_id: deviceId,
        agent_id: agentId,
        approval_status: 'pending',
        is_new: true,
      },
    });
  } catch (error) {
    next(error);
  }
});

// PUBLIC - Mobile presence heartbeat (page open => device online; no agent telemetry)
router.post('/mobile/heartbeat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { agent_id: clientAgentId, battery_level, latitude, longitude } = req.body as Record<string, unknown>;
    const agentId = String(clientAgentId || '').trim().slice(0, 64);
    if (!agentId.startsWith('mobile-')) {
      res.status(400).json({ success: false, error: { message: 'Invalid agent_id' } });
      return;
    }
    const existing = await query('SELECT id, status FROM devices WHERE agent_id = $1', [agentId]);
    if (existing.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not enrolled' } });
      return;
    }
    const rawBattery = typeof battery_level === 'number' ? battery_level : NaN;
    const battery = Number.isFinite(rawBattery) ? Math.min(100, Math.max(0, Math.round(rawBattery))) : null;
    const lat = typeof latitude === 'number' && Number.isFinite(latitude) && Math.abs(latitude) <= 90 ? latitude : null;
    const lng = typeof longitude === 'number' && Number.isFinite(longitude) && Math.abs(longitude) <= 180 ? longitude : null;
    const fwd = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim() || req.ip || null;
    const currentStatus = String(existing.rows[0].status || 'offline');
    // Preserve blocked/quarantine/alert; only an offline device flips to online
    const nextStatus = currentStatus === 'offline' ? 'online' : currentStatus;
    await query(
      `UPDATE devices
         SET status = $1, last_heartbeat = NOW(), ip_address = COALESCE($2, ip_address),
             battery_level = COALESCE($3, battery_level),
             latitude = COALESCE($4, latitude),
             longitude = COALESCE($5, longitude),
             location_updated_at = CASE WHEN $4::double precision IS NOT NULL THEN NOW() ELSE location_updated_at END,
             updated_at = NOW()
       WHERE id = $6`,
      [nextStatus, ip, battery, lat, lng, existing.rows[0].id]
    );
    res.json({
      success: true,
      data: {
        status: nextStatus,
        last_heartbeat: new Date().toISOString(),
        location: lat != null && lng != null ? { latitude: lat, longitude: lng } : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;

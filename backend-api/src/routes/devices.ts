import { Router } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { Response, NextFunction } from 'express';
import logger from '../utils/logger';

const router = Router();

// Mark devices as offline if no heartbeat in last 2 minutes
function updateOfflineDevices() {
  try {
    query("UPDATE devices SET status = 'offline' WHERE status = 'online' AND last_heartbeat < datetime('now', '-2 minutes')");
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

    const existing = query('SELECT id, status FROM devices WHERE agent_id = ?', [agent_id]);
    if (existing.rows.length > 0) {
      query("UPDATE devices SET status = 'online', last_heartbeat = datetime('now') WHERE id = ?", [existing.rows[0].id]);
      res.json({ success: true, data: { id: existing.rows[0].id, agent_id, status: 'online', is_new: false } });
      return;
    }

    const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    query('INSERT INTO devices (id, agent_id, hostname, os_type, os_version, os_build, mac_address, ip_address, status, last_heartbeat, is_authorized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, agent_id, hostname || '', os_type || 'unknown', os_version || '', os_build || '', mac_address || '', ip_address || '', 'online', new Date().toISOString(), 1]);

    logger.info('New device registered', { deviceId: id, agent_id });
    res.status(201).json({ success: true, data: { id, agent_id, status: 'online', is_new: true } });
  } catch (error) {
    next(error);
  }
});

// Agent heartbeat
router.post('/heartbeat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { agent_id, cpu_usage, ram_usage, disk_usage, network_in, network_out, active_processes } = req.body;

    if (!agent_id) {
      res.status(400).json({ success: false, error: { message: 'agent_id is required' } });
      return;
    }

    const deviceResult = query("UPDATE devices SET status = 'online', last_heartbeat = datetime('now'), cpu_usage = ?, ram_usage = ?, disk_usage = ? WHERE agent_id = ? AND is_authorized = 1 RETURNING id",
      [cpu_usage || 0, ram_usage || 0, disk_usage || 0, agent_id]);

    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found or not authorized' } });
      return;
    }

    const device = deviceResult.rows[0];
    const hbId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    query('INSERT INTO device_heartbeats (id, device_id, cpu_usage, ram_usage, disk_usage, network_in, network_out, active_processes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [hbId, device.id, cpu_usage || 0, ram_usage || 0, disk_usage || 0, network_in || 0, network_out || 0, active_processes || 0]);

    // Get pending commands
    const commands = query("SELECT id, command_type, parameters FROM agent_commands WHERE device_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 10", [device.id]);

    res.json({ success: true, data: { device_id: device.id, commands: commands.rows } });
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

    let whereClause = '';
    const params: any[] = [];

    if (search) {
      whereClause = 'WHERE (hostname LIKE ? OR agent_id LIKE ? OR ip_address LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
      whereClause += whereClause ? ' AND status = ?' : 'WHERE status = ?';
      params.push(status);
    }

    const countResult = query(`SELECT COUNT(*) as total FROM devices ${whereClause}`, params);
    const total = countResult.rows[0]?.total || 0;

    const result = query(`SELECT * FROM devices ${whereClause} ORDER BY last_heartbeat DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);

    res.json({ success: true, data: { devices: result.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } } });
  } catch (error) {
    next(error);
  }
});

// Get single device
router.get('/:id', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const deviceResult = query('SELECT * FROM devices WHERE id = ?', [id]);
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const heartbeats = query('SELECT * FROM device_heartbeats WHERE device_id = ? ORDER BY recorded_at DESC LIMIT 24', [id]);
    const events = query('SELECT * FROM security_events WHERE device_id = ? ORDER BY created_at DESC LIMIT 10', [id]);
    const software = query('SELECT * FROM device_software WHERE device_id = ? ORDER BY name ASC', [id]);
    const services = query('SELECT * FROM device_services WHERE device_id = ? ORDER BY name ASC', [id]);
    const processes = query('SELECT * FROM device_processes WHERE device_id = ? ORDER BY cpu_usage DESC LIMIT 100', [id]);
    const networkInterfaces = query('SELECT * FROM device_network_interfaces WHERE device_id = ?', [id]);
    const commands = query('SELECT * FROM agent_commands WHERE device_id = ? ORDER BY created_at DESC LIMIT 50', [id]);

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
    const { display_name, user_id, notes, is_authorized } = req.body;

    query('UPDATE devices SET display_name = COALESCE(?, display_name), user_id = COALESCE(?, user_id), notes = COALESCE(?, notes), is_authorized = COALESCE(?, is_authorized) WHERE id = ?',
      [display_name ?? null, user_id ?? null, notes ?? null, is_authorized ?? null, id]);

    query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
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
    query('DELETE FROM devices WHERE id = ?', [id]);

    query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'device_delete', 'device', id, 'Device deleted', req.ip]);

    res.json({ success: true, data: { message: 'Device deleted' } });
  } catch (error) {
    next(error);
  }
});

// Block device
router.post('/:id/block', authenticate, requirePermission('devices.block'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    query("UPDATE devices SET status = 'blocked' WHERE id = ?", [id]);

    query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'device_block', 'device', id, 'Device blocked', req.ip]);

    res.json({ success: true, data: { message: 'Device blocked' } });
  } catch (error) {
    next(error);
  }
});

// Update agent on device (sends update command)
router.post('/:id/update-agent', authenticate, requirePermission('devices.commands'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const deviceResult = query('SELECT agent_id FROM devices WHERE id = ?', [id]);
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const cmdId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    query('INSERT INTO agent_commands (id, device_id, command_type, parameters, status, issued_by) VALUES (?, ?, ?, ?, ?, ?)',
      [cmdId, id, 'update_agent', JSON.stringify(req.body || {}), 'pending', req.user?.id]);

    query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'agent_update', 'device', id, 'Agent update command sent', req.ip]);

    res.json({ success: true, data: { message: 'Agent update command sent', command_id: cmdId } });
  } catch (error) {
    next(error);
  }
});

// Unblock device
router.post('/:id/unblock', authenticate, requirePermission('devices.block'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    query("UPDATE devices SET status = 'online' WHERE id = ?", [id]);

    query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'device_unblock', 'device', id, 'Device unblocked', req.ip]);

    res.json({ success: true, data: { message: 'Device unblocked' } });
  } catch (error) {
    next(error);
  }
});

// Quarantine device
router.post('/:id/quarantine', authenticate, requirePermission('devices.quarantine'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    query("UPDATE devices SET status = 'quarantine' WHERE id = ?", [id]);

    query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'device_quarantine', 'device', id, 'Device quarantined', req.ip]);

    res.json({ success: true, data: { message: 'Device quarantined' } });
  } catch (error) {
    next(error);
  }
});

// Get device history
router.get('/:id/history', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const heartbeats = query('SELECT * FROM device_heartbeats WHERE device_id = ? ORDER BY recorded_at DESC LIMIT 100', [id]);
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

    const deviceResult = query('SELECT id FROM devices WHERE agent_id = ?', [agent_id]);
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const deviceId = deviceResult.rows[0].id;

    // Clear old data and insert new
    query('DELETE FROM device_software WHERE device_id = ?', [deviceId]);
    if (Array.isArray(software)) {
      for (const sw of software) {
        const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        query('INSERT INTO device_software (id, device_id, name, version, publisher, install_date) VALUES (?, ?, ?, ?, ?, ?)',
          [id, deviceId, sw.name || '', sw.version || '', sw.publisher || '', sw.install_date || '']);
      }
    }

    query('DELETE FROM device_services WHERE device_id = ?', [deviceId]);
    if (Array.isArray(services)) {
      for (const svc of services) {
        const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        query('INSERT INTO device_services (id, device_id, name, display_name, status, startup_type) VALUES (?, ?, ?, ?, ?, ?)',
          [id, deviceId, svc.name || '', svc.display_name || svc.name || '', svc.status || '', svc.startup_type || '']);
      }
    }

    query('DELETE FROM device_processes WHERE device_id = ?', [deviceId]);
    if (Array.isArray(processes)) {
      for (const proc of processes) {
        const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        query('INSERT INTO device_processes (id, device_id, pid, name, cpu_usage, memory_usage, user_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [id, deviceId, proc.pid || 0, proc.name || '', proc.cpu_percent || proc.cpu_usage || 0, proc.memory_bytes || proc.memory_usage || 0, proc.user || proc.user_name || '']);
      }
    }

    query('DELETE FROM device_network_interfaces WHERE device_id = ?', [deviceId]);
    if (Array.isArray(network_interfaces)) {
      for (const iface of network_interfaces) {
        const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        query('INSERT INTO device_network_interfaces (id, device_id, name, mac_address, ipv4_address, ipv6_address, is_connected, speed_mbps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, deviceId, iface.name || '', iface.mac || iface.mac_address || '', iface.ipv4 || iface.ipv4_address || '', iface.ipv6 || iface.ipv6_address || '', iface.is_connected ? 1 : 0, iface.speed || iface.speed_mbps || 0]);
      }
    }

    query("UPDATE devices SET last_inventory = datetime('now') WHERE id = ?", [deviceId]);

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

    const deviceResult = query('SELECT id FROM devices WHERE agent_id = ?', [agent_id]);
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const validStatus = ['completed', 'failed'].includes(status) ? status : 'failed';
    const resultStr = result ? (typeof result === 'string' ? result : JSON.stringify(result)) : null;
    const errorStr = error_message || null;

    query("UPDATE agent_commands SET status = ?, result = ?, error_message = ?, executed_at = datetime('now'), completed_at = datetime('now') WHERE id = ? AND device_id = ?",
      [validStatus, resultStr, errorStr, command_id, deviceResult.rows[0].id]);

    logger.info('Command result received', { command_id, status: validStatus });
    res.json({ success: true, data: { message: 'Command result recorded' } });
  } catch (error) {
    next(error);
  }
});

export default router;

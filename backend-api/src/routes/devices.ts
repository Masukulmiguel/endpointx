import { Router } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { Response, NextFunction } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
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

    const deviceResult = query("SELECT id FROM devices WHERE agent_id = ? AND is_authorized = 1", [agent_id]);

    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found or not authorized' } });
      return;
    }

    const device = deviceResult.rows[0];

    query("UPDATE devices SET status = 'online', last_heartbeat = datetime('now'), cpu_usage = ?, ram_usage = ?, disk_usage = ? WHERE id = ?",
      [cpu_usage || 0, ram_usage || 0, disk_usage || 0, device.id]);
    const hbId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    query('INSERT INTO device_heartbeats (id, device_id, cpu_usage, ram_usage, disk_usage, network_in, network_out, active_processes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [hbId, device.id, cpu_usage || 0, ram_usage || 0, disk_usage || 0, network_in || 0, network_out || 0, active_processes || 0]);

    // Get pending commands and mark as processing
    const commands = query("SELECT id, command_type, parameters FROM agent_commands WHERE device_id = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 10", [device.id]);
    for (const cmd of commands.rows) {
      query("UPDATE agent_commands SET status = 'processing' WHERE id = ?", [cmd.id]);
    }

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

    const updateUrl = 'https://raw.githubusercontent.com/Masukulmiguel/endpointx/main/endpoint-agent';
    const params = { update_url: updateUrl, ...(req.body || {}) };
    const cmdId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    query('INSERT INTO agent_commands (id, device_id, command_type, parameters, status, issued_by) VALUES (?, ?, ?, ?, ?, ?)',
      [cmdId, id, 'update_agent', JSON.stringify(params), 'pending', req.user?.id]);

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

    const deviceResult = query('SELECT id, hostname FROM devices WHERE agent_id = ?', [agent_id]);
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
      query('INSERT INTO security_events (id, device_id, event_type, severity, title, description, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [eventId, device.id, evt.event_type, evt.severity, evt.title, evt.description, 'agent_scan']);

      // Auto-create alerts for critical and high severity
      if (evt.severity === 'critical' || evt.severity === 'high') {
        const alertId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
        query('INSERT INTO alerts (id, device_id, alert_type, severity, title, description, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
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

    const deviceResult = query('SELECT id, hostname FROM devices WHERE agent_id = ?', [agent_id]);
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const device = deviceResult.rows[0];
    let created = 0;

    for (const alert of alerts) {
      // Check if similar alert already exists in last hour
      const existing = query("SELECT id FROM alerts WHERE device_id = ? AND alert_type = ? AND created_at > datetime('now', '-1 hour') LIMIT 1",
        [device.id, alert.alert_type || alert.type]);
      if (existing.rows.length > 0) continue;

      const alertId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      query('INSERT INTO alerts (id, device_id, alert_type, severity, title, description, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
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

    const filePath = join(__dirname, '..', '..', 'public', 'install.ps1');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'Install script not found' } });
      return;
    }

    let script = readFileSync(filePath, 'utf-8');
    script = script.replace('##SERVER_URL##', serverUrl);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="install-endpointx.ps1"');
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

export default router;

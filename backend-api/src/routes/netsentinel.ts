import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import logger from '../utils/logger';

const router = Router();

function newId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

const DEVICE_TYPES = [
  'DESKTOP', 'LAPTOP', 'SERVER', 'MOBILE', 'TABLET', 'PRINTER', 'CAMERA',
  'PHONE', 'ROUTER', 'SWITCH', 'ACCESS_POINT', 'FIREWALL', 'IOT', 'UNKNOWN',
] as const;

const OWNERSHIP = ['CORPORATE', 'BYOD', 'GUEST', 'UNKNOWN', 'BLOCKED', 'QUARANTINED'] as const;
const TRUST = ['TRUSTED', 'KNOWN', 'RESTRICTED', 'SUSPICIOUS', 'QUARANTINED', 'BLOCKED', 'UNKNOWN'] as const;
const QUARANTINE = ['NORMAL', 'RESTRICTED', 'QUARANTINED', 'BLOCKED'] as const;

function classifyFromOs(osType: string, osVersion: string): string {
  const os = (osType || '').toLowerCase();
  const v = (osVersion || '').toLowerCase();
  if (os.includes('android')) return 'MOBILE';
  if (os.includes('ios') || os.includes('iphone') || os.includes('ipad')) return v.includes('ipad') ? 'TABLET' : 'MOBILE';
  if (os.includes('windows')) {
    if (os.includes('server') || v.includes('server')) return 'SERVER';
    return 'DESKTOP';
  }
  if (os.includes('linux') || os.includes('ubuntu') || os.includes('debian') || os.includes('centos')) {
    if (v.includes('server') || os.includes('server')) return 'SERVER';
    return 'UNKNOWN';
  }
  if (os.includes('macos') || os.includes('darwin')) return 'LAPTOP';
  if (os.includes('printer')) return 'PRINTER';
  return 'UNKNOWN';
}

async function logDeviceEvent(deviceId: string, eventType: string, severity: string, title: string, description: string, metadata: any = {}) {
  try {
    await query(
      'INSERT INTO device_events (id, device_id, event_type, severity, title, description, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [newId(), deviceId, eventType, severity, title, description, JSON.stringify(metadata)]
    );
  } catch (e) {
    logger.warn('device_events write failed', { error: (e as Error).message });
  }
}

async function audit(action: string, req: AuthRequest, targetType: string, targetId: string, details: any = {}) {
  try {
    await query(
      'INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [newId(), req.user?.id || null, req.user?.email || null, action, targetType, targetId, details.reason || action, req.ip || null, JSON.stringify(details)]
    );
  } catch (e) {
    logger.warn('audit write failed', { action, error: (e as Error).message });
  }
}

export function evaluateNacPolicy(device: any, policies: any[]): { decision: string; policyId: string | null; reason: string } {
  const ordered = [...policies].sort((a, b) => (a.priority || 100) - (b.priority || 100));
  for (const p of ordered) {
    if (!p.is_active) continue;
    const cond = typeof p.conditions === 'string' ? JSON.parse(p.conditions || '{}') : p.conditions || {};
    let match = true;
    if (cond.device_type && cond.device_type !== device.device_type) match = false;
    if (cond.ownership && cond.ownership !== device.ownership) match = false;
    if (cond.trust_level && cond.trust_level !== device.trust_level) match = false;
    if (cond.quarantine_status && cond.quarantine_status !== device.quarantine_status) match = false;
    if (match) {
      return {
        decision: p.action || 'LIMITED_ACCESS',
        policyId: p.id,
        reason: `Matched policy "${p.name}"`,
      };
    }
  }
  if (device.device_type === 'UNKNOWN' || device.trust_level === 'UNKNOWN') {
    return { decision: 'QUARANTINE', policyId: null, reason: 'Unknown device — default quarantine' };
  }
  if (device.quarantine_status === 'QUARANTINED' || device.quarantine_status === 'BLOCKED') {
    return { decision: device.quarantine_status, policyId: null, reason: `Device status ${device.quarantine_status}` };
  }
  if (device.trust_level === 'TRUSTED' || device.trust_level === 'KNOWN') {
    return { decision: 'ALLOW', policyId: null, reason: 'Trusted or known device' };
  }
  return { decision: 'LIMITED_ACCESS', policyId: null, reason: 'Default limited access' };
}

// Inventory summary (universal device inventory)
router.get('/inventory/summary', authenticate, requirePermission('devices.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const byType = await query(
      `SELECT COALESCE(device_type, 'UNKNOWN') as type, COUNT(*) as c FROM devices GROUP BY 1 ORDER BY c DESC`
    );
    const byOwnership = await query(
      `SELECT COALESCE(ownership, 'CORPORATE') as ownership, COUNT(*) as c FROM devices GROUP BY 1`
    );
    const byTrust = await query(
      `SELECT COALESCE(trust_level, 'UNKNOWN') as trust, COUNT(*) as c FROM devices GROUP BY 1`
    );
    const totals = await query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'online') as online,
        COUNT(*) FILTER (WHERE status = 'offline') as offline,
        COUNT(*) FILTER (WHERE trust_level = 'UNKNOWN' OR device_type = 'UNKNOWN') as unknown,
        COUNT(*) FILTER (WHERE quarantine_status = 'QUARANTINED') as quarantined,
        COUNT(*) FILTER (WHERE quarantine_status = 'BLOCKED') as blocked,
        COUNT(*) FILTER (WHERE approval_status = 'pending') as pending_approval,
        COUNT(*) FILTER (WHERE device_type IN ('MOBILE','TABLET')) as mobile,
        COUNT(*) FILTER (WHERE ownership = 'BYOD') as byod,
        COUNT(*) FILTER (WHERE ownership = 'GUEST') as guest,
        COUNT(*) FILTER (WHERE mdm_enrolled = true) as managed,
        COUNT(*) FILTER (WHERE device_type = 'SERVER') as servers,
        COUNT(*) FILTER (WHERE device_type IN ('SWITCH','ROUTER','ACCESS_POINT','FIREWALL')) as network_devices,
        COUNT(*) FILTER (WHERE device_type = 'IOT' OR device_type = 'CAMERA' OR device_type = 'PRINTER') as iot
      FROM devices
    `);
    const findings = await query(`
      SELECT
        COUNT(*) FILTER (WHERE severity = 'critical') as critical,
        COUNT(*) FILTER (WHERE severity = 'high') as high,
        COUNT(*) FILTER (WHERE severity = 'medium') as medium
      FROM hermes_findings WHERE status = 'open'
    `);
    const anomalies = await query(
      `SELECT COUNT(*) as c FROM device_events WHERE event_type IN ('anomaly','anomalous_network_change') AND created_at > NOW() - INTERVAL '7 days'`
    );
    const alerts = await query(`SELECT COUNT(*) as c FROM alerts WHERE is_dismissed = false`);

    const map = (rows: any[], key: string) => {
      const o: Record<string, number> = {};
      for (const r of rows) o[r[key]] = parseInt(r.c, 10);
      return o;
    };

    res.json({
      success: true,
      data: {
        devices: {
          total: parseInt(totals.rows[0]?.total || '0', 10),
          online: parseInt(totals.rows[0]?.online || '0', 10),
          offline: parseInt(totals.rows[0]?.offline || '0', 10),
          unknown: parseInt(totals.rows[0]?.unknown || '0', 10),
          quarantined: parseInt(totals.rows[0]?.quarantined || '0', 10),
          blocked: parseInt(totals.rows[0]?.blocked || '0', 10),
          pending_approval: parseInt(totals.rows[0]?.pending_approval || '0', 10),
          by_type: map(byType.rows, 'type'),
          by_ownership: map(byOwnership.rows, 'ownership'),
          by_trust: map(byTrust.rows, 'trust'),
          mobile: parseInt(totals.rows[0]?.mobile || '0', 10),
          byod: parseInt(totals.rows[0]?.byod || '0', 10),
          guest: parseInt(totals.rows[0]?.guest || '0', 10),
          managed: parseInt(totals.rows[0]?.managed || '0', 10),
          servers: parseInt(totals.rows[0]?.servers || '0', 10),
          network_devices: parseInt(totals.rows[0]?.network_devices || '0', 10),
          iot: parseInt(totals.rows[0]?.iot || '0', 10),
        },
        security: {
          critical_findings: parseInt(findings.rows[0]?.critical || '0', 10),
          high_findings: parseInt(findings.rows[0]?.high || '0', 10),
          medium_findings: parseInt(findings.rows[0]?.medium || '0', 10),
          network_anomalies: parseInt(anomalies.rows[0]?.c || '0', 10),
          security_alerts: parseInt(alerts.rows[0]?.c || '0', 10),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// List inventory with filters
router.get('/inventory', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const deviceType = req.query.device_type as string | undefined;
    const ownership = req.query.ownership as string | undefined;
    const trust = req.query.trust_level as string | undefined;
    const search = req.query.search as string | undefined;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = (page - 1) * limit;

    const clauses: string[] = [];
    const params: any[] = [];
    if (deviceType) {
      params.push(deviceType);
      clauses.push(`device_type = $${params.length}`);
    }
    if (ownership) {
      params.push(ownership);
      clauses.push(`ownership = $${params.length}`);
    }
    if (trust) {
      params.push(trust);
      clauses.push(`trust_level = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      clauses.push(`(hostname ILIKE $${params.length} OR ip_address::text ILIKE $${params.length} OR mac_address ILIKE $${params.length})`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const count = await query(`SELECT COUNT(*) as total FROM devices ${where}`, params);
    const total = count.rows[0]?.total || 0;

    params.push(limit, offset);
    const rows = await query(
      `SELECT id, hostname, display_name, device_type, manufacturer, model, os_type, os_version,
              mac_address, ip_address, ipv6_address, vlan, ssid, switch_name, switch_port, access_point,
              location, ownership, trust_level, quarantine_status, security_score, managed, mdm_enrolled,
              encryption_status, security_patch_level, department, approval_status, status, last_heartbeat,
              user_id, is_authorized, first_seen, registered_at
       FROM devices ${where}
       ORDER BY last_heartbeat DESC NULLS LAST
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      success: true,
      data: {
        devices: rows.rows,
        pagination: { page, limit, total: parseInt(total, 10), totalPages: Math.ceil(parseInt(total, 10) / limit) },
      },
    });
  } catch (error) {
    next(error);
  }
});

// Mobile devices dashboard data
router.get('/mobile', authenticate, requirePermission('devices.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const devices = await query(
      `SELECT id, hostname, display_name, device_type, os_type, os_version, manufacturer, model,
              ownership, trust_level, quarantine_status, security_score, managed, mdm_enrolled,
              encryption_status, security_patch_level, vlan, ssid, ip_address, status, last_heartbeat,
              department, approval_status
       FROM devices
       WHERE device_type IN ('MOBILE', 'TABLET') OR os_type IN ('android', 'ios')
       ORDER BY last_heartbeat DESC NULLS LAST`
    );
    const summary = {
      android: devices.rows.filter((d: any) => (d.os_type || '').toLowerCase() === 'android').length,
      ios: devices.rows.filter((d: any) => (d.os_type || '').toLowerCase() === 'ios').length,
      tablets: devices.rows.filter((d: any) => d.device_type === 'TABLET').length,
      corporate: devices.rows.filter((d: any) => d.ownership === 'CORPORATE').length,
      byod: devices.rows.filter((d: any) => d.ownership === 'BYOD').length,
      guest: devices.rows.filter((d: any) => d.ownership === 'GUEST').length,
      managed: devices.rows.filter((d: any) => d.mdm_enrolled || d.managed).length,
      unmanaged: devices.rows.filter((d: any) => !d.mdm_enrolled && !d.managed).length,
      compliant: devices.rows.filter((d: any) => (d.security_score || 0) >= 70).length,
      non_compliant: devices.rows.filter((d: any) => (d.security_score || 0) < 70).length,
    };
    res.json({ success: true, data: { devices: devices.rows, summary } });
  } catch (error) {
    next(error);
  }
});

// Unknown / pending devices
router.get('/unknown', authenticate, requirePermission('devices.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const unknown = await query(
      `SELECT id, hostname, device_type, mac_address, ip_address, status, trust_level, approval_status,
              manufacturer, location, vlan, first_seen, last_heartbeat, notes
       FROM devices
       WHERE trust_level = 'UNKNOWN' OR device_type = 'UNKNOWN' OR approval_status = 'pending'
          OR is_authorized = false
       ORDER BY last_heartbeat DESC NULLS LAST
       LIMIT 100`
    );
    res.json({ success: true, data: { devices: unknown.rows } });
  } catch (error) {
    next(error);
  }
});

// Asset approval workflow
router.post('/devices/:id/approve', authenticate, requirePermission('devices.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const r = await query(
      `UPDATE devices
       SET approval_status = 'approved', is_authorized = true,
           trust_level = CASE WHEN trust_level = 'UNKNOWN' THEN 'KNOWN' ELSE trust_level END,
           device_type = CASE WHEN device_type = 'UNKNOWN' THEN $1 ELSE device_type END,
           updated_at = NOW()
       WHERE id = $2 RETURNING id`,
      [req.body?.device_type || 'UNKNOWN', id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }
    await logDeviceEvent(id, 'device_approved', 'info', 'Device Approved', 'Administrator approved unknown asset', { actor: req.user?.email });
    await audit('device_approved', req, 'device', id, { reason: req.body?.reason });
    res.json({ success: true, data: { message: 'Device approved' } });
  } catch (error) {
    next(error);
  }
});

router.post('/devices/:id/reject', authenticate, requirePermission('devices.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const r = await query(
      `UPDATE devices SET approval_status = 'rejected', trust_level = 'BLOCKED', is_authorized = false, quarantine_status = 'BLOCKED', updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }
    await logDeviceEvent(id, 'device_rejected', 'high', 'Device Rejected', 'Administrator rejected unknown asset', { actor: req.user?.email });
    await audit('device_rejected', req, 'device', id, { reason: req.body?.reason });
    res.json({ success: true, data: { message: 'Device rejected and blocked' } });
  } catch (error) {
    next(error);
  }
});

// Quarantine / release
router.post('/devices/:id/quarantine', authenticate, requirePermission('devices.quarantine'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const r = await query(
      `UPDATE devices SET quarantine_status = 'QUARANTINED', trust_level = 'QUARANTINED', status = 'quarantine', updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }
    await logDeviceEvent(id, 'device_quarantined', 'high', 'Device Quarantined', req.body?.reason || 'Placed in quarantine', { actor: req.user?.email });
    await audit('device_quarantined', req, 'device', id, { reason: req.body?.reason });
    res.json({ success: true, data: { message: 'Device quarantined' } });
  } catch (error) {
    next(error);
  }
});

router.post('/devices/:id/release', authenticate, requirePermission('devices.quarantine'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const r = await query(
      `UPDATE devices SET quarantine_status = 'NORMAL', trust_level = CASE WHEN trust_level = 'QUARANTINED' THEN 'KNOWN' ELSE trust_level END, status = 'online', updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }
    await logDeviceEvent(id, 'quarantine_released', 'info', 'Quarantine Released', req.body?.reason || 'Quarantine lifted', { actor: req.user?.email });
    await audit('quarantine_released', req, 'device', id, { reason: req.body?.reason });
    res.json({ success: true, data: { message: 'Quarantine released' } });
  } catch (error) {
    next(error);
  }
});

// Update device classification / assignment
router.put('/devices/:id', authenticate, requirePermission('devices.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const allowed = [
      'device_type', 'manufacturer', 'model', 'vlan', 'ssid', 'switch_name', 'switch_port',
      'access_point', 'location', 'ownership', 'trust_level', 'department', 'display_name', 'notes',
    ];
    const sets: string[] = [];
    const params: any[] = [];
    for (const key of allowed) {
      if (b[key] !== undefined) {
        if (key === 'device_type' && !DEVICE_TYPES.includes(b[key])) continue;
        if (key === 'ownership' && !OWNERSHIP.includes(b[key])) continue;
        if (key === 'trust_level' && !TRUST.includes(b[key])) continue;
        params.push(b[key]);
        sets.push(`${key} = $${params.length}`);
      }
    }
    if (sets.length === 0) {
      res.status(400).json({ success: false, error: { message: 'No valid fields' } });
      return;
    }
    params.push(id);
    await query(`UPDATE devices SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);
    await audit('device_updated', req, 'device', id, b);
    res.json({ success: true, data: { message: 'Device updated' } });
  } catch (error) {
    next(error);
  }
});

// Network discovery (from authorized inventory + optional connectors)
router.post('/discovery/run', authenticate, requirePermission('network.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const runId = newId();
    const source = (req.body?.source as string) || 'agent_inventory';
    await query(
      `INSERT INTO network_discovery_runs (id, source, status, started_by, started_at) VALUES ($1, $2, 'running', $3, NOW())`,
      [runId, source, req.user?.id || null]
    );

    let nodes = 0;
    let newUnknowns = 0;

    // Sync authorized devices into network_nodes
    const devices = await query(`SELECT id, hostname, ip_address, mac_address, device_type, vlan, location, status FROM devices`);
    for (const d of devices.rows) {
      const nodeType = d.device_type && d.device_type !== 'UNKNOWN' ? d.device_type : 'ENDPOINT';
      const existing = await query(`SELECT id FROM network_nodes WHERE device_id = $1`, [d.id]);
      if (existing.rows.length === 0) {
        await query(
          `INSERT INTO network_nodes (id, node_type, name, hostname, ip_address, mac_address, parent_id, vlan, site, source, device_id, first_seen, last_seen, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, NOW(), NOW(), NOW())`,
          [newId(), nodeType, d.hostname, d.hostname, d.ip_address, d.mac_address, d.vlan, d.location, source, d.id]
        );
        nodes++;
      } else {
        await query(
          `UPDATE network_nodes SET last_seen = NOW(), updated_at = NOW(), ip_address = $1, vlan = $2 WHERE device_id = $3`,
          [d.ip_address, d.vlan, d.id]
        );
        nodes++;
      }
      if (d.device_type === 'UNKNOWN' && d.status) newUnknowns++;
    }

    // Create VLAN grouping nodes if missing
    const vlans = await query(`SELECT DISTINCT vlan FROM devices WHERE vlan IS NOT NULL AND vlan <> ''`);
    for (const v of vlans.rows) {
      const exists = await query(`SELECT id FROM network_nodes WHERE node_type = 'VLAN' AND vlan = $1`, [v.vlan]);
      if (exists.rows.length === 0) {
        await query(
          `INSERT INTO network_nodes (id, node_type, name, vlan, source, metadata, first_seen, last_seen, updated_at)
           VALUES ($1, 'VLAN', $2, $2, $3, '{}', NOW(), NOW(), NOW())`,
          [newId(), `VLAN ${v.vlan}`, source]
        );
        nodes++;
      }
    }

    await query(
      `UPDATE network_discovery_runs SET status = 'completed', completed_at = NOW(), stats = $1 WHERE id = $2`,
      [JSON.stringify({ nodes_synced: nodes, unknown: newUnknowns }), runId]
    );
    await audit('network_discovery_run', req, 'discovery', runId, { source, nodes });

    res.json({ success: true, data: { id: runId, nodes_synced: nodes, status: 'completed' } });
  } catch (error) {
    next(error);
  }
});

router.get('/discovery', authenticate, requirePermission('network.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const runs = await query(`SELECT * FROM network_discovery_runs ORDER BY started_at DESC LIMIT 20`);
    res.json({ success: true, data: { runs: runs.rows } });
  } catch (error) {
    next(error);
  }
});

// Topology / network map
router.get('/topology', authenticate, requirePermission('network.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const nodes = await query(
      `SELECT n.*, d.status as device_status, d.trust_level, d.device_type as d_type, d.quarantine_status
       FROM network_nodes n LEFT JOIN devices d ON n.device_id = d.id
       ORDER BY n.node_type, n.name`
    );
    res.json({ success: true, data: { nodes: nodes.rows } });
  } catch (error) {
    next(error);
  }
});

// NAC policies
router.get('/nac/policies', authenticate, requirePermission('policies.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(`SELECT * FROM nac_policies ORDER BY priority ASC, name ASC`);
    res.json({ success: true, data: { policies: r.rows } });
  } catch (error) {
    next(error);
  }
});

router.post('/nac/policies', authenticate, requirePermission('policies.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, description, conditions, action = 'LIMITED_ACCESS', vlan, priority = 100 } = req.body || {};
    if (!name) {
      res.status(400).json({ success: false, error: { message: 'name is required' } });
      return;
    }
    const allowedActions = ['ALLOW', 'LIMITED_ACCESS', 'GUEST', 'QUARANTINE', 'BLOCK'];
    if (!allowedActions.includes(action)) {
      res.status(400).json({ success: false, error: { message: 'Invalid action' } });
      return;
    }
    const id = newId();
    await query(
      `INSERT INTO nac_policies (id, name, priority, description, conditions, action, vlan, is_active, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, NOW(), NOW())`,
      [id, name, priority, description || '', JSON.stringify(conditions || {}), action, vlan || null, req.user?.id || null]
    );
    await audit('nac_policy_created', req, 'nac_policy', id, { name, action });
    res.status(201).json({ success: true, data: { id, name, action } });
  } catch (error) {
    next(error);
  }
});

router.put('/nac/policies/:id', authenticate, requirePermission('policies.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { name, description, conditions, action, vlan, priority, is_active } = req.body || {};
    const r = await query(
      `UPDATE nac_policies SET
         name = COALESCE($1, name),
         description = COALESCE($2, description),
         conditions = COALESCE($3, conditions),
         action = COALESCE($4, action),
         vlan = COALESCE($5, vlan),
         priority = COALESCE($6, priority),
         is_active = COALESCE($7, is_active),
         updated_at = NOW()
       WHERE id = $8 RETURNING id`,
      [name ?? null, description ?? null, conditions ? JSON.stringify(conditions) : null, action ?? null, vlan ?? null, priority ?? null, is_active ?? null, id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Policy not found' } });
      return;
    }
    await audit('nac_policy_updated', req, 'nac_policy', id, req.body);
    res.json({ success: true, data: { message: 'Policy updated' } });
  } catch (error) {
    next(error);
  }
});

router.delete('/nac/policies/:id', authenticate, requirePermission('policies.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await query(`DELETE FROM nac_policies WHERE id = $1`, [req.params.id]);
    await audit('nac_policy_deleted', req, 'nac_policy', req.params.id, {});
    res.json({ success: true, data: { message: 'Policy deleted' } });
  } catch (error) {
    next(error);
  }
});

// Evaluate NAC decision for a device
router.post('/nac/evaluate', authenticate, requirePermission('policies.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const deviceId = req.body?.device_id;
    if (!deviceId) {
      res.status(400).json({ success: false, error: { message: 'device_id required' } });
      return;
    }
    const dev = await query(`SELECT * FROM devices WHERE id = $1`, [deviceId]);
    if (dev.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }
    const policies = await query(`SELECT * FROM nac_policies WHERE is_active = true`);
    const result = evaluateNacPolicy(dev.rows[0], policies.rows);
    await query(
      `INSERT INTO nac_decisions (id, device_id, policy_id, decision, reason, evidence, auto_applied, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, NOW())`,
      [
        newId(), deviceId, result.policyId, result.decision, result.reason,
        JSON.stringify([
          { check: 'device_type', value: dev.rows[0].device_type },
          { check: 'trust_level', value: dev.rows[0].trust_level },
          { check: 'ownership', value: dev.rows[0].ownership },
          { check: 'quarantine_status', value: dev.rows[0].quarantine_status },
        ]),
        req.user?.id || null,
      ]
    );
    await audit('nac_evaluated', req, 'device', deviceId, result);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

router.get('/nac/decisions', authenticate, requirePermission('policies.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(
      `SELECT nd.*, d.hostname, d.ip_address FROM nac_decisions nd
       LEFT JOIN devices d ON nd.device_id = d.id
       ORDER BY nd.created_at DESC LIMIT 100`
    );
    res.json({ success: true, data: { decisions: r.rows } });
  } catch (error) {
    next(error);
  }
});

// Device trust / posture detail
router.get('/devices/:id/trust', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const dev = await query(
      `SELECT id, hostname, device_type, ownership, trust_level, quarantine_status, security_score, security_posture,
              mdm_enrolled, managed, encryption_status, security_patch_level, os_type, os_version, vlan, status, last_heartbeat, approval_status
       FROM devices WHERE id = $1`,
      [req.params.id]
    );
    if (dev.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }
    const d = dev.rows[0];
    const factors = [
      { factor: 'Known Device', pass: d.trust_level !== 'UNKNOWN' },
      { factor: 'Authorized', pass: d.approval_status === 'approved' },
      { factor: 'MDM Enrolled', pass: !!d.mdm_enrolled, optional: true },
      { factor: 'Encryption', pass: d.encryption_status === 'enabled', unknown: !d.encryption_status },
      { factor: 'Security Score', pass: (d.security_score || 0) >= 70, detail: `${d.security_score || 0}/100` },
      { factor: 'Not Quarantined', pass: d.quarantine_status === 'NORMAL' },
    ];
    const knownFactors = factors.filter((f) => !f.unknown);
    const passed = knownFactors.filter((f) => f.pass).length;
    const confidence = knownFactors.length ? Math.round((passed / knownFactors.length) * 100) : 0;
    res.json({ success: true, data: { device: d, factors, confidence } });
  } catch (error) {
    next(error);
  }
});

// Incidents
router.get('/incidents', authenticate, requirePermission('alerts.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(`SELECT * FROM security_incidents ORDER BY created_at DESC LIMIT 100`);
    res.json({ success: true, data: { incidents: r.rows } });
  } catch (error) {
    next(error);
  }
});

router.post('/incidents', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { severity = 'medium', title, description, affected_devices = [], detection_source = 'manual' } = req.body || {};
    if (!title) {
      res.status(400).json({ success: false, error: { message: 'title required' } });
      return;
    }
    const incidentId = `INC-${Date.now().toString(36).toUpperCase()}`;
    const id = newId();
    const timeline = [
      { at: new Date().toISOString(), event: 'Detection', by: req.user?.email || 'system' },
    ];
    await query(
      `INSERT INTO security_incidents (id, incident_id, severity, status, title, description, affected_devices, detection_source, evidence, timeline, actions_taken, created_at, updated_at)
       VALUES ($1, $2, $3, 'detection', $4, $5, $6, $7, '[]', $8, '[]', NOW(), NOW())`,
      [id, incidentId, severity, title, description || '', affected_devices, detection_source, JSON.stringify(timeline)]
    );
    await audit('incident_created', req, 'incident', incidentId, { title, severity });
    res.status(201).json({ success: true, data: { id, incident_id: incidentId } });
  } catch (error) {
    next(error);
  }
});

router.post('/incidents/:id/status', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { status, resolution, action } = req.body || {};
    const allowed = ['detection', 'investigation', 'containment', 'remediation', 'recovery', 'closed'];
    if (!allowed.includes(status)) {
      res.status(400).json({ success: false, error: { message: 'Invalid status' } });
      return;
    }
    const r = await query(`SELECT * FROM security_incidents WHERE id = $1 OR incident_id = $1`, [req.params.id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Incident not found' } });
      return;
    }
    const incident = r.rows[0];
    const timeline = typeof incident.timeline === 'string' ? JSON.parse(incident.timeline) : incident.timeline || [];
    timeline.push({ at: new Date().toISOString(), event: `Status → ${status}`, by: req.user?.email || 'system' });
    const actions = typeof incident.actions_taken === 'string' ? JSON.parse(incident.actions_taken) : incident.actions_taken || [];
    if (action) actions.push({ at: new Date().toISOString(), action, by: req.user?.email });

    await query(
      `UPDATE security_incidents SET status = $1, resolution = COALESCE($2, resolution), timeline = $3, actions_taken = $4, updated_at = NOW() WHERE id = $5`,
      [status, resolution || null, JSON.stringify(timeline), JSON.stringify(actions), incident.id]
    );
    await audit('incident_status_changed', req, 'incident', incident.incident_id, { status });
    res.json({ success: true, data: { message: 'Incident updated', status } });
  } catch (error) {
    next(error);
  }
});

// Device events
router.get('/devices/:id/events', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(
      `SELECT * FROM device_events WHERE device_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.id]
    );
    res.json({ success: true, data: { events: r.rows } });
  } catch (error) {
    next(error);
  }
});

// Connectors (infrastructure plugins)
router.get('/connectors', authenticate, requirePermission('settings.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(`SELECT id, name, vendor, connector_type, capabilities, is_enabled, status, last_sync FROM connectors ORDER BY vendor, name`);
    if (r.rows.length === 0) {
      const defaults = [
        ['MikroTik RouterOS', 'mikrotik', 'router', { snmp: true, api: true }],
        ['Cisco IOS', 'cisco', 'switch', { snmp: true, radius: true }],
        ['Ubiquiti UniFi', 'ubiquiti', 'wireless', { api: true }],
        ['Fortinet FortiGate', 'fortinet', 'firewall', { api: true }],
        ['pfSense', 'pfsense', 'firewall', { api: true }],
        ['OPNsense', 'opnsense', 'firewall', { api: true }],
        ['Windows Server / AD', 'microsoft', 'directory', { ldap: true }],
        ['Microsoft Entra ID', 'entra', 'identity', { oidc: true, oauth2: true }],
        ['FreeRADIUS / NPS', 'radius', 'radius', { radius: true }],
        ['SNMP Poller', 'generic', 'snmp', { snmp: true }],
        ['DHCP Listener', 'generic', 'dhcp', { dhcp: true }],
        ['DNS Resolver', 'generic', 'dns', { dns: true }],
        ['Syslog Receiver', 'generic', 'syslog', { syslog: true }],
        ['Android Enterprise MDM', 'google', 'mdm', { android_enterprise: true }],
        ['Apple Business Manager / MDM', 'apple', 'mdm', { apple_mdm: true }],
        ['Microsoft Intune', 'microsoft', 'mdm', { intune: true }],
        ['Jamf Pro', 'jamf', 'mdm', { jamf: true }],
      ];
      for (const [name, vendor, type, caps] of defaults as any[]) {
        await query(
          `INSERT INTO connectors (id, name, vendor, connector_type, config, capabilities, is_enabled, status, created_at)
           VALUES ($1, $2, $3, $4, '{}', $5, false, 'not_configured', NOW())`,
          [newId(), name, vendor, type, JSON.stringify(caps)]
        );
      }
      const again = await query(`SELECT id, name, vendor, connector_type, capabilities, is_enabled, status, last_sync FROM connectors ORDER BY vendor, name`);
      res.json({ success: true, data: { connectors: again.rows } });
      return;
    }
    res.json({ success: true, data: { connectors: r.rows } });
  } catch (error) {
    next(error);
  }
});

// Privacy reminder endpoint (policy exposure for UI)
router.get('/privacy', authenticate, async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: {
        never_collected: [
          'passwords', 'private messages', 'keystrokes', 'personal files',
          'photos', 'browser passwords', 'private communication content',
        ],
        collected: [
          'identity', 'network metadata', 'device management', 'compliance',
          'security events', 'configuration necessary for protection',
        ],
        retention_setting_key: 'data_retention_days',
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
export { classifyFromOs };

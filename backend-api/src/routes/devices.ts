import { Router } from 'express';
import { query, getClient } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { Response, NextFunction } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import logger from '../utils/logger';
import jwt from 'jsonwebtoken';
import { JWT, requireAgentSecret } from '../config/constants';
import { canAccessDevice, canViewUnownedDevices } from '../utils/tenant';
import { remoteSecretFor } from '../remote';
import { onForensicCommandResult } from '../hermes/forensics';
import { createAlert } from '../services/alertService';
import { broadcastEvent, emitToDevice } from '../websocket';
import { fetchHeartbeatSeries, resolveInterval, resolveRange } from '../services/metrics';

const router = Router();

// OS filter families sent by the dashboard select, mapped to LIKE patterns.
// os_type stores 'Windows'/'Linux'/'Darwin' (Python platform.system()) and
// 'android'/'ios' (mobile enrollment page), so matching is case-insensitive.
const OS_FAMILY_PATTERNS: Record<string, string[]> = {
  windows: ['%windows%'],
  macos: ['%mac%', '%darwin%', '%os x%', '%osx%'],
  linux: ['%linux%'],
  android: ['%android%'],
  ios: ['%ios%', '%ipad%', '%iphone%', '%ipod%'],
};

// Resolve the os_family/os_type query param into case-insensitive LIKE patterns, or null when not requested
function osFilterPatterns(rawValue: unknown): string[] | null {
  const value = String(rawValue || '').trim().toLowerCase();
  if (!value) return null;
  return OS_FAMILY_PATTERNS[value] || [`%${value}%`];
}

// Enrollment token (JWT, 30d) embedded in install script / mobile link - ties devices to the installing account
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

// Enrolment proof from any channel an install flow can carry it: install
// links (?t=), the mobile page (?t= / stored token) or a registration body.
function enrollOwnerFromRequest(req: AuthRequest): string | null {
  return (
    verifyEnrollToken(req.query?.t) ||
    verifyEnrollToken(req.headers['x-enroll-token']) ||
    verifyEnrollToken(req.body?.enroll_token) ||
    verifyEnrollToken(req.body?.t)
  );
}

// Gate for any route that renders the shared AGENT_SECRET. A valid enrolment
// JWT is only minted by a devices.manage holder, so anonymous callers and
// free self-registered accounts never receive the fleet credential.
function requireEnrollToken(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!enrollOwnerFromRequest(req)) {
    res.status(403).json({ success: false, error: { message: 'Valid enrolment token required' } });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Registration dedupe by source IP.
// The same physical device often comes back with a brand new agent_id (APK
// reinstalled, app data cleared, or the enrolment page opened twice), which used
// to create a second row for one machine. The IP alone is not enough - CGNAT and
// office routers put many devices behind the same address - so a match also
// needs the same OS plus hostname/model, and the candidate record has to be
// either silent (no heartbeat for 10 minutes: it was replaced) or freshly
// created (a repeated registration of that very device).
const DUP_SILENT_MS = 10 * 60 * 1000;
const DUP_RETRY_MS = 15 * 60 * 1000;
const GENERIC_MODELS = new Set(['', 'android', 'ios', 'iphone', 'ipad', 'unknown', 'phone', 'mobile', 'tablet']);

function requestIp(req: AuthRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim();
  return first || req.ip || '';
}

interface RegistrationFingerprint {
  osType: string;
  hostname?: string;
  model?: string;
}

function fingerprintMatches(row: Record<string, unknown>, fp: RegistrationFingerprint): boolean {
  const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
  if (norm(row.os_type) !== norm(fp.osType)) return false;
  const rowModel = norm(row.model);
  const wantModel = norm(fp.model);
  if (rowModel && wantModel && !GENERIC_MODELS.has(wantModel)) return rowModel === wantModel;
  const rowHost = norm(row.hostname);
  const wantHost = norm(fp.hostname);
  if (rowHost && wantHost) return rowHost === wantHost;
  return false;
}

/**
 * Finds the device this registration most likely belongs to, keyed by the source
 * IP of the request (plus the IP the agent itself reported). Returns null when
 * there is no credible match - i.e. a different device sharing the network.
 */
async function findDeviceByIp(
  req: AuthRequest,
  fp: RegistrationFingerprint,
  reportedIp?: string
): Promise<{ id: string; agent_id: string } | null> {
  const sourceIp = requestIp(req);
  const altIp = (reportedIp || '').trim();
  if (!sourceIp && !altIp) return null;
  let candidates;
  try {
    candidates = await query(
      `SELECT id, agent_id, os_type, hostname, model, last_heartbeat, first_seen, created_at
         FROM devices
        WHERE ip_address IS NOT NULL
          AND ($1 = '' OR ip_address::text = $1)
          AND ($2 = '' OR ip_address::text = $2)
          AND ($1 <> '' OR $2 <> '')
        ORDER BY COALESCE(last_heartbeat, first_seen, created_at) DESC
        LIMIT 25`,
      [sourceIp, altIp]
    );
  } catch (error) {
    logger.warn('IP dedupe lookup failed', { error: (error as Error).message });
    return null;
  }
  const now = Date.now();
  for (const row of candidates.rows) {
    if (!fingerprintMatches(row, fp)) continue;
    const lastSeen = row.last_heartbeat
      ? new Date(row.last_heartbeat as string | number | Date).getTime()
      : null;
    const created =
      new Date((row.first_seen ?? row.created_at) as string | number | Date).getTime() || now;
    const silent = lastSeen === null ? now - created > DUP_SILENT_MS : now - lastSeen > DUP_SILENT_MS;
    const justCreated = now - created < DUP_RETRY_MS;
    if (silent || justCreated) return { id: String(row.id), agent_id: String(row.agent_id || '') };
  }
  return null;
}

// Accounts can only touch devices they own; admin (devices.view_all) may also touch
// devices that have no account yet - others get 404 (no existence leak)
async function denyUnlessOwns(req: AuthRequest, res: Response, deviceId: string): Promise<boolean> {
  if (await canAccessDevice(req.user, deviceId)) return true;
  res.status(404).json({ success: false, error: { message: 'Device not found' } });
  return false;
}

// Mark devices as offline if no heartbeat within threshold
// Uses configurable threshold (default 5 minutes) instead of hardcoded 2 minutes
// Mobile (PWA) presence uses a longer threshold: browsers freeze page timers when the
// screen locks / the app is backgrounded, so a phone legitimately misses heartbeats.
export async function updateOfflineDevices() {
  try {
    const offlineThresholdSeconds = parseInt(process.env.OFFLINE_THRESHOLD || '300', 10);
    const mobileThresholdSeconds = parseInt(process.env.MOBILE_OFFLINE_THRESHOLD || '1800', 10);
    const agentMinutes = Math.max(1, Math.ceil(offlineThresholdSeconds / 60));
    const mobileMinutes = Math.max(agentMinutes, Math.ceil(mobileThresholdSeconds / 60));
    const wentOffline = await query(
      `UPDATE devices SET status = 'offline'
        WHERE status = 'online'
          AND last_heartbeat < NOW() - ((CASE WHEN agent_id LIKE 'mobile-%' THEN $1::int ELSE $2::int END) * INTERVAL '1 minute')
        RETURNING id, hostname, status, last_heartbeat`,
      [mobileMinutes, agentMinutes]
    );
    for (const device of wentOffline.rows) {
      emitToDevice(device.id, 'device:status', { device_id: device.id, status: device.status, hostname: device.hostname });
      broadcastEvent('device:status', { device_id: device.id, status: device.status, hostname: device.hostname });
    }
  } catch (e) {
    // ignore
  }
}

/** Push a device state change to connected dashboards over Socket.IO. */
async function emitDeviceStatus(deviceId: string, status: string, hostname?: string): Promise<void> {
  const name =
    hostname ||
    (await query('SELECT hostname FROM devices WHERE id = $1', [deviceId])).rows[0]?.hostname ||
    deviceId;
  const payload = { device_id: deviceId, status, hostname: name };
  emitToDevice(deviceId, 'device:status', payload);
  broadcastEvent('device:status', payload);
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

    // Reinstall of the same machine = new agent_id but the same OS/hostname on
    // the same IP: adopt the existing row instead of creating a duplicate.
    const duplicate = await findDeviceByIp(req, { osType: os_type || '', hostname: hostname || '' }, ip_address);
    if (duplicate) {
      await query(
        `UPDATE devices SET
           agent_id = $2,
           hostname = COALESCE(NULLIF($3, ''), hostname),
           os_type = COALESCE(NULLIF($4, ''), os_type),
           os_version = COALESCE(NULLIF($5, ''), os_version),
           os_build = COALESCE(NULLIF($6, ''), os_build),
           mac_address = COALESCE(NULLIF($7, ''), mac_address),
           ip_address = COALESCE(NULLIF($8::text, '')::inet, ip_address),
           status = 'online',
           last_heartbeat = NOW(),
           is_authorized = true,
           approval_status = 'approved',
           created_by = COALESCE(created_by, $9),
           updated_at = NOW()
         WHERE id = $1`,
        [
          duplicate.id,
          agent_id,
          hostname || '',
          os_type || '',
          os_version || '',
          os_build || '',
          mac_address || '',
          requestIp(req),
          ownerUserId || null,
        ]
      );
      logger.info('Device re-registered and matched by IP fingerprint', {
        deviceId: duplicate.id,
        agent_id,
        ip: requestIp(req),
      });
      res.json({ success: true, data: { id: duplicate.id, agent_id, status: 'online', is_new: false, deduplicated: true } });
      return;
    }

    const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const inserted = await query(
      `INSERT INTO devices (id, agent_id, hostname, os_type, os_version, os_build, mac_address, ip_address, status, last_heartbeat, is_authorized, device_type, ownership, trust_level, approval_status, first_seen, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, 'CORPORATE', 'KNOWN', 'approved', NOW(), $12)
       RETURNING id`,
      [id, agent_id, hostname || '', os_type || 'unknown', os_version || '', os_build || '', mac_address || '', ip_address || '', 'online', new Date(), inferredType, ownerUserId || null]
    );

    logger.info('New device registered', { deviceId: id, agent_id });
    await emitDeviceStatus(inserted.rows[0].id, 'online', hostname || agent_id);
    res.status(201).json({ success: true, data: { id: inserted.rows[0].id, agent_id, status: 'online', is_new: true } });
  } catch (error) {
    next(error);
  }
});

// Contained devices: only receive containment-related commands (isolate/unisolate/quarantine).
// The claim is a single UPDATE ... RETURNING, so the heartbeat and the fast
// command-poll endpoint can never hand the same command to the agent twice.
function claimPendingCommandsSql(limit: number, contained: boolean): string {
  const filter = contained ? `AND command_type IN ('isolate', 'unisolate', 'quarantine')` : '';
  return `
    WITH picked AS (
      UPDATE agent_commands SET status = 'processing'
      WHERE id IN (
        SELECT id FROM agent_commands
        WHERE device_id = $1 AND status = 'pending' ${filter}
        ORDER BY created_at ASC
        LIMIT ${Math.max(1, Math.min(20, limit))}
      )
      RETURNING id, command_type, parameters, created_at
    )
    SELECT id, command_type, parameters FROM picked ORDER BY created_at ASC`;
}

const asNumber = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const asText = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/**
 * Persist the optional deeper-telemetry arrays an agent can attach to a
 * heartbeat. Older agents simply omit them and nothing here runs.
 * Never throws: a malformed row must not cost the device its heartbeat.
 */
async function ingestHeartbeatTelemetry(deviceId: string, body: Record<string, unknown>): Promise<void> {
  try {
    const partitions = Array.isArray(body.partitions) ? (body.partitions as Array<Record<string, unknown>>) : [];
    for (const p of partitions.slice(0, 64)) {
      const mount = asText(p?.mount_point, 255);
      if (!mount) continue;
      await query(
        `INSERT INTO device_partitions
           (device_id, mount_point, device_name, fstype, total_bytes, used_bytes, free_bytes, usage_percent, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (device_id, mount_point) DO UPDATE SET
           device_name = EXCLUDED.device_name,
           fstype = EXCLUDED.fstype,
           total_bytes = EXCLUDED.total_bytes,
           used_bytes = EXCLUDED.used_bytes,
           free_bytes = EXCLUDED.free_bytes,
           usage_percent = EXCLUDED.usage_percent,
           recorded_at = NOW()`,
        [
          deviceId,
          mount,
          asText(p.device_name, 255),
          asText(p.fstype, 50),
          asNumber(p.total_bytes),
          asNumber(p.used_bytes),
          asNumber(p.free_bytes),
          asNumber(p.usage_percent),
        ]
      );
    }

    const interfaces = Array.isArray(body.interface_metrics)
      ? (body.interface_metrics as Array<Record<string, unknown>>)
      : [];
    for (const iface of interfaces.slice(0, 64)) {
      const name = asText(iface?.name, 100);
      if (!name) continue;
      await query(
        `INSERT INTO device_interface_metrics
           (device_id, interface_name, bytes_in, bytes_out, rate_in, rate_out, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          deviceId,
          name,
          asNumber(iface.bytes_in),
          asNumber(iface.bytes_out),
          asNumber(iface.rate_in),
          asNumber(iface.rate_out),
        ]
      );
    }
  } catch (error) {
    logger.warn('Heartbeat telemetry ingest failed', {
      device_id: deviceId,
      error: (error as Error).message,
    });
  }
}

// Agent heartbeat
router.post('/heartbeat', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { agent_id, cpu_usage, ram_usage, disk_usage, network_in, network_out, active_processes, agent_hash, current_version,
            cpu_model, cpu_cores, ram_total, ram_used, disk_total, disk_used } = req.body;

    if (!agent_id) {
      res.status(400).json({ success: false, error: { message: 'agent_id is required' } });
      return;
    }

    // Agents carry the fleet secret (same check as /register): without it
    // anyone could push fake metrics or flip device status to online.
    const heartbeatSecret = req.headers['x-agent-secret'];
    if (heartbeatSecret !== process.env.AGENT_SECRET) {
      res.status(401).json({ success: false, error: { message: 'Invalid agent secret' } });
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

    // Hardware capacity (CPU model/cores, RAM and disk size). Reported with every
    // heartbeat so the dashboard shows real numbers instead of N/A; COALESCE keeps the
    // previous value when an older agent does not send the fields.
    const hwModel = typeof cpu_model === 'string' && cpu_model.trim() ? cpu_model.trim().slice(0, 255) : null;
    const hwInt = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
    };
    const hwCores = hwInt(cpu_cores);
    const hwRam = hwInt(ram_total);
    const hwRamUsed = hwInt(ram_used);
    const hwDisk = hwInt(disk_total);
    const hwDiskUsed = hwInt(disk_used);
    if (hwModel || hwCores || hwRam || hwRamUsed || hwDisk || hwDiskUsed) {
      await query(
        `UPDATE devices SET
           cpu_model = COALESCE($1, cpu_model),
           cpu_cores = COALESCE($2, cpu_cores),
           ram_total = COALESCE($3, ram_total),
           disk_total = COALESCE($4, disk_total),
           ram_used = COALESCE($5, ram_used),
           disk_used = COALESCE($6, disk_used)
         WHERE id = $7`,
        [hwModel, hwCores, hwRam, hwDisk, hwRamUsed, hwDiskUsed, device.id]
      );
    }

    // Store agent hash if provided; detect tamper if it changes
    if (agent_hash) {
      if (device.last_agent_hash && device.last_agent_hash !== agent_hash) {
        // Hash mismatch — raise a critical alert through the shared helper so
        // it is deduped, emailed and pushed over the socket like every other.
        const hostname = (await query('SELECT hostname FROM devices WHERE id = $1', [device.id])).rows[0]?.hostname || device.id;
        await createAlert({
          device_id: device.id,
          alert_type: 'tamper_detected',
          severity: 'critical',
          title: 'Agent Integrity Check Failed',
          description: `Agent file hash changed on ${hostname}. Expected: ${device.last_agent_hash}, Got: ${agent_hash}`,
          metadata: { device_hostname: hostname, expected_hash: device.last_agent_hash, current_hash: agent_hash },
          dedup_key: `tamper:${device.id}`,
          source: 'agent',
          dedup_window_minutes: 60 * 24,
        });
        logger.warn('Agent tamper detected via heartbeat', { agent_id, expected: device.last_agent_hash, actual: agent_hash });
      }
      await query('UPDATE devices SET last_agent_hash = $1 WHERE id = $2', [agent_hash, device.id]);
    }

    const hbId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    await query('INSERT INTO device_heartbeats (id, device_id, cpu_usage, ram_usage, disk_usage, network_in, network_out, active_processes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [hbId, device.id, cpu_usage || 0, ram_usage || 0, disk_usage || 0, network_in || 0, network_out || 0, active_processes || 0]);

    // v1.2.0 M3: per-partition disk and per-interface traffic ride along with
    // the heartbeat, so deeper telemetry costs the agent no extra round trip.
    await ingestHeartbeatTelemetry(device.id, req.body);

    const commands = await query(claimPendingCommandsSql(isContained ? 5 : 10, isContained), [device.id]);

    res.json({
      success: true,
      data: {
        device_id: device.id,
        commands: commands.rows,
        agent_version: '1.7.0',
        status: device.status,
        contained: isContained,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Agent command poll - low-latency command delivery.
//
// The heartbeat runs once a minute, so before this endpoint a reboot issued
// from the dashboard could sit for up to 60 seconds and look like it did
// nothing. The agent polls here every ~3 seconds instead.
router.post('/command-poll', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { agent_id } = req.body || {};
    if (!agent_id) {
      res.status(400).json({ success: false, error: { message: 'agent_id is required' } });
      return;
    }
    if (req.headers['x-agent-secret'] !== process.env.AGENT_SECRET) {
      res.status(401).json({ success: false, error: { message: 'Invalid agent secret' } });
      return;
    }

    const deviceResult = await query(
      "SELECT id, status, quarantine_status FROM devices WHERE agent_id = $1 AND is_authorized = true",
      [agent_id]
    );
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found or not authorized' } });
      return;
    }

    const device = deviceResult.rows[0];
    const isContained = device.status === 'blocked' || device.status === 'quarantine'
      || device.quarantine_status === 'QUARANTINED' || device.quarantine_status === 'BLOCKED';

    // Anything claimed but never confirmed becomes a failure instead of an
    // eternal "processing" row in the dashboard.
    await query(
      `UPDATE agent_commands
          SET status = 'failed', error_message = 'agent did not confirm execution', completed_at = NOW()
        WHERE device_id = $1 AND status = 'processing' AND created_at < NOW() - INTERVAL '5 minutes'`,
      [device.id]
    );

    const commands = await query(claimPendingCommandsSql(isContained ? 5 : 10, isContained), [device.id]);
    res.json({ success: true, data: { commands: commands.rows } });
  } catch (error) {
    next(error);
  }
});

// Enrollment token for the logged-in account (embedded in install script / mobile QR link)
router.get('/enroll-token', authenticate, requirePermission('devices.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
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
    // Refresh statuses first so a device that stopped heartbeating is reported offline
    await updateOfflineDevices();
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string || '';
    const status = req.query.status as string || '';
    const osPatterns = osFilterPatterns(req.query.os_family ?? req.query.os_type);
    const offset = (page - 1) * limit;
    const seeUnowned = canViewUnownedDevices(req.user);

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
    if (osPatterns) {
      conditions.push(`LOWER(COALESCE(d.os_type, '')) LIKE ANY($${paramIdx}::text[])`);
      params.push(osPatterns);
      paramIdx += 1;
    }
    conditions.push(
      seeUnowned
        ? `(d.created_by = $${paramIdx} OR d.created_by IS NULL)`
        : `d.created_by = $${paramIdx}`
    );
    params.push(req.user!.id);
    paramIdx += 1;
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
    await updateOfflineDevices();
    const seeUnowned = canViewUnownedDevices(req.user);
    const result = await query(
      `SELECT d.id, d.hostname, d.display_name, d.os_type, d.device_type, d.status, d.latitude, d.longitude,
              d.battery_level, d.last_heartbeat, d.ip_address, d.location_updated_at, d.approval_status, d.agent_id,
              u.email as owner_email
         FROM devices d
         LEFT JOIN users u ON u.id = d.created_by
        WHERE ${seeUnowned ? '(d.created_by = $1 OR d.created_by IS NULL)' : 'd.created_by = $1'}
        ORDER BY d.last_heartbeat DESC NULLS LAST`,
      [req.user!.id]
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
    await updateOfflineDevices();
    const deviceResult = await query(
      'SELECT d.*, u.email as owner_email FROM devices d LEFT JOIN users u ON u.id = d.created_by WHERE d.id = $1',
      [id]
    );
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }
    const detailOwner = deviceResult.rows[0].created_by as string | null;
    const canSeeThis = detailOwner === req.user?.id || (detailOwner == null && canViewUnownedDevices(req.user));
    if (!canSeeThis) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const heartbeats = await query('SELECT * FROM device_heartbeats WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 24', [id]);
    // Genuine 24h window for the device history chart. The old chart plotted
    // the 24 most recent samples (~24 minutes) under a "Last 24h" heading.
    const historySeries = await fetchHeartbeatSeries({ deviceId: id, interval: '5m' });
    const events = await query('SELECT * FROM security_events WHERE device_id = $1 ORDER BY created_at DESC LIMIT 10', [id]);
    const software = await query('SELECT * FROM device_software WHERE device_id = $1 ORDER BY name ASC', [id]);
    const services = await query('SELECT * FROM device_services WHERE device_id = $1 ORDER BY name ASC', [id]);
    const processes = await query('SELECT * FROM device_processes WHERE device_id = $1 ORDER BY cpu_usage DESC LIMIT 100', [id]);
    const networkInterfaces = await query('SELECT * FROM device_network_interfaces WHERE device_id = $1', [id]);
    const partitions = await query(
      `SELECT mount_point, device_name, fstype, total_bytes, used_bytes, free_bytes, usage_percent, recorded_at
         FROM device_partitions WHERE device_id = $1 ORDER BY mount_point ASC`,
      [id]
    );
    const interfaceMetrics = await query(
      `SELECT interface_name, bytes_in, bytes_out, rate_in, rate_out, recorded_at
         FROM device_interface_metrics
        WHERE device_id = $1 AND recorded_at > NOW() - INTERVAL '1 hour'
        ORDER BY recorded_at DESC
        LIMIT 500`,
      [id]
    );
    const commands = await query('SELECT * FROM agent_commands WHERE device_id = $1 ORDER BY created_at DESC LIMIT 50', [id]);

    res.json({
      success: true,
      data: {
        device: {
          ...deviceResult.rows[0],
          recent_heartbeats: heartbeats.rows,
          history_series: historySeries,
          recent_events: events.rows,
          software: software.rows,
          services: services.rows,
          processes: processes.rows,
          network_interfaces: networkInterfaces.rows,
          partitions: partitions.rows,
          interface_metrics: interfaceMetrics.rows,
          recent_commands: commands.rows,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// OS event log (Windows Event Log / journald) for one device.
router.get('/:id/events', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const level = typeof req.query.level === 'string' && req.query.level ? req.query.level : null;
    const source = typeof req.query.source === 'string' && req.query.source ? req.query.source : null;

    const deviceResult = await query('SELECT id, created_by FROM devices WHERE id = $1', [id]);
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }
    const owner = deviceResult.rows[0].created_by as string | null;
    if (!(owner === req.user?.id || (owner == null && canViewUnownedDevices(req.user)))) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const clauses = ['device_id = $1'];
    const params: unknown[] = [id];
    if (level) {
      params.push(level);
      clauses.push(`LOWER(level) = LOWER($${params.length})`);
    }
    if (source) {
      params.push(source);
      clauses.push(`log_source = $${params.length}`);
    }
    params.push(limit);

    const rows = await query(
      `SELECT id, log_source, channel, event_id, level, provider, message, detail, occurred_at, recorded_at
         FROM device_event_logs
        WHERE ${clauses.join(' AND ')}
        ORDER BY COALESCE(occurred_at, recorded_at) DESC
        LIMIT $${params.length}`,
      params
    );

    res.json({ success: true, data: { events: rows.rows } });
  } catch (error) {
    next(error);
  }
});

// Daily GPS route: chronological location history of one device for one day.
// Query params: date=YYYY-MM-DD (default: today) and offset=minutes of the client's
// UTC offset (from Date.getTimezoneOffset()) so the day boundaries match local time.
router.get('/:id/route', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const dateStr = String(req.query.date || new Date().toISOString().slice(0, 10));
    const [dy, dm, dd] = dateStr.split('-').map(Number);
    const parsed = new Date(Date.UTC(dy || 1970, (dm || 1) - 1, dd || 1));
    const validDate =
      /^\d{4}-\d{2}-\d{2}$/.test(dateStr) &&
      parsed.getUTCFullYear() === dy &&
      parsed.getUTCMonth() === dm - 1 &&
      parsed.getUTCDate() === dd;
    if (!validDate) {
      res.status(400).json({ success: false, error: { message: 'Invalid date (expected YYYY-MM-DD)' } });
      return;
    }
    const offsetRaw = Number(req.query.offset);
    const offset = Number.isFinite(offsetRaw) ? Math.trunc(offsetRaw) : 0;

    const deviceResult = await query('SELECT id, created_by FROM devices WHERE id = $1', [id]);
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }
    const routeOwner = deviceResult.rows[0].created_by as string | null;
    if (!(routeOwner === req.user?.id || (routeOwner == null && canViewUnownedDevices(req.user)))) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }

    const points = await query(
      `SELECT latitude, longitude, recorded_at FROM device_locations
        WHERE device_id = $1
          AND recorded_at >= (($2::timestamp) + ($3::int * INTERVAL '1 minute')) AT TIME ZONE 'UTC'
          AND recorded_at <  (($2::timestamp) + INTERVAL '1 day' + ($3::int * INTERVAL '1 minute')) AT TIME ZONE 'UTC'
        ORDER BY recorded_at ASC
        LIMIT 3000`,
      [id, dateStr, offset]
    );

    res.json({
      success: true,
      data: { date: dateStr, device_id: id, points: points.rows, count: points.rows.length },
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

// Assign a device to an account. Admin (devices.view_all) only: unowned devices, or
// devices the admin already owns - never another account's device.
router.put('/:id/owner', authenticate, requirePermission('devices.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!canViewUnownedDevices(req.user)) {
      res.status(404).json({ success: false, error: { message: 'Device not found' } });
      return;
    }
    const userId = String(req.body?.user_id || '').trim();
    const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) || /^[0-9a-f]{32}$/i.test(v);
    if (!userId || !isUuid(userId)) {
      res.status(404).json({ success: false, error: { message: 'User not found' } });
      return;
    }
    const target = await query('SELECT id, email FROM users WHERE id = $1 AND is_active = true', [userId]);
    if (target.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'User not found' } });
      return;
    }

    const updated = await query(
      `UPDATE devices SET created_by = $1, updated_at = NOW()
        WHERE id = $2 AND (created_by IS NULL OR created_by = $3)
        RETURNING id`,
      [userId, id, req.user!.id]
    );
    if (updated.rows.length === 0) {
      const existing = await query('SELECT created_by FROM devices WHERE id = $1', [id]);
      res.status(existing.rows.length === 0 ? 404 : 409).json({
        success: false,
        error: { message: existing.rows.length === 0 ? 'Device not found' : 'Device already belongs to another account' },
      });
      return;
    }

    await query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'device_assign', 'device', id, `Device assigned to ${target.rows[0].email}`, req.ip]);

    res.json({ success: true, data: { message: 'Device assigned', owner_id: userId, owner_email: target.rows[0].email } });
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
    await emitDeviceStatus(id, 'blocked');

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
    await emitDeviceStatus(id, 'online');

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
    await emitDeviceStatus(id, 'quarantine');

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

    // ?from=&to=&interval= select the range; without them we keep the legacy
    // "latest 100 samples" behaviour so existing callers are unaffected.
    const hasRange = Boolean(req.query.from || req.query.to || req.query.interval);
    if (!hasRange) {
      const heartbeats = await query(
        'SELECT * FROM device_heartbeats WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 100',
        [id]
      );
      res.json({ success: true, data: { heartbeats: heartbeats.rows } });
      return;
    }

    const range = resolveRange(req.query.from, req.query.to);
    const interval = resolveInterval(req.query.interval as string | undefined, range.seconds);
    const series = await fetchHeartbeatSeries({
      deviceId: id,
      from: range.from,
      to: range.to,
      interval,
    });

    res.json({
      success: true,
      data: {
        series,
        interval,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        // Kept for older clients: newest-first raw samples inside the window.
        heartbeats: await query(
          'SELECT * FROM device_heartbeats WHERE device_id = $1 AND recorded_at >= $2 AND recorded_at < $3 ORDER BY recorded_at DESC LIMIT 500',
          [id, range.from, range.to]
        ).then((r) => r.rows),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Agent inventory (no auth required, uses agent secret)
// Values are sanitized to the column limits/INET syntax: a single over-long name or a
// malformed address used to abort the whole request (500), leaving every tab empty.
const clip = (value: unknown, max: number): string => (value == null ? '' : String(value).slice(0, max));
const toPid = (value: unknown): number => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 2147483647) : 0;
};
const toBoundedNumber = (value: unknown, min: number, max: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
};
const toMac = (value: unknown): string | null => {
  const mac = clip(value, 17);
  return /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(mac) ? mac : null;
};
const toInet = (value: unknown, version: 4 | 6): string | null => {
  const raw = clip(value, 64).split('%')[0].trim(); // drop the IPv6 zone id Windows reports
  if (!raw) return null;
  if (version === 4) {
    const octets = raw.split('.');
    if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) return null;
    return raw;
  }
  return raw.includes(':') && /^[0-9a-f:]+$/i.test(raw) ? raw : null;
};
const toDateOnly = (value: unknown): string | null => {
  const raw = clip(value, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

router.post('/inventory', async (req: AuthRequest, res: Response, next: NextFunction) => {
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
  const client = await getClient();

  // Replace everything atomically: a failure must never leave the tables wiped
  try {
    await client.query('BEGIN');

    await client.query('DELETE FROM device_software WHERE device_id = $1', [deviceId]);
    if (Array.isArray(software)) {
      for (const sw of software) {
        const name = clip(sw?.name, 255) || 'Unknown';
        await client.query(
          'INSERT INTO device_software (device_id, name, version, publisher, install_date) VALUES ($1, $2, $3, $4, $5)',
          [deviceId, name, clip(sw?.version, 100) || null, clip(sw?.publisher, 255) || null, toDateOnly(sw?.install_date)]
        );
      }
    }

    await client.query('DELETE FROM device_services WHERE device_id = $1', [deviceId]);
    if (Array.isArray(services)) {
      for (const svc of services) {
        await client.query(
          'INSERT INTO device_services (device_id, name, display_name, status, startup_type) VALUES ($1, $2, $3, $4, $5)',
          [deviceId, clip(svc?.name, 255) || 'Unknown', clip(svc?.display_name || svc?.name, 255) || null, clip(svc?.status, 50) || null, clip(svc?.startup_type, 50) || null]
        );
      }
    }

    await client.query('DELETE FROM device_processes WHERE device_id = $1', [deviceId]);
    if (Array.isArray(processes)) {
      for (const proc of processes) {
        await client.query(
          'INSERT INTO device_processes (device_id, pid, name, cpu_usage, memory_usage, user_name) VALUES ($1, $2, $3, $4, $5, $6)',
          [deviceId, toPid(proc?.pid), clip(proc?.name, 255) || 'unknown', toBoundedNumber(proc?.cpu_percent ?? proc?.cpu_usage, 0, 999.99), toBoundedNumber(proc?.memory_bytes ?? proc?.memory_usage, 0, Number.MAX_SAFE_INTEGER), clip(proc?.user ?? proc?.user_name, 255) || null]
        );
      }
    }

    await client.query('DELETE FROM device_network_interfaces WHERE device_id = $1', [deviceId]);
    if (Array.isArray(network_interfaces)) {
      for (const iface of network_interfaces) {
        const name = clip(iface?.name, 100) || 'unknown';
        await client.query(
          'INSERT INTO device_network_interfaces (device_id, name, mac_address, ipv4_address, ipv6_address, is_connected, speed_mbps) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [deviceId, name, toMac(iface?.mac ?? iface?.mac_address), toInet(iface?.ipv4 ?? iface?.ipv4_address, 4), toInet(iface?.ipv6 ?? iface?.ipv6_address, 6), !!iface?.is_connected, toBoundedNumber(iface?.speed ?? iface?.speed_mbps, 0, 2147483647)]
        );
      }
    }

    await client.query('UPDATE devices SET last_inventory = NOW() WHERE id = $1', [deviceId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.error('Inventory update failed', { agent_id, error: (error as Error).message });
    next(error);
    return;
  } finally {
    client.release();
  }

  logger.info('Inventory updated', { deviceId, agent_id });
  res.json({ success: true, data: { message: 'Inventory updated' } });
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

    const cmdType = await query('SELECT command_type FROM agent_commands WHERE id = $1', [command_id]);

    logger.info('Command result received', { command_id, status: validStatus });
    res.json({ success: true, data: { message: 'Command result recorded' } });

    // Forensic bundles are analysed after the response so the agent is never
    // kept waiting by the correlation/report work (and retrying the POST
    // cannot start a second analysis - see onForensicCommandResult guard).
    if (cmdType.rows[0]?.command_type === 'forensic_collect') {
      onForensicCommandResult({
        commandId: command_id,
        status: validStatus,
        result: result ?? resultStr,
        errorMessage: errorStr,
      }).catch((err: Error) => {
        logger.error('Forensic result handling failed', { command_id, error: err.message });
      });
    }
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
        await createAlert({
          device_id: device.id,
          alert_type: evt.event_type,
          severity: evt.severity,
          title: evt.title,
          description: evt.description,
          metadata: { device_hostname: device.hostname, source_event: eventId },
          dedup_key: `scan:${device.id}:${evt.event_type}`,
          source: 'security-scan',
          dedup_window_minutes: 60 * 6,
        });
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
      const alertType = alert.alert_type || alert.type;
      if (!alertType || !alert.title) continue;

      // createAlert folds repeats of the same type into one open alert for an
      // hour, and raises email/webhook/socket only on the first occurrence —
      // which is exactly what the hand-rolled "SELECT ... last hour" did, minus
      // the notifications.
      const result = await createAlert({
        device_id: device.id,
        alert_type: alertType,
        severity: alert.severity || 'medium',
        title: alert.title,
        description: alert.description || '',
        metadata: { device_hostname: device.hostname, ...(alert.metadata || {}) },
        dedup_key: `agent:${device.id}:${alertType}`,
        source: 'agent',
        dedup_window_minutes: 60,
      });
      if (result.created) created++;
    }

    res.json({ success: true, data: { message: 'Alerts processed', created } });
  } catch (error) {
    next(error);
  }
});

// Agent OS event-log upload (Windows Event Log, journald, unified log).
// Stored newest-first and deduped on (device, source, event key) so the agent
// can re-send the same window after a network failure without flooding the table.
router.post('/events', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { agent_id, events } = req.body;
    if (!agent_id || !Array.isArray(events)) {
      res.status(400).json({ success: false, error: { message: 'agent_id and events array required' } });
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

    let stored = 0;
    for (const e of (events as Array<Record<string, unknown>>).slice(0, 200)) {
      const message = asText(e?.message, 4000);
      if (!message) continue;

      const logSource = asText(e?.log_source, 40) || 'system';
      const rawOccurred = e?.occurred_at ? new Date(String(e.occurred_at)) : null;
      const occurredAt = rawOccurred && !Number.isNaN(rawOccurred.getTime()) ? rawOccurred.toISOString() : null;
      const providedKey = asText(e?.dedup_key, 300);
      const dedupKey = providedKey || `${logSource}:${asText(e?.event_id, 40) || ''}:${occurredAt || ''}:${message.slice(0, 160)}`;

      const r = await query(
        `INSERT INTO device_event_logs
           (device_id, log_source, channel, event_id, level, provider, message, detail, occurred_at, dedup_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (device_id, log_source, dedup_key)
         DO UPDATE SET
           level = EXCLUDED.level,
           message = EXCLUDED.message,
           detail = EXCLUDED.detail,
           occurred_at = COALESCE(EXCLUDED.occurred_at, device_event_logs.occurred_at),
           recorded_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [
          deviceId,
          logSource,
          asText(e?.channel, 100),
          asText(e?.event_id, 40),
          asText(e?.level, 20),
          asText(e?.provider, 255),
          message,
          e?.detail !== undefined && e?.detail !== null ? JSON.stringify(e.detail) : null,
          occurredAt,
          dedupKey,
        ]
      );
      if (r.rows[0]?.inserted) stored++;
    }

    res.json({ success: true, data: { received: events.length, stored } });
  } catch (error) {
    next(error);
  }
});

// Download agent installer script (embeds the shared secret: devices.manage only)
router.get('/download/installer', authenticate, requirePermission('devices.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const serverUrl = `${req.protocol}://${req.get('host')}/api`;
    const agentSecret = requireAgentSecret();
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
    const allowedFiles = ['agent.py', 'system_info.py', 'remote.py', 'forensics.py', 'requirements.txt', 'crypto_utils.py'];

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

// PUBLIC - Download installer (requires enrolment token minted by a devices.manage user)
router.get('/public/install.ps1', requireEnrollToken, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const host = req.get('host') || 'endpointx.onrender.com';
    const protocol = req.protocol === 'https' ? 'https' : 'https';
    const serverUrl = `${protocol}://${host}`;
    const agentSecret = requireAgentSecret();

    const filePath = join(__dirname, '..', '..', 'public', 'install.ps1');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'Install script not found' } });
      return;
    }

    let script = readFileSync(filePath, 'utf-8');
    script = script.replace(/##SERVER_URL##/g, serverUrl);
    script = script.replace(/##AGENT_SECRET##/g, agentSecret);
    script = script.replace(/##ENROLL_TOKEN##/g, enrollOwnerFromRequest(req) || '');

    // text/plain (no attachment) so `irm ... | iex` receives a clean string
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(script);
  } catch (error) {
    next(error);
  }
});

// PUBLIC - Download Linux install script (requires enrolment token)
router.get('/public/install-linux.sh', requireEnrollToken, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const host = req.get('host') || 'endpointx.onrender.com';
    const protocol = req.protocol === 'https' ? 'https' : 'https';
    const serverUrl = `${protocol}://${host}`;
    const agentSecret = requireAgentSecret();

    const filePath = join(__dirname, '..', '..', 'endpoint-agent', 'install-linux.sh');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'Linux install script not found' } });
      return;
    }

    let script = readFileSync(filePath, 'utf-8');
    script = script.replace(/##SERVER_URL##/g, serverUrl);
    script = script.replace(/##AGENT_SECRET##/g, agentSecret);
    script = script.replace(/##ENROLL_TOKEN##/g, enrollOwnerFromRequest(req) || '');

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="install-endpointx-linux.sh"');
    res.send(script);
  } catch (error) {
    next(error);
  }
});

// PUBLIC - Download macOS install script (requires enrolment token)
router.get('/public/install-macos.sh', requireEnrollToken, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const host = req.get('host') || 'endpointx.onrender.com';
    const protocol = req.protocol === 'https' ? 'https' : 'https';
    const serverUrl = `${protocol}://${host}`;
    const agentSecret = requireAgentSecret();

    const filePath = join(__dirname, '..', '..', 'endpoint-agent', 'install-macos.sh');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'macOS install script not found' } });
      return;
    }

    let script = readFileSync(filePath, 'utf-8');
    script = script.replace(/##SERVER_URL##/g, serverUrl);
    script = script.replace(/##AGENT_SECRET##/g, agentSecret);
    script = script.replace(/##ENROLL_TOKEN##/g, enrollOwnerFromRequest(req) || '');

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
    const allowedFiles = ['agent.py', 'system_info.py', 'remote.py', 'forensics.py', 'requirements.txt', 'crypto_utils.py'];

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

// PUBLIC - Android agent APK (download link from the install page)
router.get('/public/endpointx-agent.apk', (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filePath = join(__dirname, '..', '..', 'public', 'apk', 'endpointx-agent.apk');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'APK not found' } });
      return;
    }
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="endpointx-agent.apk"');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

// PUBLIC - assisted Android setup (installs + enables remote control over adb)
router.get('/public/enable-control.bat', (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const filePath = join(__dirname, '..', '..', 'public', 'apk', 'enable-control.bat');
    if (!existsSync(filePath)) {
      res.status(404).json({ success: false, error: { message: 'Script not found' } });
      return;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="enable-control.bat"');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filePath);
  } catch (error) {
    next(error);
  }
});

function parseBrowserFromUA(ua: string): { name: string; version: string } | null {
  const s = ua || '';
  const pick = (re: RegExp, name: string): { name: string; version: string } | null => {
    const m = s.match(re);
    return m ? { name, version: m[1] } : null;
  };
  return (
    pick(/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Edge') ||
    pick(/OPR\/([\d.]+)/, 'Opera') ||
    pick(/SamsungBrowser\/([\d.]+)/, 'Samsung Internet') ||
    pick(/Firefox\/([\d.]+)/, 'Firefox') ||
    pick(/CriOS\/([\d.]+)/, 'Chrome') ||
    pick(/FxiOS\/([\d.]+)/, 'Firefox') ||
    pick(/Chrome\/([\d.]+)/, 'Chrome') ||
    pick(/Version\/([\d.]+)[\s\S]*Safari\//, 'Safari')
  );
}

function sanitizeIp(raw: string | null): string | null {
  const ip = (raw || '').trim();
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every((o) => Number(o) <= 255)) return ip;
  if (ip.includes(':') && /^[0-9a-fA-F:]+$/.test(ip)) return ip;
  return null;
}

// Mobile (PWA) inventory: what a browser can honestly report - the PWA itself and the browser.
async function syncMobileSoftware(deviceId: string, ua: string): Promise<void> {
  const browser = parseBrowserFromUA(ua);
  await query('DELETE FROM device_software WHERE device_id = $1', [deviceId]);
  const rows: Array<[string, string, string]> = [
    ['EndpointX Mobile (PWA)', process.env.APP_VERSION || '1.2.0', 'EndpointX'],
  ];
  if (browser) rows.push([browser.name, browser.version, 'Web browser']);
  for (const [name, version, publisher] of rows) {
    await query(
      `INSERT INTO device_software (device_id, name, version, publisher, install_date)
       VALUES ($1, $2, $3, $4, CURRENT_DATE)`,
      [deviceId, name, version, publisher]
    );
  }
}

// Mobile (PWA) network: one interface row from Network Information API + observed client IP.
async function syncMobileNetworkInterface(
  deviceId: string,
  ip: string | null,
  network: Record<string, unknown>
): Promise<void> {
  const effType = typeof network.effective_type === 'string' ? network.effective_type.slice(0, 16) : '';
  const connType = typeof network.type === 'string' ? network.type.slice(0, 16) : '';
  const downlink = typeof network.downlink === 'number' && Number.isFinite(network.downlink)
    ? network.downlink
    : null;
  const label = (connType && connType !== 'unknown' ? connType : effType || 'observed').replace(/[()]/g, '');
  const speed = downlink != null && downlink >= 1 ? Math.round(downlink) : null;
  await query('DELETE FROM device_network_interfaces WHERE device_id = $1', [deviceId]);
  await query(
    `INSERT INTO device_network_interfaces (device_id, name, ipv4_address, is_connected, speed_mbps)
     VALUES ($1, $2, $3, TRUE, $4)`,
    [deviceId, `Connection (${label})`.slice(0, 100), ip, speed]
  );
}

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

    // Enrollment proof is mandatory: mobile enrollment mints a remote_token
    // and creates devices, so it is restricted to install links minted by a
    // devices.manage holder (?t= / stored enroll_token).
    const ownerUserId = enrollOwnerFromRequest(req);
    if (!ownerUserId) {
      res.status(401).json({ success: false, error: { message: 'Valid enrolment token required' } });
      return;
    }

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
      await syncMobileSoftware(deviceId, String(user_agent || req.headers['user-agent'] || ''));
      res.json({
        success: true,
        data: {
          device_id: deviceId,
          agent_id: agentId,
          remote_token: remoteSecretFor(agentId),
          approval_status: existing.rows[0].approval_status || 'pending',
          is_new: false,
        },
      });
      return;
    }

    // Same phone registering again (APK reinstalled or enrolment page reopened):
    // same OS, name and model coming from the same IP => reuse its row.
    const duplicate = await findDeviceByIp(req, {
      osType: os,
      hostname: name,
      model: (model || '').trim(),
    });
    if (duplicate) {
      await query(
        `UPDATE devices SET
           agent_id = $2,
           hostname = $3,
           display_name = $3,
           device_type = $4,
           os_type = $5,
           manufacturer = COALESCE(NULLIF($6, ''), manufacturer),
           model = COALESCE(NULLIF($7, ''), model),
           ownership = $8,
           department = COALESCE(NULLIF($9, ''), department),
           ip_address = COALESCE(NULLIF($10::text, '')::inet, ip_address),
           created_by = COALESCE(created_by, $11),
           updated_at = NOW()
         WHERE id = $1`,
        [
          duplicate.id,
          agentId,
          name,
          inferredType,
          os,
          (user_agent || '').includes('iPhone') ? 'Apple' : (user_agent || '').includes('Android') ? 'Android' : '',
          (model || '').trim().slice(0, 80),
          ownershipValue,
          (department || '').trim().slice(0, 80),
          requestIp(req),
          ownerUserId || null,
        ]
      );
      const kept = await query('SELECT approval_status FROM devices WHERE id = $1', [duplicate.id]);
      await syncMobileSoftware(duplicate.id, String(user_agent || req.headers['user-agent'] || ''));
      logger.info('Mobile device re-enrolled and matched by IP fingerprint', {
        deviceId: duplicate.id,
        agentId,
        ip: requestIp(req),
      });
      res.json({
        success: true,
        data: {
          device_id: duplicate.id,
          agent_id: agentId,
          remote_token: remoteSecretFor(agentId),
          approval_status: kept.rows[0]?.approval_status || 'pending',
          is_new: false,
          deduplicated: true,
        },
      });
      return;
    }

    const deviceId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    await query(
      `INSERT INTO devices (
         id, agent_id, hostname, display_name, os_type, device_type, manufacturer, model,
         ownership, department, ip_address, status, is_authorized, trust_level, approval_status,
         managed, mdm_enrolled, quarantine_status, first_seen, registered_at, notes, created_by
       ) VALUES (
         $1, $2, $3, $3, $4, $5, $6, $7,
         $8, $9, NULLIF($12::text, '')::inet, 'offline', false, 'UNKNOWN', 'pending',
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
        requestIp(req),
      ]
    );

    await syncMobileSoftware(deviceId, String(user_agent || req.headers['user-agent'] || ''));

    logger.info('Mobile device enrolled', { deviceId, agentId, ownership: ownershipValue });
    res.status(201).json({
      success: true,
      data: {
        device_id: deviceId,
        agent_id: agentId,
        remote_token: remoteSecretFor(agentId),
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
    const { agent_id: clientAgentId, battery_level, latitude, longitude, network, ram_total, cpu_cores,
            ram_used, ram_usage, cpu_usage, disk_total, disk_used, disk_usage } = req.body as Record<string, unknown>;
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
    // Real telemetry reported by the Android app (memory / CPU / storage).
    const toIntOrNull = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
    };
    const toPctOrNull = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) / 100 : null;
    };
    const ramTotal = toIntOrNull(ram_total);
    const ramUsed = toIntOrNull(ram_used);
    const ramPct = toPctOrNull(ram_usage);
    const cpuPct = toPctOrNull(cpu_usage);
    const cpuCores = toIntOrNull(cpu_cores);
    const diskTotal = toIntOrNull(disk_total);
    const diskUsed = toIntOrNull(disk_used);
    const diskPct = toPctOrNull(disk_usage);
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
             ram_total = COALESCE($7::bigint, ram_total),
             ram_used = COALESCE($8::bigint, ram_used),
             ram_usage = COALESCE($9::double precision, ram_usage),
             cpu_cores = COALESCE($10::int, cpu_cores),
             cpu_usage = COALESCE($11::double precision, cpu_usage),
             disk_total = COALESCE($12::bigint, disk_total),
             disk_used = COALESCE($13::bigint, disk_used),
             disk_usage = COALESCE($14::double precision, disk_usage),
             updated_at = NOW()
       WHERE id = $6`,
      [nextStatus, ip, battery, lat, lng, existing.rows[0].id,
       ramTotal, ramUsed, ramPct, cpuCores, cpuPct, diskTotal, diskUsed, diskPct]
    );
    if (cpuPct != null || ramPct != null || diskPct != null) {
      const hbId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      await query(
        'INSERT INTO device_heartbeats (id, device_id, cpu_usage, ram_usage, disk_usage, network_in, network_out, active_processes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [hbId, existing.rows[0].id, cpuPct ?? 0, ramPct ?? 0, diskPct ?? 0, 0, 0, 0]
      );
    }
    const deviceId = existing.rows[0].id;
    // Persist GPS history point for the daily route.
    // Dedupe: skip if the same spot was already stored in the last 2 minutes.
    if (lat != null && lng != null) {
      await query(
        `INSERT INTO device_locations (device_id, latitude, longitude, recorded_at)
         SELECT $1, $2, $3, NOW()
          WHERE NOT EXISTS (
            SELECT 1 FROM device_locations
             WHERE device_id = $1
               AND recorded_at > NOW() - INTERVAL '2 minutes'
               AND ABS(latitude - $2) < 0.0002
               AND ABS(longitude - $3) < 0.0002
          )`,
        [deviceId, lat, lng]
      );
    }
    const ua = String(req.headers['user-agent'] || '');
    const swCount = await query(
      'SELECT COUNT(*)::int AS count FROM device_software WHERE device_id = $1',
      [deviceId]
    );
    if (Number(swCount.rows[0]?.count || 0) === 0 && ua) {
      await syncMobileSoftware(deviceId, ua);
    }
    if (network && typeof network === 'object') {
      await syncMobileNetworkInterface(deviceId, sanitizeIp(ip), network as Record<string, unknown>);
    }
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

import { Router, Response, NextFunction } from 'express';
import net from 'net';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import logger from '../utils/logger';
import {
  isOpencodeConfigured,
  aiHealth,
  analyzeSecurityContext,
  recommendForFinding,
  localAnalyzeSecurityContext,
  localRecommendForFinding,
  freeModelsForProvider,
} from '../services/opencode';

const router = Router();

function newId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

async function audit(action: string, req: AuthRequest, targetType: string, targetId: string, details: any = {}) {
  try {
    await query(
      'INSERT INTO hermes_audit_logs (id, action, actor_id, actor_email, target_type, target_id, details, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [newId(), action, req.user?.id || null, req.user?.email || null, targetType, targetId, JSON.stringify(details), req.ip || null]
    );
  } catch (e) {
    logger.warn('HERMES audit write failed', { action, error: (e as Error).message });
  }
}

async function getSetting(key: string, fallback = ''): Promise<string> {
  const r = await query('SELECT value FROM app_settings WHERE key = $1', [key]);
  return r.rows[0]?.value ?? fallback;
}

function parseCidrs(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function ipToLong(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = parseInt(p, 10);
    if (Number.isNaN(v) || v < 0 || v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = bitsStr !== undefined ? parseInt(bitsStr, 10) : 32;
  if (Number.isNaN(bits) || bits < 0 || bits > 32) return false;
  const ipN = ipToLong(ip);
  const baseN = ipToLong(base);
  if (ipN === null || baseN === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ipN & mask) === (baseN & mask);
}

export async function isIpAllowed(ip: string): Promise<boolean> {
  const cidrs = parseCidrs(await getSetting('hermes_allowed_cidrs', '192.168.0.0/16,10.0.0.0/8,172.16.0.0/12'));
  if (cidrs.length === 0) return false;
  return cidrs.some((c) => ipInCidr(ip, c));
}

export async function isEmergencyStopped(): Promise<boolean> {
  return (await getSetting('hermes_emergency_stop', 'false')) === 'true';
}

const COMMON_SERVICES: Record<number, string> = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP',
  110: 'POP3', 111: 'RPCBind', 135: 'MSRPC', 139: 'NetBIOS', 143: 'IMAP',
  389: 'LDAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 587: 'Submission',
  993: 'IMAPS', 995: 'POP3S', 1433: 'MSSQL', 1521: 'Oracle', 2049: 'NFS',
  3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL', 5900: 'VNC', 6379: 'Redis',
  8080: 'HTTP-Proxy', 8443: 'HTTPS-Alt', 9200: 'Elasticsearch', 27017: 'MongoDB',
};

const RISKY_PORTS = new Set([21, 23, 25, 135, 139, 445, 1433, 1521, 3389, 5900, 6379, 11211, 2375]);

function portRisk(port: number): string {
  if (port === 3389 || port === 5900 || port === 23 || port === 21) return 'high';
  if (RISKY_PORTS.has(port)) return 'medium';
  if (port === 80 || port === 443 || port === 22 || port === 53) return 'low';
  return 'info';
}

function probePort(host: string, port: number, timeoutMs: number): Promise<'open' | 'closed' | 'filtered'> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (state: 'open' | 'closed' | 'filtered') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('open'));
    socket.once('timeout', () => done('filtered'));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') done('closed');
      else if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH') done('filtered');
      else done('filtered');
    });
    socket.connect(port, host);
  });
}

async function grabBanner(host: string, port: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let data = '';
    let settled = false;
    const done = (val: string | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(val && data ? data.slice(0, 256) : val ? data.slice(0, 256) : null);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      if (port === 80 || port === 8080 || port === 8000 || port === 8888) {
        socket.write(`GET / HTTP/1.0\r\nHost: ${host}\r\n\r\n`);
      } else if (port === 22 || port === 21 || port === 25) {
        // wait for server greeting
      } else {
        socket.write('\r\n');
      }
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('utf-8');
      if (data.length > 0) done(data);
    });
    socket.once('timeout', () => done(data || null));
    socket.once('error', () => done(data || null));
    socket.connect(port, host);
  });
}

function detectService(port: number, banner: string | null): { service: string; product: string | null; version: string | null; confidence: number; method: string } {
  const known = COMMON_SERVICES[port] || 'unknown';
  if (!banner) {
    return { service: known, product: null, version: null, confidence: known !== 'unknown' ? 60 : 0, method: 'port-map' };
  }
  const lower = banner.toLowerCase();
  let product: string | null = null;
  let version: string | null = null;
  if (lower.includes('nginx')) product = 'nginx';
  else if (lower.includes('apache')) product = 'Apache';
  else if (lower.includes('openssh')) product = 'OpenSSH';
  else if (lower.includes('microsoft iis')) product = 'IIS';
  else if (lower.includes('mysql')) product = 'MySQL';
  else if (lower.includes('postgresql')) product = 'PostgreSQL';
  else if (lower.includes('redis')) product = 'Redis';
  else if (lower.includes('microsoft sql')) product = 'MSSQL';
  else if (lower.includes('ftp')) product = known === 'FTP' ? 'FTP' : product;

  const verMatch =
    (product === 'OpenSSH' && banner.match(/openssh[_-]?(\d+\.\d+(?:\.\d+)?)/i)) ||
    banner.match(/(\d+\.\d+(?:\.\d+)?)/);
  if (verMatch) version = verMatch[1];

  let service = known;
  if (lower.startsWith('ssh-')) service = 'SSH';
  else if (lower.includes('http/')) service = lower.includes('https') ? 'HTTPS' : 'HTTP';

  return {
    service,
    product,
    version,
    confidence: product ? 90 : 70,
    method: product ? 'banner' : 'port+banner',
  };
}

async function syncAssetFromDevice(device: any) {
  const existing = await query('SELECT id FROM hermes_assets WHERE device_id = $1', [device.id]);
  if (existing.rows.length === 0) {
    await query(
      `INSERT INTO hermes_assets (id, device_id, hostname, ip_address, os_type, os_version, is_authorized, agent_online, last_seen, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, true, NOW(), NOW())`,
      [newId(), device.id, device.hostname, device.ip_address || null, device.os_type || null, device.os_version || null]
    );
  } else {
    await query(
      `UPDATE hermes_assets SET hostname = $1, ip_address = $2, os_type = $3, os_version = $4, is_authorized = true, agent_online = true, last_seen = NOW(), updated_at = NOW() WHERE device_id = $5`,
      [device.hostname, device.ip_address || null, device.os_type || null, device.os_version || null, device.id]
    );
  }
}

async function discoverUnknownAsset(ip: string) {
  const existing = await query('SELECT id FROM hermes_assets WHERE ip_address = $1 AND device_id IS NULL', [ip]);
  if (existing.rows.length > 0) return;
  const id = newId();
  await query(
    `INSERT INTO hermes_assets (id, hostname, ip_address, is_authorized, agent_online, first_seen, updated_at)
     VALUES ($1, NULL, $2, false, false, NOW(), NOW())`,
    [id, ip]
  );
  await query(
    `INSERT INTO hermes_alerts (id, alert_type, severity, asset_id, title, description, evidence, recommended_action, is_open, created_at)
     VALUES ($1, 'unknown_device', 'high', $2, 'UNKNOWN ASSET DETECTED', $3, $4, $5, true, NOW())`,
    [
      newId(),
      id,
      `Device ${ip} was observed but is not a registered NetSentinel endpoint.`,
      JSON.stringify([{ source: 'hermes-discovery', ip, timestamp: new Date().toISOString() }]),
      'Review the asset and authorize or ignore it in HERMES.',
    ]
  );
  logger.info('HERMES unknown asset detected', { ip });
}

async function loadPolicy(scanType: string) {
  const nameMap: Record<string, string> = {
    quick: 'Safe Scan',
    daily: 'Standard Scan',
    weekly: 'Standard Scan',
    full: 'Deep Assessment',
    custom: 'Standard Scan',
  };
  const policyName = nameMap[scanType] || 'Standard Scan';
  const r = await query('SELECT * FROM hermes_scan_policies WHERE name = $1', [policyName]);
  return r.rows[0] || {
    ports: '21,22,53,80,443,445,3306,3389,5432,8080,8443',
    excluded_ports: '',
    excluded_hosts: '',
    max_concurrency: 5,
    request_timeout_ms: 2000,
    rate_limit_per_sec: 20,
    id: null,
  };
}

function parsePortList(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes('-')) {
      const [a, b] = p.split('-').map((x) => parseInt(x, 10));
      if (!Number.isNaN(a) && !Number.isNaN(b) && a >= 1 && b <= 65535 && a <= b) {
        for (let i = a; i <= Math.min(b, a + 2048); i++) out.add(i);
      }
    } else {
      const n = parseInt(p, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= 65535) out.add(n);
    }
  }
  return Array.from(out);
}

async function runScan(scanId: string, scanType: string, startedBy: string | null) {
  const emergency = await isEmergencyStopped();
  if (emergency) {
    await query(`UPDATE hermes_scans SET status = 'stopped', completed_at = NOW(), error_message = $1 WHERE id = $2`, ['Emergency stop active', scanId]);
    return;
  }

  await query(`UPDATE hermes_scans SET status = 'running', started_at = NOW() WHERE id = $1`, [scanId]);

  try {
    const policy = await loadPolicy(scanType);
    const ports = parsePortList(String(policy.ports || ''));
    const excluded = new Set(parsePortList(String(policy.excluded_ports || '')));
    const timeoutMs = parseInt(String(policy.request_timeout_ms || 2000), 10) || 2000;
    const concurrency = Math.max(1, Math.min(20, parseInt(String(policy.max_concurrency || 5), 10) || 5));
    const rate = Math.max(1, Math.min(100, parseInt(String(policy.rate_limit_per_sec || 20), 10) || 20));
    const delayMs = Math.ceil(1000 / rate);

    const devices = await query(
      `SELECT id, hostname, ip_address, os_type, os_version, status, last_heartbeat
       FROM devices WHERE is_authorized = true AND ip_address IS NOT NULL`
    );

    let assetsScanned = 0;
    let portsFound = 0;
    let servicesFound = 0;

    for (const device of devices.rows) {
      if (await isEmergencyStopped()) {
        await query(`UPDATE hermes_scans SET status = 'stopped', completed_at = NOW() WHERE id = $1`, [scanId]);
        return;
      }

      const ip = String(device.ip_address);
      if (!(await isIpAllowed(ip))) {
        logger.info('HERMES skipped IP outside allowed CIDR', { ip, scanId });
        continue;
      }
      if (policy.excluded_hosts && String(policy.excluded_hosts).split(',').some((h) => h.trim() === ip)) continue;

      await syncAssetFromDevice(device);
      const assetRow = await query('SELECT id FROM hermes_assets WHERE device_id = $1', [device.id]);
      const assetId = assetRow.rows[0]?.id;
      if (!assetId) continue;
      assetsScanned++;

      const openPorts: Array<{ port: number; state: string }> = [];
      let i = 0;
      while (i < ports.length) {
        if (await isEmergencyStopped()) break;
        const batch = ports.slice(i, i + concurrency).filter((p) => !excluded.has(p));
        i += concurrency;
        const results = await Promise.all(batch.map((p) => probePort(ip, p, timeoutMs)));
        for (let j = 0; j < batch.length; j++) {
          openPorts.push({ port: batch[j], state: results[j] });
        }
        if (batch.length > 0) await new Promise((r) => setTimeout(r, delayMs));
      }

      for (const { port, state } of openPorts) {
        if (state !== 'open' && state !== 'closed' && state !== 'filtered') continue;
        if (state !== 'open') continue;

        let banner: string | null = null;
        if ([21, 22, 25, 80, 110, 143, 443, 993, 8080, 8443].includes(port)) {
          banner = await grabBanner(ip, port, Math.min(timeoutMs, 1500));
        }
        const ident = detectService(port, banner);

        await query(
          `INSERT INTO hermes_ports (id, asset_id, scan_id, port, protocol, state, service, product, version, banner, detection_method, confidence, risk, first_seen, last_seen)
           VALUES ($1, $2, $3, $4, 'tcp', 'open', $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
           ON CONFLICT (asset_id, port, protocol)
           DO UPDATE SET state = 'open', service = EXCLUDED.service, product = EXCLUDED.product, version = EXCLUDED.version,
             banner = EXCLUDED.banner, detection_method = EXCLUDED.detection_method, confidence = EXCLUDED.confidence,
             risk = EXCLUDED.risk, last_seen = NOW()`,
          [newId(), assetId, scanId, port, ident.service, ident.product, ident.version, banner, ident.method, ident.confidence, portRisk(port)]
        );
        portsFound++;

        const portRow = await query('SELECT id FROM hermes_ports WHERE asset_id = $1 AND port = $2 AND protocol = $3', [assetId, port, 'tcp']);
        const portId = portRow.rows[0]?.id;
        if (ident.product) {
          await query(
            `INSERT INTO hermes_services (id, asset_id, port_id, name, product, version, cpe, confidence, detection_method, detected_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
            [newId(), assetId, portId, ident.service, ident.product, ident.version, null, ident.confidence, ident.method]
          );
          servicesFound++;
        }

        // Baseline / anomaly: new open port vs previous baseline
        const baseline = await query(`SELECT snapshot FROM hermes_baselines WHERE asset_id = $1 AND baseline_type = 'ports'`, [assetId]);
        if (baseline.rows.length === 0) {
          await query(
            `INSERT INTO hermes_baselines (id, asset_id, baseline_type, snapshot, captured_at) VALUES ($1, $2, 'ports', $3, NOW())
             ON CONFLICT (asset_id, baseline_type) DO UPDATE SET snapshot = EXCLUDED.snapshot, captured_at = NOW()`,
            [newId(), assetId, JSON.stringify({ ports: [port] })]
          );
        } else {
          const snap = typeof baseline.rows[0].snapshot === 'string' ? JSON.parse(baseline.rows[0].snapshot) : baseline.rows[0].snapshot;
          const known: number[] = Array.isArray(snap?.ports) ? snap.ports : [];
          if (!known.includes(port)) {
            const updated = [...known, port];
            await query(`UPDATE hermes_baselines SET snapshot = $1, captured_at = NOW() WHERE asset_id = $2 AND baseline_type = 'ports'`, [JSON.stringify({ ports: updated }), assetId]);
            if (known.length > 0) {
              await query(
                `INSERT INTO hermes_findings (id, scan_id, asset_id, port_id, finding_type, severity, title, description, evidence, confidence, risk_score, risk_reasons, is_potential, status, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, 'new_open_port', 'medium', $5, $6, $7, 80, 50, $8, false, 'open', NOW(), NOW())`,
                [
                  newId(), scanId, assetId, portId,
                  'NEW OPEN PORT',
                  `Port ${port}/${ident.service} was not present in the previous baseline.`,
                  JSON.stringify([{ port, service: ident.service, previous_baseline: known, detected_at: new Date().toISOString() }]),
                  ['New attack surface detected'],
                ]
              );
              await query(
                `INSERT INTO hermes_alerts (id, alert_type, severity, asset_id, title, description, evidence, recommended_action, is_open, created_at)
                 VALUES ($1, 'new_open_port', 'medium', $2, $3, $4, $5, $6, true, NOW())`,
                [newId(), assetId, 'NEW OPEN PORT', `Port ${port} opened on ${device.hostname || ip}.`, JSON.stringify([{ port, protocol: 'tcp' }]), 'Verify whether this service is intentional.']
              );
            }
          }
        }

        // Endpoint inventory findings for outdated/high-risk posture
        if (port === 3389 || port === 23 || port === 21 || port === 5900) {
          await query(
            `INSERT INTO hermes_findings (id, scan_id, asset_id, port_id, finding_type, severity, title, description, evidence, confidence, risk_score, risk_reasons, is_potential, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, 'risky_service', 'high', $5, $6, $7, 95, 75, $8, false, 'open', NOW(), NOW())
             ON CONFLICT DO NOTHING`,
            [
              newId(), scanId, assetId, portId,
              `HIGH RISK SERVICE: ${ident.service} on port ${port}`,
              `${ident.service} increases exposure and should be restricted or disabled if not required.`,
              JSON.stringify([{ port, protocol: 'tcp', service: ident.service, banner }]),
              ['Service exposure', 'Internet-facing risk if routed'],
            ]
          );
        }
      }

      // Asset change detection: new ports count vs previous
      await query(`UPDATE hermes_assets SET updated_at = NOW(), agent_online = $1, last_seen = NOW() WHERE id = $2`, [device.status === 'online', assetId]);
    }

    // Scan software inventory for CVE correlation (Phase 4)
    await correlateSoftwareVulns(scanId);
    await updatePostureScores();

    await query(
      `UPDATE hermes_scans SET status = 'completed', completed_at = NOW(), stats = $1 WHERE id = $2`,
      [JSON.stringify({ assets: assetsScanned, ports_found: portsFound, services_found: servicesFound }), scanId]
    );
    await query(
      'INSERT INTO hermes_audit_logs (id, action, actor_id, target_type, target_id, details) VALUES ($1, $2, $3, $4, $5, $6)',
      [newId(), 'scan_completed', startedBy, 'scan', scanId, JSON.stringify({ assetsScanned, portsFound, servicesFound })]
    );
    logger.info('HERMES scan completed', { scanId, assetsScanned, portsFound });
  } catch (err) {
    logger.error('HERMES scan failed', { scanId, error: (err as Error).message });
    await query(`UPDATE hermes_scans SET status = 'failed', completed_at = NOW(), error_message = $1 WHERE id = $2`, [(err as Error).message, scanId]);
  }
}

// Lightweight local CVE knowledge (defensive, evidence-based)
const LOCAL_CVE_RULES: Array<{
  product: string;
  matchVersion?: (v: string) => boolean;
  cve: string;
  cvss: number;
  severity: string;
  description: string;
  remediation: string;
  potential?: boolean;
}> = [
  {
    product: 'Apache',
    matchVersion: (v) => /^2\.4\.(4[0-9]|5[0-8])/.test(v),
    cve: 'CVE-2021-41773',
    cvss: 7.5,
    severity: 'high',
    description: 'Path traversal and file disclosure in specific Apache 2.4.49 builds (version-range match).',
    remediation: 'Upgrade Apache HTTP Server to a vendor-supported fixed release.',
    potential: true,
  },
  {
    product: 'OpenSSH',
    matchVersion: (v) => /^7\./.test(v) || /^8\.[0-4]/.test(v),
    cve: 'CVE-2024-6387',
    cvss: 8.1,
    severity: 'high',
    description: 'Signal handler race condition in sshd (affected version ranges vary by vendor).',
    remediation: 'Apply the OS vendor OpenSSH security update.',
    potential: true,
  },
  {
    product: 'Redis',
    matchVersion: (v) => /^6\.0\./.test(v),
    cve: 'CVE-2022-0543',
    cvss: 10.0,
    severity: 'critical',
    description: 'Lua sandbox escape on certain packaged Redis builds (Debian/Ubuntu specific).',
    remediation: 'Update the Redis package from the distribution vendor.',
    potential: true,
  },
  {
    product: 'MySQL',
    matchVersion: (v) => /^5\.7\./.test(v) || /^5\.6\./.test(v),
    cve: 'CVE-2016-6662',
    cvss: 9.8,
    severity: 'critical',
    description: 'Privilege escalation / remote code risk on older MySQL 5.6/5.7 (version-range match).',
    remediation: 'Upgrade MySQL to a currently supported release.',
    potential: true,
  },
  {
    product: 'nginx',
    matchVersion: (v) => /^1\.1[0-9]\./.test(v),
    cve: 'CVE-2019-20372',
    cvss: 5.3,
    severity: 'medium',
    description: 'Error page request smuggling on older nginx 1.x branches (heuristic version match).',
    remediation: 'Upgrade nginx to the latest stable or mainline release.',
    potential: true,
  },
];

async function correlateSoftwareVulns(scanId: string) {
  const ports = await query(
    `SELECT p.id as port_id, p.asset_id, p.product, p.version, p.port, p.service
     FROM hermes_ports p WHERE p.state = 'open' AND p.product IS NOT NULL`
  );

  for (const row of ports.rows) {
    if (!row.product || !row.version) continue;
    for (const rule of LOCAL_CVE_RULES) {
      if (rule.product.toLowerCase() !== String(row.product).toLowerCase()) continue;
      if (rule.matchVersion && !rule.matchVersion(String(row.version))) continue;

      await query(
        `INSERT INTO hermes_cves (id, cve_id, cvss_score, severity, description, affected_product, affected_version, cpe, remediation, cve_references, source, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'local', NOW())
         ON CONFLICT (cve_id) DO NOTHING`,
        [
          newId(), rule.cve, rule.cvss, rule.severity, rule.description,
          rule.product, row.version, null, rule.remediation,
          ['https://nvd.nist.gov/vuln/detail/' + rule.cve],
        ]
      );

      const existing = await query(
        `SELECT id FROM hermes_findings WHERE asset_id = $1 AND cve_id = $2 AND finding_type = 'vulnerability' AND status = 'open'`,
        [row.asset_id, rule.cve]
      );
      if (existing.rows.length > 0) continue;

      const findingId = newId();
      await query(
        `INSERT INTO hermes_findings (id, scan_id, asset_id, port_id, cve_id, finding_type, severity, title, description, evidence, confidence, risk_score, risk_reasons, is_potential, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'vulnerability', $6, $7, $8, $9, $10, $11, $12, $13, 'open', NOW(), NOW())`,
        [
          findingId, scanId, row.asset_id, row.port_id, rule.cve, rule.severity,
          `${rule.cve} — ${rule.product} ${row.version}`,
          rule.description,
          JSON.stringify([
            { check: 'Port open', value: row.port },
            { check: 'Product fingerprint', value: row.product },
            { check: 'Version detected', value: row.version },
            { check: 'CVE database match', value: rule.cve },
            { check: 'Source', value: 'local rule + NVD reference' },
          ]),
          rule.potential ? 70 : 90,
          rule.cvss * 10,
          ['CVSS', 'Version match', 'Service exposure'],
          !!rule.potential,
        ]
      );

      if (rule.severity === 'critical' || rule.severity === 'high') {
        await query(
          `INSERT INTO hermes_alerts (id, alert_type, severity, asset_id, title, description, evidence, recommended_action, is_open, created_at)
           VALUES ($1, 'critical_vulnerability', $2, $3, $4, $5, $6, $7, true, NOW())`,
          [
            newId(), rule.severity, row.asset_id,
            `CRITICAL VULNERABILITY: ${rule.cve}`,
            `${rule.product} ${row.version} may be affected by ${rule.cve} (CVSS ${rule.cvss}).`,
            JSON.stringify([{ cve: rule.cve, cvss: rule.cvss, product: row.product, version: row.version }]),
            rule.remediation,
          ]
        );
        await query(
          `INSERT INTO hermes_recommendations (id, finding_id, asset_id, title, description, action_type, action_payload, status, requires_approval, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', true, NOW())`,
          [newId(), findingId, row.asset_id, `Apply security update for ${rule.product}`, rule.remediation, 'install_update', JSON.stringify({ product: rule.product, cve: rule.cve })]
        );
      }
    }
  }

  // Software inventory correlation (endpoint apps)
  const apps = await query(
    `SELECT DISTINCT s.name, s.version, a.id as asset_id, a.device_id
     FROM device_software s
     JOIN hermes_assets a ON a.device_id = s.device_id
     WHERE s.version IS NOT NULL AND s.version <> ''`
  );
  for (const app of apps.rows) {
    for (const rule of LOCAL_CVE_RULES) {
      if (rule.product.toLowerCase() !== String(app.name).toLowerCase()) continue;
      if (rule.matchVersion && !rule.matchVersion(String(app.version))) continue;
      const existing = await query(
        `SELECT id FROM hermes_findings WHERE asset_id = $1 AND cve_id = $2 AND finding_type = 'vulnerability' AND status = 'open'`,
        [app.asset_id, rule.cve]
      );
      if (existing.rows.length > 0) continue;
      await query(
        `INSERT INTO hermes_findings (id, scan_id, asset_id, cve_id, finding_type, severity, title, description, evidence, confidence, risk_score, risk_reasons, is_potential, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'vulnerability', $5, $6, $7, $8, 75, $9, $10, true, 'open', NOW(), NOW())`,
        [
          newId(), scanId, app.asset_id, rule.cve, rule.severity,
          `${rule.cve} — ${app.name} ${app.version} (endpoint application)`,
          rule.description,
          JSON.stringify([{ source: 'endpoint inventory', application: app.name, version: app.version }]),
          rule.cvss * 10,
          ['CVSS', 'Installed application match'],
        ]
      );
    }
  }
}

async function updatePostureScores() {
  const assets = await query('SELECT id FROM hermes_assets');
  for (const asset of assets.rows) {
    const ports = await query(`SELECT COUNT(*) as c FROM hermes_ports WHERE asset_id = $1 AND state = 'open'`, [asset.id]);
    const findings = await query(
      `SELECT severity, COUNT(*) as c FROM hermes_findings WHERE asset_id = $1 AND status = 'open' GROUP BY severity`,
      [asset.id]
    );
    const sev: Record<string, number> = {};
    for (const f of findings.rows) sev[f.severity] = parseInt(f.c, 10);

    const openPorts = parseInt(ports.rows[0]?.c || '0', 10);
    let score = 100;
    score -= (sev.critical || 0) * 25;
    score -= (sev.high || 0) * 15;
    score -= (sev.medium || 0) * 8;
    score -= (sev.low || 0) * 3;
    score -= Math.min(20, Math.max(0, openPorts - 3) * 2);
    score = Math.max(0, Math.min(100, score));

    const factors = {
      open_ports: openPorts,
      critical: sev.critical || 0,
      high: sev.high || 0,
      medium: sev.medium || 0,
      low: sev.low || 0,
    };
    const reasons = [
      `Open ports: ${openPorts}`,
      `Critical findings: ${sev.critical || 0}`,
      `High findings: ${sev.high || 0}`,
      `Medium findings: ${sev.medium || 0}`,
    ];

    await query(
      `INSERT INTO hermes_risk_scores (id, asset_id, score, grade, confidence, factors, reasons, calculated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        newId(), asset.id, score,
        score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : score >= 20 ? 'D' : 'F',
        85, JSON.stringify(factors), reasons,
      ]
    );
    await query(`UPDATE hermes_assets SET posture_score = $1, posture_factors = $2, updated_at = NOW() WHERE id = $3`, [score, JSON.stringify(factors), asset.id]);
  }
}

// ---------- routes ----------

router.get('/status', authenticate, requirePermission('hermes.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const assets = await query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_authorized) as authorized, COUNT(*) FILTER (WHERE NOT is_authorized) as unknown FROM hermes_assets');
    const sev = await query(`SELECT severity, COUNT(*) as c FROM hermes_findings WHERE status = 'open' GROUP BY severity`);
    const scans = await query(`SELECT status, COUNT(*) as c FROM hermes_scans GROUP BY status`);
    const openAlerts = await query(`SELECT COUNT(*) as c FROM hermes_alerts WHERE is_open = true`);
    const pendingRecs = await query(`SELECT COUNT(*) as c FROM hermes_recommendations WHERE status = 'pending'`);
    const activeScans = await query(`SELECT id, scan_type, status, started_at FROM hermes_scans WHERE status IN ('pending','running') ORDER BY created_at DESC LIMIT 5`);
    const topFindings = await query(
      `SELECT f.id, f.title, f.severity, f.confidence, f.risk_score, f.is_potential, f.cve_id, a.hostname, a.ip_address
       FROM hermes_findings f LEFT JOIN hermes_assets a ON f.asset_id = a.id
       WHERE f.status = 'open'
       ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, f.created_at DESC
       LIMIT 10`
    );
    const avgScore = await query(`SELECT COALESCE(ROUND(AVG(posture_score)), 0) as score FROM hermes_assets WHERE is_authorized`);
    const emergency = await isEmergencyStopped();

    const bySev: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const r of sev.rows) bySev[r.severity] = parseInt(r.c, 10);
    const scanStats: Record<string, number> = {};
    for (const r of scans.rows) scanStats[r.status] = parseInt(r.c, 10);

    res.json({
      success: true,
      data: {
        assets: parseInt(assets.rows[0]?.total || '0', 10),
        authorized_assets: parseInt(assets.rows[0]?.authorized || '0', 10),
        unknown_assets: parseInt(assets.rows[0]?.unknown || '0', 10),
        vulnerabilities: (bySev.critical || 0) + (bySev.high || 0) + (bySev.medium || 0) + (bySev.low || 0),
        critical: bySev.critical,
        high: bySev.high,
        medium: bySev.medium,
        low: bySev.low,
        security_score: parseInt(avgScore.rows[0]?.score || '0', 10),
        open_alerts: parseInt(openAlerts.rows[0]?.c || '0', 10),
        pending_recommendations: parseInt(pendingRecs.rows[0]?.c || '0', 10),
        scan_stats: scanStats,
        active_scans: activeScans.rows,
        top_findings: topFindings.rows,
        emergency_stop: emergency,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/scans', authenticate, requirePermission('hermes.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    if (await isEmergencyStopped()) {
      res.status(409).json({ success: false, error: { message: 'Emergency stop is active. Clear it before starting scans.' } });
      return;
    }
    const scanType = (req.body?.scan_type as string) || 'quick';
    const allowed = ['quick', 'daily', 'weekly', 'full', 'custom'];
    if (!allowed.includes(scanType)) {
      res.status(400).json({ success: false, error: { message: 'Invalid scan_type' } });
      return;
    }
    const id = newId();
    const policy = await loadPolicy(scanType);
    await query(
      `INSERT INTO hermes_scans (id, scan_type, policy_id, status, scope, started_by, created_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, NOW())`,
      [id, scanType, policy.id, [], req.user?.id || null]
    );
    await query(
      `INSERT INTO hermes_audit_logs (id, action, actor_id, actor_email, target_type, target_id, details, ip_address)
       VALUES ($1, 'scan_started', $2, $3, 'scan', $4, $5, $6)`,
      [newId(), req.user?.id || null, req.user?.email || null, id, JSON.stringify({ scanType }), req.ip || null]
    );

    // Run async (non-blocking)
    setImmediate(() => {
      runScan(id, scanType, req.user?.id || null).catch((e) => logger.error('HERMES scan runner error', { error: e.message }));
    });

    res.status(201).json({ success: true, data: { id, scan_type: scanType, status: 'pending' } });
  } catch (error) {
    next(error);
  }
});

router.get('/scans', authenticate, requirePermission('hermes.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(`SELECT * FROM hermes_scans ORDER BY created_at DESC LIMIT 50`);
    res.json({ success: true, data: { scans: r.rows } });
  } catch (error) {
    next(error);
  }
});

router.get('/scans/:id', authenticate, requirePermission('hermes.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query('SELECT * FROM hermes_scans WHERE id = $1', [req.params.id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Scan not found' } });
      return;
    }
    res.json({ success: true, data: { scan: r.rows[0] } });
  } catch (error) {
    next(error);
  }
});

router.post('/scans/:id/stop', authenticate, requirePermission('hermes.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(`UPDATE hermes_scans SET status = 'stopped', completed_at = NOW() WHERE id = $1 AND status IN ('pending','running') RETURNING id`, [req.params.id]);
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Scan not running' } });
      return;
    }
    await audit('scan_stopped', req, 'scan', req.params.id);
    res.json({ success: true, data: { message: 'Scan stopped' } });
  } catch (error) {
    next(error);
  }
});

router.post('/emergency-stop', authenticate, requirePermission('hermes.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const enable = req.body?.enable !== false;
    await query(
      `INSERT INTO app_settings (key, value, description, updated_at) VALUES ('hermes_emergency_stop', $1, 'Emergency stop for all HERMES scans', NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [enable ? 'true' : 'false']
    );
    if (enable) {
      await query(`UPDATE hermes_scans SET status = 'stopped', completed_at = NOW() WHERE status IN ('pending','running')`);
    }
    await audit(enable ? 'emergency_stop_enabled' : 'emergency_stop_cleared', req, 'system', 'hermes', { enable });
    res.json({ success: true, data: { emergency_stop: enable } });
  } catch (error) {
    next(error);
  }
});

router.get('/assets', authenticate, requirePermission('hermes.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(
      `SELECT a.*, d.hostname as device_hostname, rs.score as last_score, rs.grade as last_grade
       FROM hermes_assets a
       LEFT JOIN devices d ON a.device_id = d.id
       LEFT JOIN LATERAL (
         SELECT score, grade FROM hermes_risk_scores WHERE asset_id = a.id ORDER BY calculated_at DESC LIMIT 1
       ) rs ON true
       ORDER BY a.is_authorized DESC, a.posture_score ASC NULLS LAST`
    );
    res.json({ success: true, data: { assets: r.rows } });
  } catch (error) {
    next(error);
  }
});

router.get('/assets/:id', authenticate, requirePermission('hermes.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const asset = await query('SELECT * FROM hermes_assets WHERE id = $1', [req.params.id]);
    if (asset.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Asset not found' } });
      return;
    }
    const ports = await query('SELECT * FROM hermes_ports WHERE asset_id = $1 ORDER BY port', [req.params.id]);
    const findings = await query('SELECT * FROM hermes_findings WHERE asset_id = $1 ORDER BY created_at DESC', [req.params.id]);
    const scores = await query('SELECT * FROM hermes_risk_scores WHERE asset_id = $1 ORDER BY calculated_at DESC LIMIT 5', [req.params.id]);
    res.json({ success: true, data: { asset: asset.rows[0], ports: ports.rows, findings: findings.rows, scores: scores.rows } });
  } catch (error) {
    next(error);
  }
});

router.get('/findings', authenticate, requirePermission('hermes.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const severity = req.query.severity as string | undefined;
    const status = (req.query.status as string) || 'open';
    const params: any[] = [];
    let where = `WHERE f.status = $1`;
    params.push(status);
    if (severity) {
      params.push(severity);
      where += ` AND f.severity = $${params.length}`;
    }
    const r = await query(
      `SELECT f.*, a.hostname, a.ip_address FROM hermes_findings f
       LEFT JOIN hermes_assets a ON f.asset_id = a.id
       ${where}
       ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END, f.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({ success: true, data: { findings: r.rows } });
  } catch (error) {
    next(error);
  }
});

router.get('/vulnerabilities', authenticate, requirePermission('hermes.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(
      `SELECT f.*, a.hostname, a.ip_address FROM hermes_findings f
       LEFT JOIN hermes_assets a ON f.asset_id = a.id
       WHERE f.finding_type = 'vulnerability' AND f.status = 'open'
       ORDER BY f.risk_score DESC LIMIT 200`
    );
    const cves = await query(`SELECT * FROM hermes_cves ORDER BY cvss_score DESC NULLS LAST LIMIT 100`);
    res.json({ success: true, data: { vulnerabilities: r.rows, cve_catalog: cves.rows } });
  } catch (error) {
    next(error);
  }
});

router.get('/alerts', authenticate, requirePermission('hermes.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(
      `SELECT h.*, a.hostname, a.ip_address FROM hermes_alerts h
       LEFT JOIN hermes_assets a ON h.asset_id = a.id
       WHERE h.is_open = true ORDER BY h.created_at DESC LIMIT 100`
    );
    res.json({ success: true, data: { alerts: r.rows } });
  } catch (error) {
    next(error);
  }
});

router.get('/recommendations', authenticate, requirePermission('hermes.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(
      `SELECT rec.*, a.hostname, a.ip_address FROM hermes_recommendations rec
       LEFT JOIN hermes_assets a ON rec.asset_id = a.id
       ORDER BY rec.created_at DESC LIMIT 100`
    );
    res.json({ success: true, data: { recommendations: r.rows } });
  } catch (error) {
    next(error);
  }
});

router.post('/recommendations/:id/approve', authenticate, requirePermission('hermes.approve'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(
      `UPDATE hermes_recommendations SET status = 'approved', decided_by = $1, decided_at = NOW(), decision_reason = $2 WHERE id = $3 AND status = 'pending' RETURNING id`,
      [req.user?.id || null, req.body?.reason || 'Approved by administrator', req.params.id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Recommendation not pending' } });
      return;
    }
    await audit('recommendation_approved', req, 'recommendation', req.params.id, { reason: req.body?.reason });
    res.json({ success: true, data: { message: 'Recommendation approved' } });
  } catch (error) {
    next(error);
  }
});

router.post('/recommendations/:id/reject', authenticate, requirePermission('hermes.approve'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(
      `UPDATE hermes_recommendations SET status = 'rejected', decided_by = $1, decided_at = NOW(), decision_reason = $2 WHERE id = $3 AND status = 'pending' RETURNING id`,
      [req.user?.id || null, req.body?.reason || 'Rejected by administrator', req.params.id]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Recommendation not pending' } });
      return;
    }
    await audit('recommendation_rejected', req, 'recommendation', req.params.id, { reason: req.body?.reason });
    res.json({ success: true, data: { message: 'Recommendation rejected' } });
  } catch (error) {
    next(error);
  }
});

router.post('/findings/:id/exception', authenticate, requirePermission('hermes.approve'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { exception_type = 'false_positive', reason = '' } = req.body || {};
    const allowedTypes = ['confirm_finding', 'false_positive', 'accept_risk', 'ignore_until', 'create_exception'];
    if (!allowedTypes.includes(exception_type)) {
      res.status(400).json({ success: false, error: { message: 'Invalid exception_type' } });
      return;
    }
    if (!reason) {
      res.status(400).json({ success: false, error: { message: 'reason is required' } });
      return;
    }
    const finding = await query('SELECT id FROM hermes_findings WHERE id = $1', [req.params.id]);
    if (finding.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Finding not found' } });
      return;
    }
    await query(
      `INSERT INTO hermes_exceptions (id, finding_id, exception_type, reason, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
      [newId(), req.params.id, exception_type, reason, req.user?.id || null, req.body?.expires_at || null]
    );
    if (exception_type === 'false_positive' || exception_type === 'accept_risk' || exception_type === 'ignore_until') {
      await query(
        `UPDATE hermes_findings SET status = $1, acknowledged_by = $2, acknowledged_at = NOW(), acknowledged_reason = $3, updated_at = NOW() WHERE id = $4`,
        [exception_type === 'ignore_until' ? 'open' : 'acknowledged', req.user?.id || null, reason, req.params.id]
      );
    }
    await audit('finding_exception_' + exception_type, req, 'finding', req.params.id, { reason });
    res.json({ success: true, data: { message: 'Finding updated', exception_type } });
  } catch (error) {
    next(error);
  }
});

router.get('/risk', authenticate, requirePermission('hermes.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const scores = await query(
      `SELECT a.id, a.hostname, a.ip_address, a.is_authorized, a.posture_score, a.posture_factors, a.internet_exposed,
              rs.score, rs.grade, rs.confidence, rs.factors, rs.reasons, rs.calculated_at
       FROM hermes_assets a
       LEFT JOIN LATERAL (
         SELECT score, grade, confidence, factors, reasons, calculated_at
         FROM hermes_risk_scores WHERE asset_id = a.id ORDER BY calculated_at DESC LIMIT 1
       ) rs ON true
       WHERE a.is_authorized = true
       ORDER BY a.posture_score ASC NULLS LAST`
    );
    res.json({ success: true, data: { risk: scores.rows } });
  } catch (error) {
    next(error);
  }
});

router.get('/attack-surface', authenticate, requirePermission('hermes.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const assets = await query(`SELECT COUNT(*) as c FROM hermes_assets`);
    const exposed = await query(`SELECT COUNT(*) as c FROM hermes_assets WHERE internet_exposed = true`);
    const openPorts = await query(`SELECT COUNT(DISTINCT port) as c FROM hermes_ports WHERE state = 'open'`);
    const risky = await query(`SELECT COUNT(*) as c FROM hermes_ports WHERE state = 'open' AND risk IN ('high','critical')`);
    const outdated = await query(
      `SELECT COUNT(DISTINCT product) as c FROM hermes_ports WHERE product IS NOT NULL AND version IS NOT NULL`
    );
    const criticalV = await query(`SELECT COUNT(*) as c FROM hermes_findings WHERE status = 'open' AND severity = 'critical'`);
    const unknown = await query(`SELECT COUNT(*) as c FROM hermes_assets WHERE is_authorized = false`);
    const externalServices = await query(
      `SELECT COUNT(*) as c FROM hermes_ports WHERE state = 'open' AND port IN (21,23,3389,5900,1433,3306,5432)`
    );
    res.json({
      success: true,
      data: {
        total_assets: parseInt(assets.rows[0]?.c || '0', 10),
        internet_exposed: parseInt(exposed.rows[0]?.c || '0', 10),
        open_ports: parseInt(openPorts.rows[0]?.c || '0', 10),
        high_risk_services: parseInt(risky.rows[0]?.c || '0', 10),
        outdated_applications: parseInt(outdated.rows[0]?.c || '0', 10),
        critical_vulnerabilities: parseInt(criticalV.rows[0]?.c || '0', 10),
        unknown_devices: parseInt(unknown.rows[0]?.c || '0', 10),
        external_services: parseInt(externalServices.rows[0]?.c || '0', 10),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/reports', authenticate, requirePermission('hermes.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const assets = await query(`SELECT * FROM hermes_assets WHERE is_authorized = true ORDER BY hostname`);
    const findings = await query(
      `SELECT f.*, a.hostname, a.ip_address FROM hermes_findings f LEFT JOIN hermes_assets a ON f.asset_id = a.id WHERE f.status = 'open' ORDER BY f.risk_score DESC`
    );
    const ports = await query(
      `SELECT p.*, a.hostname, a.ip_address FROM hermes_ports p LEFT JOIN hermes_assets a ON p.asset_id = a.id WHERE p.state = 'open' ORDER BY a.hostname, p.port`
    );
    const auditLog = await query(`SELECT * FROM hermes_audit_logs ORDER BY created_at DESC LIMIT 100`);
    const bySev = await query(`SELECT severity, COUNT(*) as c FROM hermes_findings WHERE status = 'open' GROUP BY severity`);
    const sevMap: Record<string, number> = {};
    for (const r of bySev.rows) sevMap[r.severity] = parseInt(r.c, 10);

    const report = {
      title: 'HERMES SECURITY ASSESSMENT',
      organisation: 'EndpointX',
      assessment_date: new Date().toISOString(),
      scope: 'Authorized NetSentinel devices and configured CIDR ranges',
      executive_summary: {
        total_assets: assets.rows.length,
        open_findings: findings.rows.length,
        open_ports: ports.rows.length,
        critical: sevMap.critical || 0,
        high: sevMap.high || 0,
        medium: sevMap.medium || 0,
        low: sevMap.low || 0,
      },
      assets: assets.rows,
      open_ports: ports.rows,
      findings: findings.rows,
      audit_trail: auditLog.rows,
      generated_at: new Date().toISOString(),
    };
    res.json({ success: true, data: { report } });
  } catch (error) {
    next(error);
  }
});

router.get('/audit', authenticate, requirePermission('hermes.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(`SELECT * FROM hermes_audit_logs ORDER BY created_at DESC LIMIT 200`);
    res.json({ success: true, data: { logs: r.rows } });
  } catch (error) {
    next(error);
  }
});

router.get('/policies', authenticate, requirePermission('hermes.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const r = await query(`SELECT * FROM hermes_scan_policies ORDER BY name`);
    const cidrs = await getSetting('hermes_allowed_cidrs', '');
    res.json({ success: true, data: { policies: r.rows, allowed_cidrs: cidrs } });
  } catch (error) {
    next(error);
  }
});

// ---------- AI (opencode) ----------

router.get('/ai/status', authenticate, requirePermission('hermes.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const health = await aiHealth();
    res.json({
      success: true,
      data: {
        configured: isOpencodeConfigured(),
        provider: health.provider,
        model: health.model,
        freeModels: freeModelsForProvider(health.provider),
        healthy: health.ok,
        version: health.version || null,
        error: health.error || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/ai/analyze', authenticate, requirePermission('hermes.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const locale = (req.body?.locale as string) || 'pt';
    const assets = await query('SELECT COUNT(*) as total FROM hermes_assets');
    const avgScore = await query(`SELECT COALESCE(ROUND(AVG(posture_score)), 0) as score FROM hermes_assets WHERE is_authorized`);
    const scans = await query(`SELECT status, COUNT(*) as c FROM hermes_scans GROUP BY status`);
    const topFindings = await query(
      `SELECT f.title, f.severity, f.description, f.cve_id, a.hostname
       FROM hermes_findings f LEFT JOIN hermes_assets a ON f.asset_id = a.id
       WHERE f.status = 'open'
       ORDER BY CASE f.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END
       LIMIT 25`
    );

    const scanStats: Record<string, number> = {};
    for (const r of scans.rows) scanStats[r.status] = parseInt(r.c, 10);

    const context = {
      assets: parseInt(assets.rows[0]?.total || '0', 10),
      postureScore: parseInt(avgScore.rows[0]?.score || '0', 10),
      scanStats,
      openFindings: topFindings.rows,
      locale,
    };

    if (isOpencodeConfigured()) {
      try {
        const result = await analyzeSecurityContext(context);
        res.json({
          success: true,
          data: {
            analysis: result.analysis,
            mode: result.provider,
            provider: result.provider,
            model: result.model,
          },
        });
        return;
      } catch (aiError) {
        logger.warn('HERMES AI analyze fell back to local briefing', { error: (aiError as Error).message });
      }
    }

    res.json({
      success: true,
      data: { analysis: localAnalyzeSecurityContext(context), mode: 'local', provider: null, model: null },
    });
  } catch (error) {
    logger.error('HERMES AI analyze failed', { error: (error as Error).message });
    next(error);
  }
});

router.post('/ai/recommend', authenticate, requirePermission('hermes.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const findingId = req.body?.finding_id as string | undefined;
    const locale = (req.body?.locale as string) || 'pt';
    if (!findingId) {
      res.status(400).json({ success: false, error: { message: 'finding_id é obrigatório' } });
      return;
    }

    const r = await query(
      `SELECT f.title, f.severity, f.description, f.cve_id, a.hostname
       FROM hermes_findings f LEFT JOIN hermes_assets a ON f.asset_id = a.id
       WHERE f.id = $1`,
      [findingId]
    );
    if (r.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Finding não encontrado' } });
      return;
    }

    if (isOpencodeConfigured()) {
      try {
        const result = await recommendForFinding(r.rows[0], locale);
        res.json({
          success: true,
          data: {
            recommendation: result.recommendation,
            mode: result.provider,
            provider: result.provider,
            model: result.model,
          },
        });
        return;
      } catch (aiError) {
        logger.warn('HERMES AI recommend fell back to local briefing', { error: (aiError as Error).message });
      }
    }

    res.json({
      success: true,
      data: {
        recommendation: localRecommendForFinding(r.rows[0], locale),
        mode: 'local',
        provider: null,
        model: null,
      },
    });
  } catch (error) {
    logger.error('HERMES AI recommend failed', { error: (error as Error).message });
    next(error);
  }
});

export default router;
export { runScan, parsePortList, detectService, portRisk };

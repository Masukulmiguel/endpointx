import jwt from 'jsonwebtoken';
import { query } from '../config/database';
import { JWT } from '../config/constants';
import { canViewUnownedDevices } from '../utils/tenant';
import { discoverUnknownAsset } from '../routes/hermes';

function newId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export interface DiscoveryHost {
  ip: string;
  mac: string | null;
  hostname: string | null;
  os_estimate: string;
  rtt_ms: number | null;
}

export interface DiscoveryReport {
  subnets: string[];
  truncated: boolean;
  hosts: DiscoveryHost[];
}

type ServiceUser = { id: string; permissions: string[] };

export interface IngestStats {
  hosts_alive: number;
  new_nodes: number;
  updated_nodes: number;
  linked_devices: number;
  truncated: boolean;
}

const ZERO_STATS = (): IngestStats => ({
  hosts_alive: 0,
  new_nodes: 0,
  updated_nodes: 0,
  linked_devices: 0,
  truncated: false,
});

// The run is created with id = commandId (decision: run id == command id),
// so finalizing needs no join to agent_commands.
async function finalizeRun(
  commandId: string,
  status: 'completed' | 'failed',
  stats: IngestStats,
  errorMessage: string | null
): Promise<void> {
  await query(
    `UPDATE network_discovery_runs
        SET status = $2, stats = $3, error_message = $4, completed_at = NOW()
      WHERE id = $1`,
    [commandId, status, JSON.stringify(stats), errorMessage]
  );
}

async function ingestHost(
  host: DiscoveryHost,
  createdBy: string | null,
  stats: IngestStats
): Promise<void> {
  let deviceId: string | null = null;
  if (host.mac) {
    const dev = await query(
      'SELECT id FROM devices WHERE LOWER(mac_address) = LOWER($1)',
      [host.mac]
    );
    deviceId = dev.rows[0]?.id ?? null;
    if (deviceId) stats.linked_devices++;
  }

  const existing = host.mac
    ? await query(
        'SELECT id FROM network_nodes WHERE ip_address = $1 AND mac_address IS NOT NULL AND LOWER(mac_address) = LOWER($2)',
        [host.ip, host.mac]
      )
    : await query('SELECT id FROM network_nodes WHERE ip_address = $1 AND mac_address IS NULL', [host.ip]);

  const metadata = JSON.stringify({ os_estimate: host.os_estimate, rtt_ms: host.rtt_ms });

  if (existing.rows.length > 0) {
    const nodeId = existing.rows[0].id as string;
    // Preserve first_seen, admin name and node_type once set.
    await query(
      `UPDATE network_nodes
          SET last_seen = NOW(),
              hostname = COALESCE($2, hostname),
              device_id = COALESCE($3, device_id),
              metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE($4::jsonb, '{}'::jsonb),
              updated_at = NOW()
        WHERE id = $1`,
      [nodeId, host.hostname, deviceId, metadata]
    );
    stats.updated_nodes++;
    return;
  }

  const nodeId = newId();
  await query(
    `INSERT INTO network_nodes
      (id, node_type, hostname, ip_address, mac_address, vendor, metadata, source, device_id, created_by, first_seen, last_seen, updated_at)
     VALUES ($1, 'UNKNOWN', $2, $3, $4, NULL, $5, 'network_discovery', $6, $7, NOW(), NOW(), NOW())`,
    [nodeId, host.hostname, host.ip, host.mac, metadata, deviceId, createdBy]
  );
  stats.new_nodes++;

  if (!deviceId) {
    await discoverUnknownAsset(host.ip);
    await query(
      `INSERT INTO hermes_recommendations
        (id, asset_id, title, description, action_type, action_payload, status, requires_approval, created_at)
       VALUES ($1, NULL, $2, $3, 'identify_device', $4, 'pending', false, NOW())`,
      [
        newId(),
        `Identify device ${host.ip}`,
        `Network discovery found ${host.ip}${host.mac ? ` (${host.mac})` : ''} with no matching agent.`,
        JSON.stringify({ node_id: nodeId, ip: host.ip, mac: host.mac }),
      ]
    );
  }
}

export async function ingestReport(opts: {
  commandId: string;
  deviceId: string;
  status: 'completed' | 'failed';
  report: unknown;
  issuedBy: string | null;
}): Promise<IngestStats> {
  const { commandId, deviceId, status, report } = opts;
  try {
    if (status === 'failed') {
      const msg = report instanceof Error ? report.message : typeof report === 'string' ? report : 'agent reported failure';
      const stats = ZERO_STATS();
      await finalizeRun(commandId, 'failed', stats, msg);
      return stats;
    }
    if (
      typeof report !== 'object' ||
      report === null ||
      !Array.isArray((report as DiscoveryReport).hosts)
    ) {
      const stats = ZERO_STATS();
      await finalizeRun(commandId, 'failed', stats, 'malformed discovery report');
      return stats;
    }
    const r = report as DiscoveryReport;
    const stats: IngestStats = {
      hosts_alive: r.hosts.length,
      new_nodes: 0,
      updated_nodes: 0,
      linked_devices: 0,
      truncated: !!r.truncated,
    };

    const runner = await query('SELECT id, created_by FROM devices WHERE id = $1', [deviceId]);
    const createdBy = (runner.rows[0]?.created_by as string | null) ?? null;

    let hostFailures = 0;
    for (const host of r.hosts) {
      try {
        await ingestHost(host, createdBy, stats);
      } catch {
        hostFailures++;
      }
    }
    await finalizeRun(
      commandId,
      'completed',
      stats,
      hostFailures > 0 ? `${hostFailures} host(s) failed to ingest` : null
    );
    return stats;
  } catch (error) {
    const stats = ZERO_STATS();
    try {
      await finalizeRun(commandId, 'failed', stats, (error as Error).message);
    } catch {
      // ingestReport never throws
    }
    return stats;
  }
}

function nodeVisibilitySql(user: ServiceUser): { sql: string; params: unknown[] } {
  if (canViewUnownedDevices(user)) return { sql: '', params: [] };
  return {
    sql: ` (n.created_by = $1 OR EXISTS(SELECT 1 FROM devices d WHERE d.id = n.device_id AND d.created_by = $1))`,
    params: [user.id],
  };
}

export async function listNodes(opts: {
  page: number;
  limit: number;
  search?: string;
  review_status?: string;
  user: ServiceUser;
}): Promise<{
  nodes: Record<string, unknown>[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const { page, limit, search, review_status, user } = opts;
  const vis = nodeVisibilitySql(user);
  const conditions: string[] = vis.sql ? [vis.sql] : [];
  const params: unknown[] = [...vis.params];
  if (search) {
    params.push(`%${search}%`);
    const p = params.length;
    conditions.push(` (n.hostname ILIKE $${p} OR n.ip_address::text ILIKE $${p} OR n.mac_address ILIKE $${p})`);
  }
  if (review_status) {
    params.push(review_status);
    const p = params.length;
    conditions.push(` n.review_status = $${p}`);
  }
  const where = conditions.length ? ` WHERE${conditions.join(' AND')}` : '';

  const countResult = await query(`SELECT COUNT(*) AS total FROM network_nodes n${where}`, params);
  const total = parseInt(String(countResult.rows[0]?.total ?? '0'), 10) || 0;

  params.push(limit, (page - 1) * limit);
  const lp = params.length - 1;
  const listResult = await query(
    `SELECT n.* FROM network_nodes n${where} ORDER BY n.last_seen DESC LIMIT $${lp} OFFSET $${lp + 1}`,
    params
  );

  return {
    nodes: listResult.rows,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function getNode(
  id: string,
  user: ServiceUser
): Promise<Record<string, unknown> | null> {
  const vis = nodeVisibilitySql(user);
  const where = vis.sql ? ` WHERE n.id = $${vis.params.length + 1} AND${vis.sql}` : ' WHERE n.id = $1';
  const params = vis.sql ? [...vis.params, id] : [id];
  const r = await query(`SELECT n.* FROM network_nodes n${where}`, params);
  return r.rows[0] ?? null;
}

export async function setNodeReview(
  id: string,
  review: 'known' | 'ignored',
  user: ServiceUser
): Promise<boolean> {
  const vis = nodeVisibilitySql(user);
  const r = vis.sql
    ? await query(
        `UPDATE network_nodes SET review_status = $3, updated_at = NOW()
          WHERE id = $1 AND (created_by = $2 OR EXISTS(SELECT 1 FROM devices d WHERE d.id = network_nodes.device_id AND d.created_by = $2))`,
        [id, user.id, review]
      )
    : await query(
        `UPDATE network_nodes SET review_status = $2, updated_at = NOW() WHERE id = $1`,
        [id, review]
      );
  if ((r.rowCount ?? 0) === 0) return false;
  await query(
    `INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address, metadata)
     VALUES ($1, $2, NULL, $3, 'network_node', $4, $5, NULL, $6)`,
    [newId(), user.id, 'network_node_review', id, `review_status=${review}`, JSON.stringify({ review_status: review })]
  );
  return true;
}

export async function identifyNode(
  id: string,
  body: { name?: string; node_type?: string },
  user: ServiceUser
): Promise<boolean> {
  const sets: string[] = [];
  if (body.name !== undefined) sets.push('name');
  if (body.node_type !== undefined) sets.push('node_type');
  if (sets.length === 0) return false;

  const vis = nodeVisibilitySql(user);
  const values: unknown[] = [];
  const setSql = sets.map((col) => {
    values.push((body as Record<string, unknown>)[col]);
    return ` ${col} = $${values.length + 1}`;
  });
  values.push(id);
  const idPh = values.length;
  let where = ` WHERE id = $${idPh}`;
  if (vis.sql) {
    values.push(user.id);
    const userPh = values.length;
    where = ` WHERE id = $${idPh} AND (created_by = $${userPh} OR EXISTS(SELECT 1 FROM devices d WHERE d.id = network_nodes.device_id AND d.created_by = $${userPh}))`;
  }
  const r = await query(
    `UPDATE network_nodes SET${setSql.join(',')}, updated_at = NOW()${where}`,
    values
  );
  if ((r.rowCount ?? 0) === 0) return false;
  await query(
    `INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address, metadata)
     VALUES ($1, $2, NULL, $3, 'network_node', $4, $5, NULL, $6)`,
    [newId(), user.id, 'network_node_identify', id, `identify ${JSON.stringify(body)}`, JSON.stringify(body)]
  );
  return true;
}

export async function requestEnrollment(
  id: string,
  user: { id: string; email: string; permissions: string[] }
): Promise<{ token: string; commands: { windows: string; linux: string; macos: string } } | null> {
  const node = await getNode(id, { id: user.id, permissions: user.permissions });
  if (!node) return null;

  const token = jwt.sign({ sub: user.id, typ: 'enroll' }, JWT.ACCESS_SECRET, { expiresIn: '30d' });
  await query(
    `UPDATE network_nodes
        SET review_status = 'enrollment_requested', enrollment_requested_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [id]
  );

  const API = `https://${process.env.API_HOST || 'endpointx.onrender.com'}`;
  return {
    token,
    commands: {
      windows: `irm ${API}/api/devices/public/install.ps1?t=${token} | iex`,
      linux: `curl -fsSL ${API}/api/devices/public/install-linux.sh?t=${token} | sudo bash`,
      macos: `curl -fsSL ${API}/api/devices/public/install-macos.sh?t=${token} | bash`,
    },
  };
}

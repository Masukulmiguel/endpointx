import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from '../config/database';
import { JWT } from '../config/constants';
import { canViewUnownedDevices } from '../utils/tenant';

export const REQUEST_TTL_DAYS = 7;

export type InstallRequestStatus =
  | 'pending'
  | 'delivered'
  | 'authorized'
  | 'refused'
  | 'installing'
  | 'installed'
  | 'integrated'
  | 'expired'
  | 'cancelled'
  | 'error';

export const ACTIVE_STATUSES: InstallRequestStatus[] = [
  'pending',
  'delivered',
  'authorized',
  'installing',
];

const CANCELLABLE_STATUSES: InstallRequestStatus[] = ['pending', 'delivered', 'authorized'];

interface ServiceUser {
  id: string;
  permissions: string[];
}

export interface InstallRequestRow {
  id: string;
  node_id: string;
  device_id: string | null;
  requested_by: string | null;
  status: InstallRequestStatus;
  invite_token: string;
  install_jti: string | null;
  os_hint: string | null;
  decision: string | null;
  decision_channel: string | null;
  delivered_at: string | null;
  decided_at: string | null;
  installing_at: string | null;
  installed_at: string | null;
  integrated_at: string | null;
  expires_at: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  node_ip?: string | null;
  node_mac?: string | null;
  node_hostname?: string | null;
  device_name?: string | null;
}

function newId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function apiOrigin(): string {
  const host = (process.env.API_HOST || 'endpointx.onrender.com')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  return `https://${host}`;
}

export function buildInviteUrl(inviteToken: string): string {
  return `${apiOrigin()}/api/enroll/invite/${inviteToken}`;
}

export function buildInstallToken(
  user: { id: string },
  row: Pick<InstallRequestRow, 'install_jti' | 'node_mac' | 'node_ip'>
): string {
  return jwt.sign(
    {
      sub: user.id,
      typ: 'install',
      jti: row.install_jti,
      mac: row.node_mac ?? null,
      ip: row.node_ip ?? null,
    },
    JWT.ACCESS_SECRET,
    { expiresIn: `${REQUEST_TTL_DAYS}d` }
  );
}

export function buildInstallCommands(
  user: { id: string },
  row: Pick<InstallRequestRow, 'install_jti' | 'node_mac' | 'node_ip'>
): { windows: string; linux: string; macos: string } {
  const token = buildInstallToken(user, row);
  const API = apiOrigin();
  return {
    windows: `irm ${API}/api/devices/public/install.ps1?t=${token} | iex`,
    linux: `curl -fsSL ${API}/api/devices/public/install-linux.sh?t=${token} | sudo bash`,
    macos: `curl -fsSL ${API}/api/devices/public/install-macos.sh?t=${token} | bash`,
  };
}

async function audit(
  action: string,
  targetType: string,
  targetId: string,
  description: string,
  userId: string | null,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address, metadata)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, NULL, $7)`,
      [newId(), userId, action, targetType, targetId, description, JSON.stringify(metadata)]
    );
  } catch {
    // audit must never break the flow
  }
}

// Revert the node's review_status when its enrollment request dies
// (refused/expired/cancelled). The guard ensures admin-set states
// (known/ignored) are never clobbered.
async function revertNodeEnrollment(nodeId: string): Promise<void> {
  await query(
    `UPDATE network_nodes
        SET review_status = 'new', updated_at = NOW()
      WHERE id = $1 AND review_status = 'enrollment_requested'`,
    [nodeId]
  );
}

// Mark the node known once the device confirms its first authenticated
// heartbeat (integrated). Guarded the same way as revertNodeEnrollment.
async function markNodeEnrolled(deviceId: string): Promise<void> {
  await query(
    `UPDATE network_nodes
        SET review_status = 'known', updated_at = NOW()
      WHERE device_id = $1 AND review_status = 'enrollment_requested'`,
    [deviceId]
  );
}

const SELECT_REQUEST = `
  SELECT r.*,
         n.ip_address AS node_ip, n.mac_address AS node_mac, n.hostname AS node_hostname,
         d.display_name AS device_name
    FROM installation_requests r
    JOIN network_nodes n ON n.id = r.node_id
    LEFT JOIN devices d ON d.id = r.device_id`;

export interface CreateResult {
  node_id: string;
  ok: boolean;
  reason?: string;
  request?: InstallRequestRow;
}

export async function createInstallRequests(
  nodeIds: string[],
  user: ServiceUser
): Promise<CreateResult[]> {
  const results: CreateResult[] = [];
  for (const nodeId of nodeIds) {
    const node = await query(
      `SELECT id, device_id, mac_address, ip_address, hostname, metadata, created_by
         FROM network_nodes WHERE id = $1`,
      [nodeId]
    );
    const row = node.rows[0];
    if (!row) {
      results.push({ node_id: nodeId, ok: false, reason: 'node_not_found' });
      continue;
    }
    // Tenant isolation: a caller without devices.view_all may only enroll nodes
    // it owns. Another tenant's node is indistinguishable from a missing one.
    if (!canViewUnownedDevices(user) && row.created_by !== user.id) {
      results.push({ node_id: nodeId, ok: false, reason: 'node_not_found' });
      continue;
    }
    if (row.device_id) {
      results.push({ node_id: nodeId, ok: false, reason: 'already_enrolled' });
      continue;
    }
    const active = await query(
      `SELECT id FROM installation_requests
        WHERE node_id = $1 AND status IN ('pending','delivered','authorized','installing')`,
      [nodeId]
    );
    if ((active.rowCount ?? 0) > 0) {
      results.push({ node_id: nodeId, ok: false, reason: 'active_request_exists' });
      continue;
    }

    const id = newId();
    const inviteToken = randomToken();
    const installJti = randomToken();
    const osHint = row.metadata?.os_estimate ?? null;
    const inserted = await query(
      `INSERT INTO installation_requests
         (id, node_id, requested_by, status, invite_token, install_jti, os_hint, expires_at)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, NOW() + make_interval(days => $7))
       RETURNING *`,
      [id, nodeId, user.id, inviteToken, installJti, osHint, REQUEST_TTL_DAYS]
    );
    const created = inserted.rows[0] as InstallRequestRow;
    await query(
      `UPDATE network_nodes
          SET review_status = 'enrollment_requested', enrollment_requested_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [nodeId]
    );
    await audit(
      'install_request_created',
      'installation_request',
      id,
      `Installation agent request created for node ${nodeId}`,
      user.id,
      { node_id: nodeId, ip: row.ip_address, mac: row.mac_address, os_hint: osHint }
    );
    created.node_ip = row.ip_address;
    created.node_mac = row.mac_address;
    created.node_hostname = row.hostname;
    results.push({ node_id: nodeId, ok: true, request: created });
  }
  return results;
}

export async function listInstallRequests(
  user: ServiceUser,
  filters: { status?: string; node_id?: string; limit?: number } = {}
): Promise<InstallRequestRow[]> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const values: unknown[] = [];
  const where: string[] = [];
  if (user.permissions.includes('devices.view_all')) {
    // all requests visible
  } else {
    values.push(user.id);
    where.push(`(r.requested_by = $${values.length} OR n.created_by = $${values.length}
       OR EXISTS(SELECT 1 FROM devices d WHERE d.id = r.device_id AND d.created_by = $${values.length}))`);
  }
  if (filters.status) {
    values.push(filters.status);
    where.push(`r.status = $${values.length}`);
  }
  if (filters.node_id) {
    values.push(filters.node_id);
    where.push(`r.node_id = $${values.length}`);
  }
  values.push(limit);
  const sql = `${SELECT_REQUEST}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.created_at DESC
    LIMIT $${values.length}`;
  const r = await query(sql, values);
  return r.rows as InstallRequestRow[];
}

export async function getInstallRequest(
  id: string,
  user: ServiceUser
): Promise<InstallRequestRow | null> {
  const requests = await listInstallRequests(user, { limit: 500 });
  return requests.find((row) => row.id === id) ?? null;
}

export async function cancelInstallRequest(
  id: string,
  user: ServiceUser
): Promise<{ ok: boolean; reason?: string; request?: InstallRequestRow }> {
  const r = await query(
    `UPDATE installation_requests
        SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1 AND status = ANY($2)
      RETURNING *`,
    [id, CANCELLABLE_STATUSES]
  );
  if ((r.rowCount ?? 0) === 0) {
    const existing = await query(`SELECT status FROM installation_requests WHERE id = $1`, [id]);
    return { ok: false, reason: existing.rows[0] ? 'not_cancellable' : 'not_found' };
  }
  await revertNodeEnrollment((r.rows[0] as InstallRequestRow).node_id);
  await audit(
    'install_request_cancelled',
    'installation_request',
    id,
    'Installation request cancelled by administrator',
    user.id
  );
  return { ok: true, request: r.rows[0] as InstallRequestRow };
}

export async function retryInstallRequest(
  id: string,
  user: ServiceUser
): Promise<{ ok: boolean; reason?: string; request?: InstallRequestRow }> {
  const fresh: Partial<InstallRequestRow> = {
    invite_token: randomToken(),
    install_jti: randomToken(),
  };
  const r = await query(
    `UPDATE installation_requests
        SET status = 'pending',
            invite_token = $2,
            install_jti = $3,
            decision = NULL,
            decision_channel = NULL,
            delivered_at = NULL,
            decided_at = NULL,
            installing_at = NULL,
            installed_at = NULL,
            integrated_at = NULL,
            error_message = NULL,
            expires_at = NOW() + make_interval(days => $4),
            updated_at = NOW()
      WHERE id = $1 AND status IN ('expired','cancelled','refused','error')
      RETURNING *`,
    [id, fresh.invite_token, fresh.install_jti, REQUEST_TTL_DAYS]
  );
  if ((r.rowCount ?? 0) === 0) {
    const existing = await query(`SELECT status FROM installation_requests WHERE id = $1`, [id]);
    return { ok: false, reason: existing.rows[0] ? 'not_retryable' : 'not_found' };
  }
  await audit(
    'install_request_retried',
    'installation_request',
    id,
    'Installation request re-issued',
    user.id
  );
  return { ok: true, request: r.rows[0] as InstallRequestRow };
}

export async function expireStaleRequests(): Promise<number> {
  const stale = await query(
    `UPDATE installation_requests
        SET status = 'expired', updated_at = NOW()
      WHERE status IN ('pending','delivered') AND expires_at < NOW()
      RETURNING id, node_id`
  );
  for (const row of stale.rows) {
    if (row.node_id) await revertNodeEnrollment(row.node_id as string);
    await audit(
      'install_request_expired',
      'installation_request',
      row.id,
      'Installation request expired without a decision',
      null
    );
  }
  return stale.rowCount ?? 0;
}

export async function getInviteByToken(
  token: string
): Promise<InstallRequestRow | null> {
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;
  const r = await query(`${SELECT_REQUEST} WHERE r.invite_token = $1`, [token]);
  return (r.rows[0] as InstallRequestRow) ?? null;
}

export async function markDelivered(id: string): Promise<void> {
  const r = await query(
    `UPDATE installation_requests
        SET status = CASE WHEN status = 'pending' THEN 'delivered' ELSE status END,
            delivered_at = COALESCE(delivered_at, NOW()),
            updated_at = NOW()
      WHERE id = $1 AND status IN ('pending','delivered')
      RETURNING id`,
    [id]
  );
  if ((r.rowCount ?? 0) > 0) {
    await audit(
      'install_request_delivered',
      'installation_request',
      id,
      'Installation request opened on the target device',
      null
    );
  }
}

export async function recordDecision(
  token: string,
  decision: 'authorize' | 'refuse',
  channel: 'web' | 'device'
): Promise<{ ok: boolean; reason?: string; request?: InstallRequestRow }> {
  const looked = await getInviteByToken(token);
  const row = looked;
  if (!row) return { ok: false, reason: 'not_found' };

  if (decision === 'authorize' && row.status === 'authorized') {
    return { ok: true, request: row };
  }
  if (decision === 'refuse' && row.status === 'refused') {
    return { ok: true, request: row };
  }
  const undecided = row.status === 'pending' || row.status === 'delivered';
  if (!undecided) return { ok: false, reason: 'invalid_state' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };

  const status = decision === 'authorize' ? 'authorized' : 'refused';
  const updated = await query(
    `UPDATE installation_requests
        SET status = $2, decision = $2, decision_channel = $3, decided_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status IN ('pending','delivered')
      RETURNING *`,
    [row.id, status, channel]
  );
  if ((updated.rowCount ?? 0) === 0) return { ok: false, reason: 'invalid_state' };
  if (decision === 'refuse') {
    await revertNodeEnrollment(row.node_id);
  }
  await audit(
    decision === 'authorize' ? 'install_request_authorized' : 'install_request_refused',
    'installation_request',
    row.id,
    decision === 'authorize'
      ? `Agent installation authorized (${channel})`
      : `Agent installation refused (${channel})`,
    null,
    { channel }
  );
  return { ok: true, request: updated.rows[0] as InstallRequestRow };
}

export async function getRequestByInstallJti(
  jti: string
): Promise<InstallRequestRow | null> {
  if (!/^[a-f0-9]{64}$/i.test(jti || '')) return null;
  const r = await query(`${SELECT_REQUEST} WHERE r.install_jti = $1`, [jti]);
  return (r.rows[0] as InstallRequestRow) ?? null;
}

export async function markInstalling(
  id: string
): Promise<{ ok: boolean; reason?: string; request?: InstallRequestRow }> {
  const r = await query(
    `UPDATE installation_requests
        SET status = 'installing', installing_at = COALESCE(installing_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND status IN ('authorized','installing')
      RETURNING *`,
    [id]
  );
  if ((r.rowCount ?? 0) === 0) {
    const existing = await query(`SELECT status FROM installation_requests WHERE id = $1`, [id]);
    return { ok: false, reason: existing.rows[0] ? 'not_installable' : 'not_found' };
  }
  await audit(
    'install_started',
    'installation_request',
    id,
    'Agent installation started on the target device',
    null
  );
  return { ok: true, request: r.rows[0] as InstallRequestRow };
}

export async function assertInstallTokenUsable(
  jti: string
): Promise<{ ok: boolean; reason?: string; request?: InstallRequestRow }> {
  const row = await getRequestByInstallJti(jti);
  if (!row) return { ok: false, reason: 'not_found' };
  if (
    row.status === 'authorized' ||
    row.status === 'installing' ||
    row.status === 'installed' ||
    row.status === 'integrated'
  ) {
    return { ok: true, request: row };
  }
  const reason =
    row.status === 'refused'
      ? 'refused'
      : row.status === 'expired'
        ? 'expired'
        : row.status === 'cancelled'
          ? 'cancelled'
          : 'not_authorized';
  return { ok: false, reason };
}

export async function markRequestInstalledDevice(
  requestId: string,
  deviceId: string
): Promise<boolean> {
  const r = await query(
    `UPDATE installation_requests
        SET status = 'installed', installed_at = NOW(), device_id = $2, updated_at = NOW()
      WHERE id = $1 AND status IN ('authorized','installing','installed')
      RETURNING node_id`,
    [requestId, deviceId]
  );
  if ((r.rowCount ?? 0) === 0) return false;
  await query(
    `UPDATE network_nodes SET device_id = $2, updated_at = NOW() WHERE id = $1 AND device_id IS NULL`,
    [r.rows[0].node_id, deviceId]
  );
  await audit(
    'agent_installed',
    'installation_request',
    requestId,
    'Agent registered for the authorized installation request',
    null,
    { device_id: deviceId, node_id: r.rows[0].node_id }
  );
  return true;
}

export async function markIntegratedByDevice(deviceId: string): Promise<string | null> {
  const r = await query(
    `UPDATE installation_requests
        SET status = 'integrated', integrated_at = NOW(), updated_at = NOW()
      WHERE device_id = $1 AND status = 'installed'
      RETURNING id`,
    [deviceId]
  );
  const row = r.rows[0];
  if (row) {
    await markNodeEnrolled(deviceId);
    await audit(
      'device_integrated',
      'installation_request',
      row.id,
      'Device confirmed its first authenticated heartbeat',
      null,
      { device_id: deviceId }
    );
    return row.id as string;
  }
  return null;
}

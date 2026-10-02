import { query } from '../config/database';

// Account isolation: every account - including the super admin - only sees the devices
// connected to its own account (devices.created_by). No endpoint may expose another
// account's devices; the legacy 'devices.view_all' grant now only means "may also see
// and manage devices that are not assigned to any account".
export function canViewUnownedDevices(user?: { permissions?: string[] } | null): boolean {
  return !!user?.permissions?.includes('devices.view_all');
}

export type TenantUser = { id?: string; permissions?: string[] } | null | undefined;

// May this account see a device owned by `ownerId` (null/undefined = no account)?
export function canSeeDevice(user: TenantUser, ownerId: string | null | undefined): boolean {
  if (ownerId == null) return canViewUnownedDevices(user);
  return !!user?.id && ownerId === user.id;
}

// SQL predicate for a `devices.created_by` column restricting rows to what this
// account may see: its own devices, plus - for admin - devices with no account.
// `ph` is the placeholder index holding the caller's user id.
export function visibleDevicesSql(col: string, ph: number, user: TenantUser): string {
  const own = `${col} = $${ph}`;
  return canViewUnownedDevices(user) ? `(${own} OR ${col} IS NULL)` : own;
}

// LEFT JOIN variant for alerts / security events / commands: rows with no device are
// system-level and always visible, device rows follow visibleDevicesSql().
export function visibleDeviceRowsSql(
  deviceIdCol: string,
  ownerCol: string,
  ph: number,
  user: TenantUser
): string {
  return `(${deviceIdCol} IS NULL OR ${visibleDevicesSql(ownerCol, ph, user)})`;
}

export async function isUnownedDevice(deviceId: string): Promise<boolean> {
  if (!deviceId) return false;
  const r = await query('SELECT created_by FROM devices WHERE id = $1', [deviceId]);
  return r.rows.length > 0 && r.rows[0].created_by == null;
}

// May this account see/manage this device? The owner always; the admin additionally
// for devices that have no account yet. Everything else is a 404 (no existence leak).
export async function canAccessDevice(
  user: { id?: string; permissions?: string[] } | null | undefined,
  deviceId: string
): Promise<boolean> {
  if (!deviceId) return false;
  if (await ownsDevice(user?.id, deviceId)) return true;
  return canViewUnownedDevices(user) && (await isUnownedDevice(deviceId));
}

// True when the user owns the device (devices.created_by) - used for non-admin accounts
export async function ownsDevice(userId: string | undefined, deviceId: string): Promise<boolean> {
  if (!userId || !deviceId) return false;
  const r = await query('SELECT created_by FROM devices WHERE id = $1', [deviceId]);
  if (r.rows.length === 0) return false;
  return r.rows[0].created_by === userId;
}

// Who may approve/reject a device: the account that created it. Unowned devices are
// only moderated by accounts holding 'devices.view_all'; other accounts' devices are
// invisible (moderated as not_found / forbidden).
export type DeviceModeration = 'allow' | 'forbidden' | 'not_found';

export async function moderateDeviceAccess(
  userId: string | undefined,
  deviceId: string,
  canModerateUnowned: boolean
): Promise<DeviceModeration> {
  if (!deviceId) return 'not_found';
  const r = await query('SELECT created_by FROM devices WHERE id = $1', [deviceId]);
  if (r.rows.length === 0) return 'not_found';
  const owner = r.rows[0].created_by as string | null;
  if (!owner) return canModerateUnowned ? 'allow' : 'not_found';
  if (owner === userId) return 'allow';
  return canModerateUnowned ? 'forbidden' : 'not_found';
}

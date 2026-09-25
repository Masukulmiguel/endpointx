import { query } from '../config/database';

// Super-admin scope: can see devices across every account (permission granted to admin only)
export function canViewAllDevices(user?: { permissions?: string[] } | null): boolean {
  return !!user?.permissions?.includes('devices.view_all');
}

// True when the user owns the device (devices.created_by) — used for non-admin accounts
export async function ownsDevice(userId: string | undefined, deviceId: string): Promise<boolean> {
  if (!userId || !deviceId) return false;
  const r = await query('SELECT created_by FROM devices WHERE id = $1', [deviceId]);
  if (r.rows.length === 0) return false;
  return r.rows[0].created_by === userId;
}

// Who may approve/reject a device: the account that created it (or anyone, when the
// device has no owner). Admin (view_all) can see other accounts' devices but must not
// moderate them — super-admin observes, the owning account decides.
export type DeviceModeration = 'allow' | 'forbidden' | 'not_found';

export async function moderateDeviceAccess(
  userId: string | undefined,
  deviceId: string,
  viewAll: boolean
): Promise<DeviceModeration> {
  if (!deviceId) return 'not_found';
  const r = await query('SELECT created_by FROM devices WHERE id = $1', [deviceId]);
  if (r.rows.length === 0) return 'not_found';
  const owner = r.rows[0].created_by as string | null;
  if (!owner || owner === userId) return 'allow';
  return viewAll ? 'forbidden' : 'not_found';
}

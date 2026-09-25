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

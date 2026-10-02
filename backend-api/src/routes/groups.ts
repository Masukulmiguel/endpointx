import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { canViewUnownedDevices } from '../utils/tenant';

const router = Router();

// Account isolation: each account only sees and manages its own groups (created_by).
// Admins with devices.view_all also see unowned legacy groups ("Sem conta"), mirroring devices.
async function denyUnlessOwnGroup(req: AuthRequest, res: Response, groupId: string): Promise<boolean> {
  const r = await query(
    'SELECT id FROM device_groups WHERE id = $1 AND (created_by = $2 OR (created_by IS NULL AND $3::boolean))',
    [groupId, req.user!.id, canViewUnownedDevices(req.user)]
  );
  if (r.rows.length === 0) {
    res.status(404).json({ success: false, error: { message: 'Group not found' } });
    return false;
  }
  return true;
}

// List groups with device count
router.get('/', authenticate, requirePermission('groups.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT g.*,
        (SELECT COUNT(*) FROM device_group_members dgm
           JOIN devices d ON d.id = dgm.device_id
          WHERE dgm.group_id = g.id AND d.created_by = $1) AS device_count
       FROM device_groups g
       WHERE g.created_by = $1 OR (g.created_by IS NULL AND $2::boolean)
       ORDER BY g.created_at DESC`,
      [req.user!.id, canViewUnownedDevices(req.user)]
    );
    res.json({ success: true, data: { groups: result.rows } });
  } catch (error) { next(error); }
});

// Create group
router.post('/', authenticate, requirePermission('groups.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, description } = req.body;
    const idResult = await query('SELECT uuid_generate_v4() AS id');
    const id = idResult.rows[0].id;

    await query(
      'INSERT INTO device_groups (id, name, description, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())',
      [id, name, description || '', req.user?.id]
    );

    res.status(201).json({ success: true, data: { id, name, description } });
  } catch (error) { next(error); }
});

// Get group with members
router.get('/:id', authenticate, requirePermission('groups.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const groupResult = await query(
      'SELECT * FROM device_groups WHERE id = $1 AND (created_by = $2 OR (created_by IS NULL AND $3::boolean))',
      [id, req.user!.id, canViewUnownedDevices(req.user)]
    );
    if (groupResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Group not found' } });
      return;
    }

    const membersResult = await query(
      `SELECT d.* FROM devices d
       JOIN device_group_members dgm ON dgm.device_id = d.id
       WHERE dgm.group_id = $1 AND d.created_by = $2
       ORDER BY d.hostname ASC`,
      [id, req.user!.id]
    );

    res.json({ success: true, data: { group: { ...groupResult.rows[0], devices: membersResult.rows } } });
  } catch (error) { next(error); }
});

// Update group
router.put('/:id', authenticate, requirePermission('groups.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!(await denyUnlessOwnGroup(req, res, id))) return;
    const { name, description } = req.body;

    await query(
      'UPDATE device_groups SET name = COALESCE($1, name), description = COALESCE($2, description), updated_at = NOW() WHERE id = $3',
      [name ?? null, description ?? null, id]
    );

    res.json({ success: true, data: { message: 'Group updated' } });
  } catch (error) { next(error); }
});

// Delete group
router.delete('/:id', authenticate, requirePermission('groups.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (!(await denyUnlessOwnGroup(req, res, id))) return;
    await query('DELETE FROM device_group_members WHERE group_id = $1', [id]);
    await query('DELETE FROM device_groups WHERE id = $1', [id]);
    res.json({ success: true, data: { message: 'Group deleted' } });
  } catch (error) { next(error); }
});

// Assign devices to group (only the caller's own devices)
router.post('/:id/assign', authenticate, requirePermission('groups.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { device_ids } = req.body;

    if (!Array.isArray(device_ids) || device_ids.length === 0) {
      res.status(400).json({ success: false, error: { message: 'device_ids array is required' } });
      return;
    }
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const candidateIds = device_ids.filter((d: unknown) => typeof d === 'string' && uuidRe.test(d));
    if (candidateIds.length === 0) {
      res.json({ success: true, data: { message: 'Devices assigned', assigned: 0, skipped: device_ids.length } });
      return;
    }
    if (!(await denyUnlessOwnGroup(req, res, id))) return;

    const own = await query('SELECT id FROM devices WHERE id = ANY($1::uuid[]) AND created_by = $2', [candidateIds, req.user!.id]);
    const allowed = new Set(own.rows.map((r: any) => r.id));

    let inserted = 0;
    for (const deviceId of candidateIds) {
      if (!allowed.has(deviceId)) continue;
      const existing = await query(
        'SELECT group_id FROM device_group_members WHERE group_id = $1 AND device_id = $2',
        [id, deviceId]
      );
      if (existing.rows.length === 0) {
        await query(
          'INSERT INTO device_group_members (group_id, device_id) VALUES ($1, $2)',
          [id, deviceId]
        );
        inserted++;
      }
    }

    res.json({ success: true, data: { message: 'Devices assigned', assigned: inserted, skipped: device_ids.length - inserted } });
  } catch (error) { next(error); }
});

// Remove device from group
router.delete('/:id/devices/:deviceId', authenticate, requirePermission('groups.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id, deviceId } = req.params;
    if (!(await denyUnlessOwnGroup(req, res, id))) return;
    await query(
      'DELETE FROM device_group_members WHERE group_id = $1 AND device_id = $2',
      [id, deviceId]
    );
    res.json({ success: true, data: { message: 'Device removed from group' } });
  } catch (error) { next(error); }
});

export default router;

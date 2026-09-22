import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

// List groups with device count
router.get('/', authenticate, requirePermission('groups.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT g.*,
        (SELECT COUNT(*) FROM device_group_members dgm WHERE dgm.group_id = g.id) AS device_count
       FROM device_groups g
       ORDER BY g.created_at DESC`
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
    const groupResult = await query('SELECT * FROM device_groups WHERE id = $1', [id]);
    if (groupResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Group not found' } });
      return;
    }

    const membersResult = await query(
      `SELECT d.* FROM devices d
       JOIN device_group_members dgm ON dgm.device_id = d.id
       WHERE dgm.group_id = $1
       ORDER BY d.hostname ASC`,
      [id]
    );

    res.json({ success: true, data: { group: { ...groupResult.rows[0], devices: membersResult.rows } } });
  } catch (error) { next(error); }
});

// Update group
router.put('/:id', authenticate, requirePermission('groups.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
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
    await query('DELETE FROM device_group_members WHERE group_id = $1', [id]);
    await query('DELETE FROM device_groups WHERE id = $1', [id]);
    res.json({ success: true, data: { message: 'Group deleted' } });
  } catch (error) { next(error); }
});

// Assign devices to group
router.post('/:id/assign', authenticate, requirePermission('groups.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { device_ids } = req.body;

    if (!Array.isArray(device_ids) || device_ids.length === 0) {
      res.status(400).json({ success: false, error: { message: 'device_ids array is required' } });
      return;
    }

    let inserted = 0;
    for (const deviceId of device_ids) {
      const existing = await query(
        'SELECT id FROM device_group_members WHERE group_id = $1 AND device_id = $2',
        [id, deviceId]
      );
      if (existing.rows.length === 0) {
        const idResult = await query('SELECT uuid_generate_v4() AS id');
        await query(
          'INSERT INTO device_group_members (id, group_id, device_id, assigned_at) VALUES ($1, $2, $3, NOW())',
          [idResult.rows[0].id, id, deviceId]
        );
        inserted++;
      }
    }

    res.json({ success: true, data: { message: 'Devices assigned', assigned: inserted } });
  } catch (error) { next(error); }
});

// Remove device from group
router.delete('/:id/devices/:deviceId', authenticate, requirePermission('groups.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id, deviceId } = req.params;
    await query(
      'DELETE FROM device_group_members WHERE group_id = $1 AND device_id = $2',
      [id, deviceId]
    );
    res.json({ success: true, data: { message: 'Device removed from group' } });
  } catch (error) { next(error); }
});

export default router;

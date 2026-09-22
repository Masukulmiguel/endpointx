import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

// List packages
router.get('/', authenticate, requirePermission('software.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT sp.*,
        (SELECT COUNT(*) FROM software_deployments sd WHERE sd.package_id = sp.id) AS deployment_count,
        (SELECT COUNT(*) FROM software_deployments sd WHERE sd.package_id = sp.id AND sd.status = 'completed') AS completed_count
       FROM software_packages sp
       ORDER BY sp.created_at DESC`
    );
    res.json({ success: true, data: { packages: result.rows } });
  } catch (error) { next(error); }
});

// Create package
router.post('/', authenticate, requirePermission('software.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, version, description, file_url, file_size, checksum, install_command, uninstall_command } = req.body;
    const idResult = await query('SELECT uuid_generate_v4() AS id');
    const id = idResult.rows[0].id;

    await query(
      `INSERT INTO software_packages (id, name, version, description, file_url, file_size, checksum, install_command, uninstall_command, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())`,
      [id, name, version || '1.0.0', description || '', file_url || '', file_size || 0, checksum || '', install_command || '', uninstall_command || '', req.user?.id]
    );

    res.status(201).json({ success: true, data: { id, name, version } });
  } catch (error) { next(error); }
});

// Get package with deployment stats
router.get('/:id', authenticate, requirePermission('software.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const pkgResult = await query('SELECT * FROM software_packages WHERE id = $1', [id]);
    if (pkgResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Package not found' } });
      return;
    }

    const statsResult = await query(
      `SELECT
        COUNT(*) AS total_deployments,
        COUNT(*) FILTER (WHERE status = 'completed') AS successful,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress
       FROM software_deployments WHERE package_id = $1`,
      [id]
    );

    res.json({
      success: true,
      data: { package: { ...pkgResult.rows[0], stats: statsResult.rows[0] } }
    });
  } catch (error) { next(error); }
});

// Update package
router.put('/:id', authenticate, requirePermission('software.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { name, version, description, file_url, file_size, checksum, install_command, uninstall_command } = req.body;

    await query(
      `UPDATE software_packages SET
        name = COALESCE($1, name),
        version = COALESCE($2, version),
        description = COALESCE($3, description),
        file_url = COALESCE($4, file_url),
        file_size = COALESCE($5, file_size),
        checksum = COALESCE($6, checksum),
        install_command = COALESCE($7, install_command),
        uninstall_command = COALESCE($8, uninstall_command),
        updated_at = NOW()
       WHERE id = $9`,
      [name ?? null, version ?? null, description ?? null, file_url ?? null, file_size ?? null, checksum ?? null, install_command ?? null, uninstall_command ?? null, id]
    );

    res.json({ success: true, data: { message: 'Package updated' } });
  } catch (error) { next(error); }
});

// Delete package
router.delete('/:id', authenticate, requirePermission('software.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    await query('DELETE FROM software_deployments WHERE package_id = $1', [id]);
    await query('DELETE FROM software_packages WHERE id = $1', [id]);
    res.json({ success: true, data: { message: 'Package deleted' } });
  } catch (error) { next(error); }
});

// Deploy to devices
router.post('/:id/deploy', authenticate, requirePermission('software.deploy'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { device_ids } = req.body;

    if (!Array.isArray(device_ids) || device_ids.length === 0) {
      res.status(400).json({ success: false, error: { message: 'device_ids array is required' } });
      return;
    }

    const pkgResult = await query('SELECT * FROM software_packages WHERE id = $1', [id]);
    if (pkgResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Package not found' } });
      return;
    }

    const deployments = [];
    for (const deviceId of device_ids) {
      const devResult = await query('SELECT id, agent_id FROM devices WHERE id = $1', [deviceId]);
      if (devResult.rows.length === 0) continue;

      const deployIdResult = await query('SELECT uuid_generate_v4() AS id');
      const deployId = deployIdResult.rows[0].id;

      await query(
        `INSERT INTO software_deployments (id, package_id, device_id, status, deployed_by, deployed_at)
         VALUES ($1, $2, $3, 'pending', $4, NOW())`,
        [deployId, id, deviceId, req.user?.id]
      );

      const device = devResult.rows[0];
      if (device.agent_id) {
        const cmdIdResult = await query('SELECT uuid_generate_v4() AS id');
        await query(
          `INSERT INTO agent_commands (id, device_id, command_type, parameters, status, issued_by, created_at)
           VALUES ($1, $2, 'install_software', $3, 'pending', $4, NOW())`,
          [cmdIdResult.rows[0].id, deviceId, JSON.stringify({ package_id: id, package_name: pkgResult.rows[0].name }), req.user?.id]
        );
      }

      deployments.push({ deployment_id: deployId, device_id: deviceId });
    }

    res.json({ success: true, data: { message: 'Deployments initiated', deployments } });
  } catch (error) { next(error); }
});

// List deployments for package
router.get('/:id/deployments', authenticate, requirePermission('software.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const result = await query(
      `SELECT sd.*, d.hostname, d.agent_id
       FROM software_deployments sd
       JOIN devices d ON d.id = sd.device_id
       WHERE sd.package_id = $1
       ORDER BY sd.deployed_at DESC`,
      [id]
    );
    res.json({ success: true, data: { deployments: result.rows } });
  } catch (error) { next(error); }
});

// List all deployments across all packages
router.get('/deployments/all', authenticate, requirePermission('software.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT sd.*, d.hostname, d.agent_id, sp.name AS package_name, sp.version AS package_version
       FROM software_deployments sd
       JOIN devices d ON d.id = sd.device_id
       JOIN software_packages sp ON sp.id = sd.package_id
       ORDER BY sd.deployed_at DESC`
    );
    res.json({ success: true, data: { deployments: result.rows } });
  } catch (error) { next(error); }
});

export default router;

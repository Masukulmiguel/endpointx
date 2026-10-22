import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate, invalidatePermissionCache } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

/**
 * The permission ids a request wants to set on a role.
 *
 * `permission_ids` is the canonical field. `permissions` is accepted as an
 * alias: a client that sends the other shape must still apply the change —
 * a silently ignored body leaves the operator believing a permission was
 * granted when it was not.
 *
 * @param body request body
 * @returns the id list, or null when the request does not touch permissions
 */
function readPermissionIds(body: Record<string, unknown> | undefined): string[] | null {
  if (!body) return null;
  const raw = Array.isArray(body.permission_ids)
    ? body.permission_ids
    : Array.isArray(body.permissions)
      ? body.permissions
      : null;
  if (!raw) return null;
  return raw.map((id) => String(id));
}

// List roles
router.get('/', authenticate, requirePermission('roles.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query('SELECT r.*, (SELECT COUNT(*) FROM role_permissions WHERE role_id = r.id) as permission_count FROM roles r ORDER BY r.name', []);
    res.json({ success: true, data: { roles: result.rows } });
  } catch (error) { next(error); }
});

// List all permissions
router.get('/permissions', authenticate, requirePermission('roles.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query('SELECT * FROM permissions ORDER BY category, name', []);
    res.json({ success: true, data: { permissions: result.rows } });
  } catch (error) { next(error); }
});

// Get role
router.get('/:id', authenticate, requirePermission('roles.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const role = await query('SELECT * FROM roles WHERE id = $1', [req.params.id]);
    if (role.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Role not found' } }); return; }
    const perms = await query('SELECT p.* FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = $1', [req.params.id]);
    res.json({ success: true, data: { role: { ...role.rows[0], permissions: perms.rows } } });
  } catch (error) { next(error); }
});

// Create role
router.post('/', authenticate, requirePermission('roles.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, display_name, description } = req.body;
    const permissionIds = readPermissionIds(req.body as Record<string, unknown>);
    const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    await query('INSERT INTO roles (id, name, display_name, description) VALUES ($1, $2, $3, $4)', [id, name, display_name, description || '']);
    if (permissionIds) {
      for (const pid of permissionIds) {
        await query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [id, pid]);
      }
    }
    res.status(201).json({ success: true, data: { id, name, display_name } });
  } catch (error) { next(error); }
});

// Update role
router.put('/:id', authenticate, requirePermission('roles.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { display_name, description } = req.body;
    const permissionIds = readPermissionIds(req.body as Record<string, unknown>);

    // A system role keeps its name — the key the boot-time permission repair
    // looks up — and cannot be deleted, but its label and its permission set
    // are the operator's to change: that is how the Cyber Lab codes are
    // granted to a role.
    await query(
      'UPDATE roles SET display_name = COALESCE($1, display_name), description = COALESCE($2, description) WHERE id = $3',
      [display_name ?? null, description ?? null, id]
    );

    if (permissionIds) {
      await query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      for (const pid of permissionIds) {
        await query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)', [id, pid]);
      }
      // The RBAC cache holds the previous set for up to a minute. Drop it now
      // so the grant takes effect on the operator's next request.
      invalidatePermissionCache(id);
    }
    res.json({ success: true, data: { message: 'Role updated' } });
  } catch (error) { next(error); }
});

// Delete role
router.delete('/:id', authenticate, requirePermission('roles.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const role = await query('SELECT is_system FROM roles WHERE id = $1', [id]);
    if (role.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Role not found' } }); return; }
    if (role.rows[0].is_system) { res.status(400).json({ success: false, error: { message: 'Cannot delete system role' } }); return; }
    await query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
    await query('DELETE FROM roles WHERE id = $1', [id]);
    invalidatePermissionCache(id);
    res.json({ success: true, data: { message: 'Role deleted' } });
  } catch (error) { next(error); }
});

export default router;

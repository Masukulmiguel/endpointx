import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

// List roles
router.get('/', authenticate, requirePermission('roles.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = query('SELECT r.*, (SELECT COUNT(*) FROM role_permissions WHERE role_id = r.id) as permission_count FROM roles r ORDER BY r.name', []);
    res.json({ success: true, data: { roles: result.rows } });
  } catch (error) { next(error); }
});

// List all permissions
router.get('/permissions', authenticate, requirePermission('roles.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = query('SELECT * FROM permissions ORDER BY category, name', []);
    res.json({ success: true, data: { permissions: result.rows } });
  } catch (error) { next(error); }
});

// Get role
router.get('/:id', authenticate, requirePermission('roles.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const role = query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (role.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Role not found' } }); return; }
    const perms = query('SELECT p.* FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = ?', [req.params.id]);
    res.json({ success: true, data: { role: { ...role.rows[0], permissions: perms.rows } } });
  } catch (error) { next(error); }
});

// Create role
router.post('/', authenticate, requirePermission('roles.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, display_name, description, permission_ids } = req.body;
    const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    query('INSERT INTO roles (id, name, display_name, description) VALUES (?, ?, ?, ?)', [id, name, display_name, description || '']);
    if (permission_ids && Array.isArray(permission_ids)) {
      permission_ids.forEach((pid: string) => query('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [id, pid]));
    }
    res.status(201).json({ success: true, data: { id, name, display_name } });
  } catch (error) { next(error); }
});

// Update role
router.put('/:id', authenticate, requirePermission('roles.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { display_name, description, permission_ids } = req.body;
    query('UPDATE roles SET display_name = COALESCE(?, display_name), description = COALESCE(?, description) WHERE id = ? AND is_system = 0', [display_name ?? null, description ?? null, id]);
    if (permission_ids && Array.isArray(permission_ids)) {
      query('DELETE FROM role_permissions WHERE role_id = ?', [id]);
      permission_ids.forEach((pid: string) => query('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [id, pid]));
    }
    res.json({ success: true, data: { message: 'Role updated' } });
  } catch (error) { next(error); }
});

// Delete role
router.delete('/:id', authenticate, requirePermission('roles.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const role = query('SELECT is_system FROM roles WHERE id = ?', [id]);
    if (role.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Role not found' } }); return; }
    if (role.rows[0].is_system) { res.status(400).json({ success: false, error: { message: 'Cannot delete system role' } }); return; }
    query('DELETE FROM role_permissions WHERE role_id = ?', [id]);
    query('DELETE FROM roles WHERE id = ?', [id]);
    res.json({ success: true, data: { message: 'Role deleted' } });
  } catch (error) { next(error); }
});

export default router;

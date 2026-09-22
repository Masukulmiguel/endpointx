import { Router, Request, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { hashPassword } from '../utils/helpers';
import logger from '../utils/logger';

const router = Router();

// List users
router.get('/', authenticate, requirePermission('users.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string || '';
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params: any[] = [];
    if (search) {
      whereClause = 'WHERE (u.email LIKE ? OR u.username LIKE ? OR u.full_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const countResult = await query(`SELECT COUNT(*) as total FROM users u ${whereClause}`, params);
    const total = countResult.rows[0]?.total || 0;

    const result = await query(`SELECT u.id, u.email, u.username, u.full_name, u.is_active, u.mfa_enabled, u.last_login, u.created_at, r.name as role_name
      FROM users u LEFT JOIN roles r ON u.role_id = r.id ${whereClause} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]);

    res.json({ success: true, data: { users: result.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } } });
  } catch (error) {
    next(error);
  }
});

// Get user
router.get('/:id', authenticate, requirePermission('users.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const result = await query('SELECT u.id, u.email, u.username, u.full_name, u.is_active, u.mfa_enabled, u.last_login, u.created_at, r.name as role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ?', [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'User not found' } });
      return;
    }
    res.json({ success: true, data: { user: result.rows[0] } });
  } catch (error) {
    next(error);
  }
});

// Create user
router.post('/', authenticate, requirePermission('users.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { email, username, full_name, password, role_id } = req.body;
    if (!email || !username || !full_name || !password) {
      res.status(400).json({ success: false, error: { message: 'Missing required fields' } });
      return;
    }

    const existing = await query('SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
    if (existing.rows.length > 0) {
      res.status(409).json({ success: false, error: { message: 'User already exists' } });
      return;
    }

    const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const passwordHash = await hashPassword(password);

    await query('INSERT INTO users (id, email, username, full_name, password_hash, role_id) VALUES (?, ?, ?, ?, ?, ?)',
      [id, email, username, full_name, passwordHash, role_id || 'role_user']);

    await query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'user_create', 'user', id, 'User created', req.ip]);

    res.status(201).json({ success: true, data: { id, email, username, full_name } });
  } catch (error) {
    next(error);
  }
});

// Update user
router.put('/:id', authenticate, requirePermission('users.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { email, full_name, is_active, role_id } = req.body;

    await query('UPDATE users SET email = COALESCE(?, email), full_name = COALESCE(?, full_name), is_active = COALESCE(?, is_active) WHERE id = ?',
      [email ?? null, full_name ?? null, is_active ?? null, id]);

    res.json({ success: true, data: { message: 'User updated' } });
  } catch (error) {
    next(error);
  }
});

// Delete user
router.delete('/:id', authenticate, requirePermission('users.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    if (id === req.user?.id) {
      res.status(400).json({ success: false, error: { message: 'Cannot delete yourself' } });
      return;
    }
    await query('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true, data: { message: 'User deleted' } });
  } catch (error) {
    next(error);
  }
});

// Get user permissions
router.get('/:id/permissions', authenticate, requirePermission('users.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const result = await query('SELECT p.code, p.name FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id JOIN users u ON rp.role_id = u.role_id WHERE u.id = ?', [id]);
    res.json({ success: true, data: { permissions: result.rows } });
  } catch (error) {
    next(error);
  }
});

export default router;

import { Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';
import { paginate, hashPassword, sanitizeString } from '../utils/helpers';

export const getUsers = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string | undefined;
    const role_id = req.query.role_id as string | undefined;
    const { offset, limit: safeLimit } = paginate(page, limit);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`(u.email ILIKE $${paramIndex} OR u.first_name ILIKE $${paramIndex} OR u.last_name ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (role_id) {
      conditions.push(`u.role_id = $${paramIndex}`);
      params.push(role_id);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(
      `SELECT COUNT(*)::int as total FROM users u ${whereClause}`,
      params
    );

    const result = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role_id, u.is_active,
              u.last_login, u.created_at, u.updated_at,
              r.name as role_name, r.description as role_description,
              (SELECT COUNT(*)::int FROM devices d WHERE d.user_id = u.id) as device_count
       FROM users u
       JOIN roles r ON u.role_id = r.id
       ${whereClause}
       ORDER BY u.created_at DESC
       OFFSET $${paramIndex} LIMIT $${paramIndex + 1}`,
      [...params, offset, safeLimit]
    );

    res.json({
      success: true,
      data: {
        users: result.rows,
        pagination: {
          page,
          limit: safeLimit,
          total: countResult.rows[0].total,
          totalPages: Math.ceil(countResult.rows[0].total / safeLimit),
        },
      },
    });
  } catch (error) {
    logger.error('Get users error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const userResult = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.role_id, u.is_active,
              u.last_login, u.created_at, u.updated_at,
              r.name as role_name, r.description as role_description
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.id = $1`,
      [id]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'User not found.', code: 'USER_NOT_FOUND' },
      });
      return;
    }

    const user = userResult.rows[0];

    const [permissionsResult, devicesResult] = await Promise.all([
      query(
        `SELECT p.name, p.description, p.category
         FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         WHERE rp.role_id = $1
         ORDER BY p.category, p.name`,
        [user.role_id]
      ),
      query(
        `SELECT id, agent_id, hostname, status, last_heartbeat
         FROM devices
         WHERE user_id = $1
         ORDER BY last_heartbeat DESC NULLS LAST`,
        [id]
      ),
    ]);

    res.json({
      success: true,
      data: {
        user: {
          ...user,
          permissions: permissionsResult.rows,
          devices: devicesResult.rows,
        },
      },
    });
  } catch (error) {
    logger.error('Get user error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const createUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { email, password, first_name, last_name, role_id } = req.body;

    if (!email || !password) {
      res.status(400).json({
        success: false,
        error: { message: 'Email and password are required.', code: 'VALIDATION_ERROR' },
      });
      return;
    }

    const existingUser = await query('SELECT id FROM users WHERE email = $1', [
      email.toLowerCase().trim(),
    ]);
    if (existingUser.rows.length > 0) {
      res.status(409).json({
        success: false,
        error: { message: 'A user with this email already exists.', code: 'USER_ALREADY_EXISTS' },
      });
      return;
    }

    const passwordHash = await hashPassword(password);
    const assignedRoleId = role_id || 4;

    const result = await query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role_id, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, email, first_name, last_name, role_id, is_active, created_at`,
      [email.toLowerCase().trim(), passwordHash, sanitizeString(first_name || ''), sanitizeString(last_name || ''), assignedRoleId]
    );

    const newUser = result.rows[0];

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'create_user', 'user', $2, $3, $4)`,
      [
        req.user?.id || null,
        newUser.id,
        JSON.stringify({ email: newUser.email, role_id: assignedRoleId }),
        req.ip,
      ]
    );

    logger.info('User created', { createdBy: req.user?.id, newUser: newUser.id, email: newUser.email });

    res.status(201).json({ success: true, data: { user: newUser } });
  } catch (error) {
    logger.error('Create user error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const updateUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const { email, first_name, last_name, role_id, is_active } = req.body;

    if (email) {
      const existingUser = await query('SELECT id FROM users WHERE email = $1 AND id != $2', [
        email.toLowerCase().trim(),
        id,
      ]);
      if (existingUser.rows.length > 0) {
        res.status(409).json({
          success: false,
          error: { message: 'A user with this email already exists.', code: 'USER_ALREADY_EXISTS' },
        });
        return;
      }
    }

    const result = await query(
      `UPDATE users
       SET email = COALESCE($1, email),
           first_name = COALESCE($2, first_name),
           last_name = COALESCE($3, last_name),
           role_id = COALESCE($4, role_id),
           is_active = COALESCE($5, is_active),
           updated_at = NOW()
       WHERE id = $6
       RETURNING id, email, first_name, last_name, role_id, is_active, updated_at`,
      [email?.toLowerCase().trim() ?? null, first_name ?? null, last_name ?? null, role_id ?? null, is_active ?? null, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'User not found.', code: 'USER_NOT_FOUND' },
      });
      return;
    }

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'update_user', 'user', $2, $3, $4)`,
      [
        req.user?.id || null,
        id,
        JSON.stringify({ email, first_name, last_name, role_id, is_active }),
        req.ip,
      ]
    );

    logger.info('User updated', { updatedBy: req.user?.id, targetUserId: id });

    res.json({ success: true, data: { user: result.rows[0] } });
  } catch (error) {
    logger.error('Update user error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const deleteUser = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const currentUserId = req.user?.id;

    if (id === currentUserId) {
      res.status(409).json({
        success: false,
        error: { message: 'You cannot deactivate your own account.', code: 'CANNOT_DELETE_SELF' },
      });
      return;
    }

    const result = await query(
      `UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id, email, is_active`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'User not found.', code: 'USER_NOT_FOUND' },
      });
      return;
    }

    await query('DELETE FROM user_sessions WHERE user_id = $1', [id]);

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'deactivate_user', 'user', $2, $3, $4)`,
      [
        req.user?.id || null,
        id,
        JSON.stringify({ email: result.rows[0].email }),
        req.ip,
      ]
    );

    logger.info('User deactivated', { deactivatedBy: req.user?.id, targetUserId: id });

    res.json({ success: true, data: { message: 'User deactivated successfully.' } });
  } catch (error) {
    logger.error('Delete user error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getUserPermissions = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const userResult = await query('SELECT role_id FROM users WHERE id = $1', [id]);
    if (userResult.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'User not found.', code: 'USER_NOT_FOUND' },
      });
      return;
    }

    const role_id = userResult.rows[0].role_id;

    const result = await query(
      `SELECT p.id, p.name, p.description, p.category
       FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       WHERE rp.role_id = $1
       ORDER BY p.category, p.name`,
      [role_id]
    );

    const grouped = result.rows.reduce((acc: Record<string, any[]>, perm: any) => {
      if (!acc[perm.category]) {
        acc[perm.category] = [];
      }
      acc[perm.category].push({ id: perm.id, name: perm.name, description: perm.description });
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        role_id,
        permissions: result.rows,
        grouped,
      },
    });
  } catch (error) {
    logger.error('Get user permissions error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

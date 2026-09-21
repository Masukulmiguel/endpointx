import { Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';
import { sanitizeString } from '../utils/helpers';

const SYSTEM_ROLES = [1, 2, 3, 4];

export const getRoles = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const result = await query(
      `SELECT r.id, r.name, r.description, r.is_system, r.created_at, r.updated_at,
              (SELECT COUNT(*)::int FROM role_permissions rp WHERE rp.role_id = r.id) as permission_count,
              (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.id) as user_count
       FROM roles r
       ORDER BY r.is_system DESC, r.name ASC`
    );

    res.json({ success: true, data: { roles: result.rows } });
  } catch (error) {
    logger.error('Get roles error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getRole = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const roleResult = await query(
      `SELECT r.id, r.name, r.description, r.is_system, r.created_at, r.updated_at
       FROM roles r
       WHERE r.id = $1`,
      [id]
    );

    if (roleResult.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Role not found.', code: 'ROLE_NOT_FOUND' },
      });
      return;
    }

    const role = roleResult.rows[0];

    const permissionsResult = await query(
      `SELECT p.id, p.name, p.description, p.category
       FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       WHERE rp.role_id = $1
       ORDER BY p.category, p.name`,
      [id]
    );

    const userCount = await query('SELECT COUNT(*)::int as count FROM users WHERE role_id = $1', [id]);

    res.json({
      success: true,
      data: {
        role: {
          ...role,
          permissions: permissionsResult.rows,
          user_count: userCount.rows[0].count,
        },
      },
    });
  } catch (error) {
    logger.error('Get role error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const createRole = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { name, description, permission_ids } = req.body;

    if (!name) {
      res.status(400).json({
        success: false,
        error: { message: 'Role name is required.', code: 'VALIDATION_ERROR' },
      });
      return;
    }

    const existingRole = await query('SELECT id FROM roles WHERE name = $1', [sanitizeString(name)]);
    if (existingRole.rows.length > 0) {
      res.status(409).json({
        success: false,
        error: { message: 'A role with this name already exists.', code: 'ROLE_ALREADY_EXISTS' },
      });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const roleResult = await client.query(
        `INSERT INTO roles (name, description, is_system)
         VALUES ($1, $2, false)
         RETURNING id, name, description, is_system, created_at`,
        [sanitizeString(name), description || null]
      );

      const role = roleResult.rows[0];

      if (Array.isArray(permission_ids) && permission_ids.length > 0) {
        const values = permission_ids.map((pid: string, i: number) => `($1, $${i + 2})`).join(', ');
        await client.query(
          `INSERT INTO role_permissions (role_id, permission_id) VALUES ${values}`,
          [role.id, ...permission_ids]
        );
      }

      await client.query('COMMIT');

      const fullRole = await query(
        `SELECT p.id, p.name, p.description, p.category
         FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         WHERE rp.role_id = $1
         ORDER BY p.category, p.name`,
        [role.id]
      );

      await query(
        `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
         VALUES ($1, 'create_role', 'role', $2, $3, $4)`,
        [
          req.user?.id || null,
          role.id,
          JSON.stringify({ name: role.name, permission_count: permission_ids?.length || 0 }),
          req.ip,
        ]
      );

      logger.info('Role created', { createdBy: req.user?.id, roleId: role.id, name: role.name });

      res.status(201).json({
        success: true,
        data: {
          role: {
            ...role,
            permissions: fullRole.rows,
          },
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Create role error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const updateRole = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    if (SYSTEM_ROLES.includes(Number(id))) {
      res.status(403).json({
        success: false,
        error: { message: 'System roles cannot be modified.', code: 'ROLE_IS_SYSTEM' },
      });
      return;
    }

    if (name) {
      const existingRole = await query('SELECT id FROM roles WHERE name = $1 AND id != $2', [
        sanitizeString(name),
        id,
      ]);
      if (existingRole.rows.length > 0) {
        res.status(409).json({
          success: false,
          error: { message: 'A role with this name already exists.', code: 'ROLE_ALREADY_EXISTS' },
        });
        return;
      }
    }

    const result = await query(
      `UPDATE roles
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, name, description, is_system, updated_at`,
      [name ? sanitizeString(name) : null, description ?? null, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Role not found.', code: 'ROLE_NOT_FOUND' },
      });
      return;
    }

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'update_role', 'role', $2, $3, $4)`,
      [req.user?.id || null, id, JSON.stringify({ name, description }), req.ip]
    );

    logger.info('Role updated', { updatedBy: req.user?.id, roleId: id });

    res.json({ success: true, data: { role: result.rows[0] } });
  } catch (error) {
    logger.error('Update role error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const deleteRole = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    if (SYSTEM_ROLES.includes(Number(id))) {
      res.status(403).json({
        success: false,
        error: { message: 'System roles cannot be deleted.', code: 'ROLE_IS_SYSTEM' },
      });
      return;
    }

    const userCount = await query('SELECT COUNT(*)::int as count FROM users WHERE role_id = $1', [id]);
    if (userCount.rows[0].count > 0) {
      res.status(409).json({
        success: false,
        error: {
          message: `Cannot delete role: ${userCount.rows[0].count} user(s) are assigned to it. Reassign them first.`,
          code: 'ROLE_HAS_USERS',
        },
      });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      const result = await client.query('DELETE FROM roles WHERE id = $1 RETURNING id, name', [id]);

      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({
          success: false,
          error: { message: 'Role not found.', code: 'ROLE_NOT_FOUND' },
        });
        return;
      }

      await client.query('COMMIT');

      await query(
        `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
         VALUES ($1, 'delete_role', 'role', $2, $3, $4)`,
        [req.user?.id || null, id, JSON.stringify({ name: result.rows[0].name }), req.ip]
      );

      logger.info('Role deleted', { deletedBy: req.user?.id, roleId: id, name: result.rows[0].name });

      res.json({ success: true, data: { message: 'Role deleted successfully.' } });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error('Delete role error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getPermissions = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const result = await query(
      `SELECT id, name, description, category
       FROM permissions
       ORDER BY category, name`
    );

    const grouped = result.rows.reduce((acc: Record<string, any[]>, perm: any) => {
      if (!acc[perm.category]) {
        acc[perm.category] = [];
      }
      acc[perm.category].push({
        id: perm.id,
        name: perm.name,
        description: perm.description,
      });
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        permissions: result.rows,
        grouped,
        categories: Object.keys(grouped),
      },
    });
  } catch (error) {
    logger.error('Get permissions error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

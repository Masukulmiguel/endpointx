import { Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';
import { paginate } from '../utils/helpers';
import { io } from '../index';

const ALLOWED_COMMAND_TYPES = [
  'block',
  'quarantine',
  'reboot',
  'shutdown',
  'update_software',
  'scan',
  'collect_info',
  'execute_script',
  'isolate_network',
  'restore_network',
];

export const executeCommand = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        error: { message: 'Authentication required.', code: 'AUTH_TOKEN_MISSING' },
      });
      return;
    }

    const { device_id, command_type, command_data } = req.body;

    if (!device_id || !command_type) {
      res.status(400).json({
        success: false,
        error: { message: 'device_id and command_type are required.', code: 'VALIDATION_ERROR' },
      });
      return;
    }

    if (!ALLOWED_COMMAND_TYPES.includes(command_type)) {
      res.status(400).json({
        success: false,
        error: {
          message: `Invalid command type. Allowed: ${ALLOWED_COMMAND_TYPES.join(', ')}`,
          code: 'INVALID_COMMAND_TYPE',
        },
      });
      return;
    }

    const deviceResult = await query(
      `SELECT id, agent_id, status FROM devices WHERE id = $1`,
      [device_id]
    );

    if (deviceResult.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Device not found.', code: 'DEVICE_NOT_FOUND' },
      });
      return;
    }

    const device = deviceResult.rows[0];

    if (device.status === 'offline') {
      res.status(409).json({
        success: false,
        error: {
          message: 'Device is offline. Command will be queued for next heartbeat.',
          code: 'DEVICE_OFFLINE',
        },
      });
    }

    const result = await query(
      `INSERT INTO agent_commands (device_id, command_type, command_data, status, created_by)
       VALUES ($1, $2, $3, 'pending', $4)
       RETURNING id, device_id, command_type, command_data, status, created_at`,
      [device_id, command_type, command_data ? JSON.stringify(command_data) : '{}', userId]
    );

    const command = result.rows[0];

    io.to(`device:${device_id}`).emit('command', {
      id: command.id,
      command_type: command.command_type,
      command_data: command.command_data,
      device_id,
      timestamp: command.created_at,
    });

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'execute_command', 'command', $2, $3, $4)`,
      [
        userId,
        command.id,
        JSON.stringify({ device_id, agent_id: device.agent_id, command_type, command_data }),
        req.ip,
      ]
    );

    logger.info('Command created', {
      commandId: command.id,
      deviceId: device_id,
      agent_id: device.agent_id,
      command_type,
      createdBy: userId,
    });

    res.status(201).json({ success: true, data: { command } });
  } catch (error) {
    logger.error('Execute command error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getCommands = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const device_id = req.query.device_id as string | undefined;
    const status = req.query.status as string | undefined;
    const command_type = req.query.command_type as string | undefined;
    const { offset, limit: safeLimit } = paginate(page, limit);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (device_id) {
      conditions.push(`ac.device_id = $${paramIndex}`);
      params.push(device_id);
      paramIndex++;
    }

    if (status) {
      conditions.push(`ac.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (command_type) {
      conditions.push(`ac.command_type = $${paramIndex}`);
      params.push(command_type);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(
      `SELECT COUNT(*)::int as total FROM agent_commands ac ${whereClause}`,
      params
    );

    const result = await query(
      `SELECT ac.id, ac.command_type, ac.command_data, ac.status, ac.created_at,
              ac.sent_at, ac.completed_at, ac.error_message,
              d.agent_id, d.hostname,
              u.first_name, u.last_name
       FROM agent_commands ac
       JOIN devices d ON ac.device_id = d.id
       LEFT JOIN users u ON ac.created_by = u.id
       ${whereClause}
       ORDER BY ac.created_at DESC
       OFFSET $${paramIndex} LIMIT $${paramIndex + 1}`,
      [...params, offset, safeLimit]
    );

    res.json({
      success: true,
      data: {
        commands: result.rows,
        pagination: {
          page,
          limit: safeLimit,
          total: countResult.rows[0].total,
          totalPages: Math.ceil(countResult.rows[0].total / safeLimit),
        },
      },
    });
  } catch (error) {
    logger.error('Get commands error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getCommand = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await query(
      `SELECT ac.*, d.agent_id, d.hostname, u.first_name, u.last_name
       FROM agent_commands ac
       JOIN devices d ON ac.device_id = d.id
       LEFT JOIN users u ON ac.created_by = u.id
       WHERE ac.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Command not found.', code: 'COMMAND_NOT_FOUND' },
      });
      return;
    }

    res.json({ success: true, data: { command: result.rows[0] } });
  } catch (error) {
    logger.error('Get command error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const cancelCommand = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const existingResult = await query(
      `SELECT id, status FROM agent_commands WHERE id = $1`,
      [id]
    );

    if (existingResult.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Command not found.', code: 'COMMAND_NOT_FOUND' },
      });
      return;
    }

    if (existingResult.rows[0].status !== 'pending') {
      res.status(409).json({
        success: false,
        error: {
          message: `Cannot cancel command with status '${existingResult.rows[0].status}'. Only pending commands can be cancelled.`,
          code: 'COMMAND_NOT_CANCELLABLE',
        },
      });
      return;
    }

    const result = await query(
      `UPDATE agent_commands
       SET status = 'failed',
           error_message = $1,
           completed_at = NOW()
       WHERE id = $2
       RETURNING id, command_type, status, error_message, completed_at`,
      [reason || 'Cancelled by user', id]
    );

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'cancel_command', 'command', $2, $3, $4)`,
      [req.user?.id || null, id, JSON.stringify({ reason }), req.ip]
    );

    logger.info('Command cancelled', { commandId: id, userId: req.user?.id });

    res.json({ success: true, data: { command: result.rows[0] } });
  } catch (error) {
    logger.error('Cancel command error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

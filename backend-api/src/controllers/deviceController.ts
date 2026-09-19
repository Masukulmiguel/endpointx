import { Response, NextFunction } from 'express';
import pool, { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';
import { paginate, sanitizeString } from '../utils/helpers';
import { io } from '../index';

export const registerDevice = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { agent_id, hostname, os_type, os_version, ip_address } = req.body;

    if (!agent_id) {
      res.status(400).json({
        success: false,
        error: { message: 'agent_id is required.', code: 'VALIDATION_ERROR' },
      });
      return;
    }

    const existingResult = await query('SELECT id, status FROM devices WHERE agent_id = $1', [agent_id]);

    if (existingResult.rows.length > 0) {
      const device = existingResult.rows[0];
      await query(
        `UPDATE devices SET status = 'online', last_heartbeat = NOW(), updated_at = NOW() WHERE id = $1`,
        [device.id]
      );

      logger.info('Device re-registered', { deviceId: device.id, agent_id });

      res.json({
        success: true,
        data: { id: device.id, agent_id, status: 'online', is_new: false },
      });
      return;
    }

    const result = await query(
      `INSERT INTO devices (agent_id, hostname, os_type, os_version, ip_address, status, last_heartbeat, is_authorized)
       VALUES ($1, $2, $3, $4, $5, 'online', NOW(), true)
       RETURNING id, agent_id, status, created_at`,
      [
        sanitizeString(agent_id),
        sanitizeString(hostname || ''),
        sanitizeString(os_type || 'unknown'),
        sanitizeString(os_version || ''),
        ip_address || null,
      ]
    );

    const newDevice = result.rows[0];

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'register_device', 'device', $2, $3, $4)`,
      [
        req.user?.id || null,
        newDevice.id,
        JSON.stringify({ agent_id, hostname, os_type, os_version }),
        req.ip,
      ]
    );

    logger.info('New device registered', { deviceId: newDevice.id, agent_id });

    res.status(201).json({
      success: true,
      data: { id: newDevice.id, agent_id, status: 'online', is_new: true },
    });
  } catch (error) {
    logger.error('Register device error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const heartbeat = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { agent_id, metrics } = req.body;

    if (!agent_id) {
      res.status(400).json({
        success: false,
        error: { message: 'agent_id is required.', code: 'VALIDATION_ERROR' },
      });
      return;
    }

    const deviceResult = await query(
      `UPDATE devices
       SET status = 'online', last_heartbeat = NOW(), updated_at = NOW()
       WHERE agent_id = $1 AND is_authorized = true
       RETURNING id, agent_id`,
      [agent_id]
    );

    if (deviceResult.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Device not found or not authorized.', code: 'DEVICE_NOT_FOUND' },
      });
      return;
    }

    const device = deviceResult.rows[0];

    if (metrics) {
      await query(
        `INSERT INTO device_heartbeats (device_id, cpu_usage, memory_usage, disk_usage, network_in, network_out, uptime_seconds, custom_metrics)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          device.id,
          metrics.cpu_usage ?? null,
          metrics.memory_usage ?? null,
          metrics.disk_usage ?? null,
          metrics.network_in ?? null,
          metrics.network_out ?? null,
          metrics.uptime_seconds ?? null,
          metrics.custom ? JSON.stringify(metrics.custom) : null,
        ]
      );

      if (metrics.cpu_usage !== undefined) {
        await query(
          `INSERT INTO device_metrics_history (device_id, metric_name, metric_value)
           VALUES ($1, 'cpu_usage', $2),
                  ($1, 'memory_usage', $3),
                  ($1, 'disk_usage', $4)
           ON CONFLICT DO NOTHING`,
          [device.id, metrics.cpu_usage ?? 0, metrics.memory_usage ?? 0, metrics.disk_usage ?? 0]
        );
      }
    }

    const commandsResult = await query(
      `SELECT id, command_type, command_data
       FROM agent_commands
       WHERE device_id = $1 AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT 10`,
      [device.id]
    );

    if (commandsResult.rows.length > 0) {
      const commandIds = commandsResult.rows.map((c: any) => c.id);
      await query(
        `UPDATE agent_commands SET status = 'sent', sent_at = NOW() WHERE id = ANY($1::uuid[])`,
        [commandIds]
      );
    }

    io.to(`device:${device.id}`).emit('heartbeat', {
      device_id: device.id,
      agent_id,
      metrics,
      timestamp: new Date().toISOString(),
    });

    logger.debug('Heartbeat received', { deviceId: device.id, agent_id });

    res.json({
      success: true,
      data: {
        device_id: device.id,
        commands: commandsResult.rows.map((c: any) => ({
          id: c.id,
          command_type: c.command_type,
          command_data: c.command_data,
        })),
      },
    });
  } catch (error) {
    logger.error('Heartbeat error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getDevices = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const os_type = req.query.os_type as string | undefined;
    const { offset, limit: safeLimit } = paginate(page, limit);

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      conditions.push(`(d.hostname ILIKE $${paramIndex} OR d.agent_id ILIKE $${paramIndex} OR d.ip_address ILIKE $${paramIndex})`);
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (status) {
      conditions.push(`d.status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (os_type) {
      conditions.push(`d.os_type = $${paramIndex}`);
      params.push(os_type);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await query(
      `SELECT COUNT(*)::int as total FROM devices d ${whereClause}`,
      params
    );
    const total = countResult.rows[0].total;

    const result = await query(
      `SELECT d.id, d.agent_id, d.hostname, d.os_type, d.os_version, d.ip_address,
              d.status, d.is_authorized, d.last_heartbeat, d.created_at, d.updated_at,
              u.id as user_id, u.first_name, u.last_name, u.email as user_email
       FROM devices d
       LEFT JOIN users u ON d.user_id = u.id
       ${whereClause}
       ORDER BY d.last_heartbeat DESC NULLS LAST
       OFFSET $${paramIndex} LIMIT $${paramIndex + 1}`,
      [...params, offset, safeLimit]
    );

    res.json({
      success: true,
      data: {
        devices: result.rows,
        pagination: {
          page,
          limit: safeLimit,
          total,
          totalPages: Math.ceil(total / safeLimit),
        },
      },
    });
  } catch (error) {
    logger.error('Get devices error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getDevice = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const deviceResult = await query(
      `SELECT d.*, u.id as user_id, u.first_name, u.last_name, u.email as user_email
       FROM devices d
       LEFT JOIN users u ON d.user_id = u.id
       WHERE d.id = $1`,
      [id]
    );

    if (deviceResult.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Device not found.', code: 'DEVICE_NOT_FOUND' },
      });
      return;
    }

    const device = deviceResult.rows[0];

    const [softwareResult, servicesResult, processesResult, networkResult, heartbeatsResult, securityResult] =
      await Promise.all([
        query('SELECT * FROM device_software WHERE device_id = $1 ORDER BY installed_at DESC', [id]),
        query('SELECT * FROM device_services WHERE device_id = $1 ORDER BY name', [id]),
        query('SELECT * FROM device_processes WHERE device_id = $1 ORDER BY cpu_usage DESC LIMIT 50', [id]),
        query('SELECT * FROM device_network_interfaces WHERE device_id = $1', [id]),
        query(
          `SELECT id, cpu_usage, memory_usage, disk_usage, network_in, network_out, uptime_seconds, created_at
           FROM device_heartbeats WHERE device_id = $1 ORDER BY created_at DESC LIMIT 24`,
          [id]
        ),
        query(
          `SELECT * FROM security_events
           WHERE device_id = $1
           ORDER BY created_at DESC LIMIT 10`,
          [id]
        ),
      ]);

    res.json({
      success: true,
      data: {
        device: {
          ...device,
          software: softwareResult.rows,
          services: servicesResult.rows,
          processes: processesResult.rows,
          network_interfaces: networkResult.rows,
          recent_heartbeats: heartbeatsResult.rows,
          recent_security_events: securityResult.rows,
        },
      },
    });
  } catch (error) {
    logger.error('Get device error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const updateDevice = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const { display_name, user_id, notes, is_authorized } = req.body;

    const result = await query(
      `UPDATE devices
       SET display_name = COALESCE($1, display_name),
           user_id = COALESCE($2, user_id),
           notes = COALESCE($3, notes),
           is_authorized = COALESCE($4, is_authorized),
           updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [display_name ?? null, user_id ?? null, notes ?? null, is_authorized ?? null, id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Device not found.', code: 'DEVICE_NOT_FOUND' },
      });
      return;
    }

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'update_device', 'device', $2, $3, $4)`,
      [
        req.user?.id || null,
        id,
        JSON.stringify({ display_name, user_id, notes, is_authorized }),
        req.ip,
      ]
    );

    logger.info('Device updated', { deviceId: id, userId: req.user?.id });

    res.json({ success: true, data: { device: result.rows[0] } });
  } catch (error) {
    logger.error('Update device error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const deleteDevice = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const existingDevice = await query('SELECT id, agent_id FROM devices WHERE id = $1', [id]);
    if (existingDevice.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Device not found.', code: 'DEVICE_NOT_FOUND' },
      });
      return;
    }

    const device = existingDevice.rows[0];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query('DELETE FROM device_heartbeats WHERE device_id = $1', [id]);
      await client.query('DELETE FROM device_software WHERE device_id = $1', [id]);
      await client.query('DELETE FROM device_services WHERE device_id = $1', [id]);
      await client.query('DELETE FROM device_processes WHERE device_id = $1', [id]);
      await client.query('DELETE FROM device_network_interfaces WHERE device_id = $1', [id]);
      await client.query('DELETE FROM security_events WHERE device_id = $1', [id]);
      await client.query('DELETE FROM agent_commands WHERE device_id = $1', [id]);
      await client.query('DELETE FROM alerts WHERE device_id = $1', [id]);
      await client.query('DELETE FROM devices WHERE id = $1', [id]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'delete_device', 'device', $2, $3, $4)`,
      [req.user?.id || null, id, JSON.stringify({ agent_id: device.agent_id }), req.ip]
    );

    logger.info('Device deleted', { deviceId: id, agent_id: device.agent_id });

    res.json({ success: true, data: { message: 'Device deleted successfully.' } });
  } catch (error) {
    logger.error('Delete device error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const blockDevice = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await query(
      `UPDATE devices SET status = 'blocked', updated_at = NOW() WHERE id = $1 RETURNING id, agent_id, status`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Device not found.', code: 'DEVICE_NOT_FOUND' },
      });
      return;
    }

    const device = result.rows[0];

    await query(
      `INSERT INTO agent_commands (device_id, command_type, command_data, created_by)
       VALUES ($1, 'block', '{}', $2)`,
      [id, req.user?.id || null]
    );

    io.to(`device:${id}`).emit('command', {
      command_type: 'block',
      device_id: id,
      timestamp: new Date().toISOString(),
    });

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'block_device', 'device', $2, $3, $4)`,
      [req.user?.id || null, id, JSON.stringify({ agent_id: device.agent_id }), req.ip]
    );

    logger.info('Device blocked', { deviceId: id, agent_id: device.agent_id });

    res.json({ success: true, data: { device: result.rows[0] } });
  } catch (error) {
    logger.error('Block device error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const unblockDevice = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await query(
      `UPDATE devices SET status = 'online', updated_at = NOW() WHERE id = $1 RETURNING id, agent_id, status`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Device not found.', code: 'DEVICE_NOT_FOUND' },
      });
      return;
    }

    const device = result.rows[0];

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'unblock_device', 'device', $2, $3, $4)`,
      [req.user?.id || null, id, JSON.stringify({ agent_id: device.agent_id }), req.ip]
    );

    logger.info('Device unblocked', { deviceId: id, agent_id: device.agent_id });

    res.json({ success: true, data: { device: result.rows[0] } });
  } catch (error) {
    logger.error('Unblock device error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const quarantineDevice = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;

    const result = await query(
      `UPDATE devices SET status = 'quarantine', updated_at = NOW() WHERE id = $1 RETURNING id, agent_id, status`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: 'Device not found.', code: 'DEVICE_NOT_FOUND' },
      });
      return;
    }

    const device = result.rows[0];

    await query(
      `INSERT INTO agent_commands (device_id, command_type, command_data, created_by)
       VALUES ($1, 'quarantine', '{}', $2)`,
      [id, req.user?.id || null]
    );

    io.to(`device:${id}`).emit('command', {
      command_type: 'quarantine',
      device_id: id,
      timestamp: new Date().toISOString(),
    });

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'quarantine_device', 'device', $2, $3, $4)`,
      [req.user?.id || null, id, JSON.stringify({ agent_id: device.agent_id }), req.ip]
    );

    logger.info('Device quarantined', { deviceId: id, agent_id: device.agent_id });

    res.json({ success: true, data: { device: result.rows[0] } });
  } catch (error) {
    logger.error('Quarantine device error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const getDeviceHistory = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;
    const { offset, limit: safeLimit } = paginate(page, limit);

    const conditions: string[] = ['dh.device_id = $1'];
    const params: any[] = [id];
    let paramIndex = 2;

    if (from) {
      conditions.push(`dh.created_at >= $${paramIndex}`);
      params.push(from);
      paramIndex++;
    }

    if (to) {
      conditions.push(`dh.created_at <= $${paramIndex}`);
      params.push(to);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    const countResult = await query(
      `SELECT COUNT(*)::int as total FROM device_heartbeats dh WHERE ${whereClause}`,
      params
    );

    const result = await query(
      `SELECT dh.*
       FROM device_heartbeats dh
       WHERE ${whereClause}
       ORDER BY dh.created_at DESC
       OFFSET $${paramIndex} LIMIT $${paramIndex + 1}`,
      [...params, offset, safeLimit]
    );

    res.json({
      success: true,
      data: {
        heartbeats: result.rows,
        pagination: {
          page,
          limit: safeLimit,
          total: countResult.rows[0].total,
          totalPages: Math.ceil(countResult.rows[0].total / safeLimit),
        },
      },
    });
  } catch (error) {
    logger.error('Get device history error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

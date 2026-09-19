import { Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';

export const getSettings = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const result = await query(
      `SELECT id, key, value, description, category, updated_at
       FROM app_settings
       ORDER BY category, key`
    );

    const grouped = result.rows.reduce((acc: Record<string, any[]>, setting: any) => {
      if (!acc[setting.category]) {
        acc[setting.category] = [];
      }
      acc[setting.category].push({
        id: setting.id,
        key: setting.key,
        value: setting.value,
        description: setting.description,
        updated_at: setting.updated_at,
      });
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        settings: result.rows,
        grouped,
        categories: Object.keys(grouped),
      },
    });
  } catch (error) {
    logger.error('Get settings error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const updateSetting = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined || value === null) {
      res.status(400).json({
        success: false,
        error: { message: 'Value is required.', code: 'VALIDATION_ERROR' },
      });
      return;
    }

    const result = await query(
      `UPDATE app_settings
       SET value = $1, updated_at = NOW()
       WHERE key = $2
       RETURNING id, key, value, description, category, updated_at`,
      [typeof value === 'string' ? value : JSON.stringify(value), key]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        success: false,
        error: { message: `Setting '${key}' not found.`, code: 'SETTING_NOT_FOUND' },
      });
      return;
    }

    await query(
      `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
       VALUES ($1, 'update_setting', 'setting', $2, $3, $4)`,
      [
        req.user?.id || null,
        result.rows[0].id,
        JSON.stringify({ key, old_value: result.rows[0].value, new_value: value }),
        req.ip,
      ]
    );

    logger.info('Setting updated', { settingKey: key, userId: req.user?.id });

    res.json({ success: true, data: { setting: result.rows[0] } });
  } catch (error) {
    logger.error('Update setting error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

export const bulkUpdateSettings = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { settings } = req.body;

    if (!Array.isArray(settings) || settings.length === 0) {
      res.status(400).json({
        success: false,
        error: { message: 'settings array is required and must not be empty.', code: 'VALIDATION_ERROR' },
      });
      return;
    }

    const updated: any[] = [];
    const notFound: string[] = [];

    for (const item of settings) {
      if (!item.key || item.value === undefined) {
        continue;
      }

      const result = await query(
        `UPDATE app_settings
         SET value = $1, updated_at = NOW()
         WHERE key = $2
         RETURNING id, key, value, description, category, updated_at`,
        [typeof item.value === 'string' ? item.value : JSON.stringify(item.value), item.key]
      );

      if (result.rows.length > 0) {
        updated.push(result.rows[0]);
      } else {
        notFound.push(item.key);
      }
    }

    if (updated.length > 0) {
      await query(
        `INSERT INTO audit_logs (user_id, action, target_type, target_id, details, ip_address)
         VALUES ($1, 'bulk_update_settings', 'setting', $2, $3, $4)`,
        [
          req.user?.id || null,
          null,
          JSON.stringify({
            updated_keys: updated.map((s) => s.key),
            not_found_keys: notFound,
          }),
          req.ip,
        ]
      );
    }

    logger.info('Bulk settings updated', {
      userId: req.user?.id,
      updatedCount: updated.length,
      notFoundCount: notFound.length,
    });

    res.json({
      success: true,
      data: {
        updated,
        not_found: notFound,
      },
    });
  } catch (error) {
    logger.error('Bulk update settings error', { error: (error as Error).message, stack: (error as Error).stack });
    next(error);
  }
};

import { Router, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

const ALLOWED_COMMAND_TYPES = [
  'reboot',
  'shutdown',
  'lock',
  'unlock',
  'inventory',
  'update_agent',
  'scan',
  'get_info',
  'uninstall_agent',
  'isolate',
  'unisolate',
  'quarantine',
];

// List commands
router.get('/', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query('SELECT ac.*, d.hostname FROM agent_commands ac LEFT JOIN devices d ON ac.device_id = d.id ORDER BY ac.created_at DESC LIMIT 100', []);
    res.json({ success: true, data: { commands: result.rows } });
  } catch (error) { next(error); }
});

// Execute command
router.post('/', authenticate, requirePermission('devices.commands'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { device_id, command_type, parameters } = req.body;
    if (!device_id || !command_type) {
      res.status(400).json({ success: false, error: { message: 'device_id and command_type required' } });
      return;
    }

    if (!ALLOWED_COMMAND_TYPES.includes(command_type)) {
      res.status(400).json({ success: false, error: { message: `Invalid command type: ${command_type}` } });
      return;
    }

    // Require admin role for uninstall_agent
    if (command_type === 'uninstall_agent') {
      if (req.user?.role_name !== 'admin' && req.user?.role_id !== '1') {
        res.status(403).json({
          success: false,
          error: { message: 'Only administrators can issue uninstall_agent commands' },
        });
        return;
      }
    }

    const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

    // Build command parameters, adding HMAC signature for uninstall_agent
    let finalParams = { ...(parameters || {}) };
    if (command_type === 'uninstall_agent') {
      const agentSecret = process.env.AGENT_SECRET || '';
      // Look up the device's agent_id for the HMAC
      const deviceResult = await query('SELECT agent_id FROM devices WHERE id = $1', [device_id]);
      const agentId = deviceResult.rows[0]?.agent_id || '';
      const message = `${agentId}:${command_type}`;
      const signature = crypto.createHmac('sha256', agentSecret).update(message).digest('hex');
      finalParams.signature = signature;
    }

    await query('INSERT INTO agent_commands (id, device_id, command_type, parameters, status, issued_by) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, device_id, command_type, JSON.stringify(finalParams), 'pending', req.user?.id]);

    await query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'command_execute', 'device', device_id, `Command: ${command_type}`, req.ip]);

    res.status(201).json({ success: true, data: { id, command_type, status: 'pending' } });
  } catch (error) { next(error); }
});

// Get single command
router.get('/:id', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query('SELECT * FROM agent_commands WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Command not found' } }); return; }
    res.json({ success: true, data: { command: result.rows[0] } });
  } catch (error) { next(error); }
});

// Cancel command
router.post('/:id/cancel', authenticate, requirePermission('devices.commands'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await query("UPDATE agent_commands SET status = 'failed' WHERE id = $1 AND status = 'pending'", [req.params.id]);
    res.json({ success: true, data: { message: 'Command cancelled' } });
  } catch (error) { next(error); }
});

export default router;

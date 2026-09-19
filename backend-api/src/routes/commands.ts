import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

// List commands
router.get('/', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = query('SELECT ac.*, d.hostname FROM agent_commands ac LEFT JOIN devices d ON ac.device_id = d.id ORDER BY ac.created_at DESC LIMIT 100', []);
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
    const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    query('INSERT INTO agent_commands (id, device_id, command_type, parameters, status, issued_by) VALUES (?, ?, ?, ?, ?, ?)',
      [id, device_id, command_type, JSON.stringify(parameters || {}), 'pending', req.user?.id]);

    query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), req.user?.id, req.user?.email, 'command_execute', 'device', device_id, `Command: ${command_type}`, req.ip]);

    res.status(201).json({ success: true, data: { id, command_type, status: 'pending' } });
  } catch (error) { next(error); }
});

// Get single command
router.get('/:id', authenticate, requirePermission('devices.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = query('SELECT * FROM agent_commands WHERE id = ?', [req.params.id]);
    if (result.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'Command not found' } }); return; }
    res.json({ success: true, data: { command: result.rows[0] } });
  } catch (error) { next(error); }
});

// Cancel command
router.post('/:id/cancel', authenticate, requirePermission('devices.commands'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    query("UPDATE agent_commands SET status = 'failed' WHERE id = ? AND status = 'pending'", [req.params.id]);
    res.json({ success: true, data: { message: 'Command cancelled' } });
  } catch (error) { next(error); }
});

export default router;

import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';

const router = Router();

router.get('/', authenticate, requirePermission('contacts.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const unreadOnly = req.query.unreadOnly === 'true';

    const where = unreadOnly ? ' WHERE is_read = FALSE' : '';
    const countResult = await query(`SELECT COUNT(*) as total FROM contacts${where}`, []);
    const total = Number(countResult.rows[0]?.total || 0);
    const result = await query(
      `SELECT id,name,email,message,is_read,created_at FROM contacts${where} ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({ success: true, data: { contacts: result.rows, total } });
  } catch (error) { next(error); }
});

router.patch('/:id/read', authenticate, requirePermission('contacts.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query('UPDATE contacts SET is_read = TRUE WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Contact not found' } });
      return;
    }
    res.json({ success: true, data: { contact: result.rows[0] } });
  } catch (error) { next(error); }
});

export default router;

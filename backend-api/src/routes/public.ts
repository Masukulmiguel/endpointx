import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { query } from '../config/database';
import { RATE_LIMIT } from '../config/constants';
import { validate } from '../middleware/validation';

const router = Router();

const VERSION: string = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')
).version;

const statsLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: { success: false, error: { message: 'Too many requests, please try again later.', code: 'RATE_LIMITED' } },
  standardHeaders: RATE_LIMIT.STANDARD_HEADERS,
  legacyHeaders: RATE_LIMIT.LEGACY_HEADERS,
});

const contactLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  message: { success: false, error: { message: 'Too many contact submissions, please try again later.', code: 'RATE_LIMITED' } },
  standardHeaders: RATE_LIMIT.STANDARD_HEADERS,
  legacyHeaders: RATE_LIMIT.LEGACY_HEADERS,
});

router.get('/stats', statsLimiter, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [devices, online, users, downloads] = await Promise.all([
      query('SELECT COUNT(*)::int AS count FROM devices'),
      query("SELECT COUNT(*)::int AS count FROM devices WHERE last_heartbeat > NOW() - INTERVAL '24 hours'"),
      query('SELECT COUNT(*)::int AS count FROM users'),
      query('SELECT COUNT(*)::int AS count FROM download_events'),
    ]);
    res.json({
      success: true,
      data: {
        version: VERSION,
        devices: Number(devices.rows[0]?.count),
        online: Number(online.rows[0]?.count),
        users: Number(users.rows[0]?.count),
        downloads: Number(downloads.rows[0]?.count),
        updated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

const ContactSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email(),
  message: z.string().trim().min(10).max(5000),
});

router.post('/contact', contactLimiter, validate(ContactSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, message } = req.body as z.infer<typeof ContactSchema>;
    const result = await query(
      'INSERT INTO contacts (name, email, message, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name, email, message, req.ip, req.get('user-agent') ?? '']
    );
    const id = result.rows[0].id as string;

    await query(
      'INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
        null,
        null,
        'contact_message_received',
        'contact',
        id,
        `Contact message received from ${email}`,
        req.ip,
      ]
    );

    res.status(201).json({ success: true, data: { id } });
  } catch (error) {
    next(error);
  }
});

export default router;

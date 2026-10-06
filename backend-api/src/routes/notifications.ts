import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { isSmtpConfigured, sendEmail } from '../services/emailService';
import { dispatchWebhooks } from '../services/webhookService';
import { invalidateSettingsCache } from '../services/settings';
import { checkWebhookUrl } from '../utils/webhookUrl';

const router = Router();

// List notification logs
router.get('/', authenticate, requirePermission('logs.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = (page - 1) * limit;

    const clauses: string[] = [];
    const params: unknown[] = [];
    const channel = req.query.channel as string | undefined;
    if (channel) { params.push(channel); clauses.push(`channel = $${params.length}`); }
    const status = req.query.status as string | undefined;
    if (status) { params.push(status); clauses.push(`status = $${params.length}`); }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const countResult = await query(`SELECT COUNT(*) AS total FROM notification_log ${where}`, params);
    const total = countResult.rows[0]?.total || 0;

    const result = await query(
      `SELECT * FROM notification_log ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      data: {
        notifications: result.rows,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
      }
    });
  } catch (error) { next(error); }
});

/**
 * Send a real test email.
 *
 * The previous implementation inserted a `notification_log` row marked `sent`
 * without ever contacting a mail server, so the UI reported success even with
 * SMTP completely unconfigured.
 */
router.post('/test', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ success: false, error: { message: 'A valid email address is required' } });
      return;
    }

    if (!(await isSmtpConfigured())) {
      res.status(422).json({
        success: false,
        error: {
          message:
            'SMTP is not configured. Set the SMTP host under Email Settings (or SMTP_HOST) before sending a test.',
        },
      });
      return;
    }

    const sent = await sendEmail(
      email,
      'EndpointX test notification',
      `<div style="font-family:Arial,sans-serif;max-width:600px">
         <h2 style="color:#10b981">Test notification delivered</h2>
         <p>This message was sent by EndpointX at ${new Date().toISOString()}.</p>
         <p>If you received it, automatic alert emails will work.</p>
         <hr/><p style="color:#6b7280;font-size:12px">EndpointX Notifications</p>
       </div>`
    );

    if (!sent) {
      res.status(502).json({
        success: false,
        error: { message: 'SMTP rejected the message. Check the host, port, credentials and the log below.' },
      });
      return;
    }

    res.json({ success: true, data: { message: 'Test email sent' } });
  } catch (error) { next(error); }
});

// Get notification settings
router.get('/settings', authenticate, requirePermission('settings.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      "SELECT * FROM app_settings WHERE key LIKE 'notification_%'"
    );
    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    res.json({ success: true, data: { settings } });
  } catch (error) { next(error); }
});

// Update notification settings
router.put('/settings', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      res.status(400).json({ success: false, error: { message: 'settings object is required' } });
      return;
    }

    for (const [key, value] of Object.entries(settings)) {
      const settingKey = key.startsWith('notification_') ? key : `notification_${key}`;
      await query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [settingKey, value as string]
      );
    }
    // emailService reads these at send time; drop the cache so a save takes
    // effect immediately instead of after the TTL.
    invalidateSettingsCache();

    res.json({ success: true, data: { message: 'Notification settings updated' } });
  } catch (error) { next(error); }
});

// ── Outgoing webhooks ────────────────────────────────────────────────────────

router.get('/webhooks', authenticate, requirePermission('settings.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT id, name, url, secret, events, min_severity, is_enabled,
              last_status, last_delivered_at, last_error, created_at
         FROM webhooks ORDER BY created_at DESC`
    );
    res.json({ success: true, data: { webhooks: result.rows } });
  } catch (error) { next(error); }
});

async function validateWebhook(body: any): Promise<string | null> {
  if (!body?.name || typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
  if (body.name.length > 100) return 'name must be 100 characters or fewer';
  if (!body.url || typeof body.url !== 'string') return 'url is required';
  // Rejects bad schemes, credentials, and loopback/private/link-local
  // targets — including hostnames that resolve to them (SSRF guard).
  const urlCheck = await checkWebhookUrl(body.url);
  if (!urlCheck.ok) return urlCheck.reason || 'url is not an allowed webhook target';
  if (body.min_severity && !['info', 'low', 'medium', 'high', 'critical'].includes(body.min_severity)) {
    return 'min_severity must be info, low, medium, high or critical';
  }
  return null;
}

router.post('/webhooks', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const invalid = await validateWebhook(req.body);
    if (invalid) { res.status(400).json({ success: false, error: { message: invalid } }); return; }

    const { name, url, secret = null, events = 'alert', min_severity = 'low', is_enabled = true } = req.body;
    const result = await query(
      `INSERT INTO webhooks (id, name, url, secret, events, min_severity, is_enabled, created_by, created_at, updated_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING id, name, url, events, min_severity, is_enabled, created_at`,
      [name.trim(), url, secret, events, min_severity, is_enabled !== false, req.user?.id]
    );
    res.status(201).json({ success: true, data: { webhook: result.rows[0] } });
  } catch (error) { next(error); }
});

router.put('/webhooks/:id', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const existing = await query('SELECT * FROM webhooks WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Webhook not found' } });
      return;
    }
    const merged = { ...existing.rows[0], ...req.body };
    const invalid = await validateWebhook(merged);
    if (invalid) { res.status(400).json({ success: false, error: { message: invalid } }); return; }

    // A blank secret in the payload means "keep the stored one".
    const secret = typeof req.body.secret === 'string' && req.body.secret ? req.body.secret : existing.rows[0].secret;

    const result = await query(
      `UPDATE webhooks
          SET name = $1, url = $2, secret = $3, events = $4, min_severity = $5,
              is_enabled = $6, updated_at = NOW()
        WHERE id = $7
        RETURNING id, name, url, events, min_severity, is_enabled, last_status, last_delivered_at, last_error`,
      [
        merged.name.trim(), merged.url, secret, merged.events || 'alert',
        merged.min_severity || 'low', merged.is_enabled !== false, req.params.id,
      ]
    );
    res.json({ success: true, data: { webhook: result.rows[0] } });
  } catch (error) { next(error); }
});

router.delete('/webhooks/:id', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query('DELETE FROM webhooks WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: { message: 'Webhook not found' } });
      return;
    }
    res.json({ success: true, data: { message: 'Webhook deleted' } });
  } catch (error) { next(error); }
});

// Fire a synthetic payload at one webhook so the operator can verify the URL
// and the receiver's formatting without waiting for a real alert.
router.post('/webhooks/:id/test', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const existing = await query('SELECT * FROM webhooks WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Webhook not found' } });
      return;
    }
    const webhook = existing.rows[0];

    // Stored rows can predate the guard, so re-check before fetching.
    const urlCheck = await checkWebhookUrl(webhook.url);
    if (!urlCheck.ok) {
      res.status(400).json({ success: false, error: { message: urlCheck.reason || 'url is not an allowed webhook target' } });
      return;
    }

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(webhook.secret ? { 'X-EndpointX-Signature': webhook.secret } : {}) },
      body: JSON.stringify({
        text: '[TEST] EndpointX webhook test',
        content: '[TEST] EndpointX webhook test',
        event: 'test',
        source: 'endpointx',
        timestamp: new Date().toISOString(),
        alert: {
          severity: 'info',
          title: 'EndpointX webhook test',
          message: 'If you can read this, the webhook is configured correctly.',
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    await query(
      `UPDATE webhooks SET last_status = $1, last_delivered_at = NOW(), last_error = $2, updated_at = NOW() WHERE id = $3`,
      [response.status, response.ok ? null : `HTTP ${response.status}`, webhook.id]
    );

    if (!response.ok) {
      res.status(502).json({ success: false, error: { message: `Receiver responded HTTP ${response.status}` } });
      return;
    }
    res.json({ success: true, data: { message: `Receiver responded HTTP ${response.status}` } });
  } catch (error) {
    res.status(502).json({ success: false, error: { message: (error as Error).message } });
  }
});

// Fire the real alert payload at one webhook (exercises severity filtering).
router.post('/webhooks/:id/ping', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const existing = await query('SELECT id FROM webhooks WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Webhook not found' } });
      return;
    }
    await dispatchWebhooks('alert', {
      severity: 'medium',
      title: 'EndpointX alert pipeline test',
      message: 'This alert was generated manually to verify the outgoing webhook pipeline.',
      alert_type: 'test',
    });
    res.json({ success: true, data: { message: 'Payload dispatched (check last_status for the result)' } });
  } catch (error) { next(error); }
});

export default router;

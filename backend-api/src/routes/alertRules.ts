import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { evaluateAlertRules } from '../services/thresholdEngine';

const router = Router();

const METRICS = ['cpu_usage', 'ram_usage', 'disk_usage', 'offline'];
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

function validateRuleBody(body: any): string | null {
  if (!body || typeof body !== 'object') return 'Body must be an object';
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) return 'name is required';
  if (body.name.length > 150) return 'name must be 150 characters or fewer';
  if (!METRICS.includes(body.metric)) return `metric must be one of: ${METRICS.join(', ')}`;

  const threshold = Number(body.threshold);
  if (!Number.isFinite(threshold)) return 'threshold must be a number';
  if (body.metric === 'offline') {
    if (threshold < 30 || threshold > 86400) return 'offline threshold must be 30–86400 seconds';
  } else if (threshold < 0 || threshold > 100) {
    return 'usage threshold must be between 0 and 100';
  }

  if (body.severity && !SEVERITIES.includes(body.severity)) {
    return `severity must be one of: ${SEVERITIES.join(', ')}`;
  }
  const duration = Number(body.duration_minutes ?? 5);
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) {
    return 'duration_minutes must be an integer between 1 and 1440';
  }
  if (body.scope_device_ids !== undefined && body.scope_device_ids !== null) {
    if (!Array.isArray(body.scope_device_ids)) return 'scope_device_ids must be an array';
    for (const id of body.scope_device_ids) {
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return 'scope_device_ids must contain UUIDs';
    }
  }
  return null;
}

// List rules
router.get('/', authenticate, requirePermission('alerts.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT r.*,
              COALESCE(a.open_count, 0)::int AS open_alerts
         FROM alert_rules r
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS open_count FROM alerts al
            WHERE al.rule_id = r.id AND al.is_dismissed = false
         ) a ON true
        ORDER BY r.created_at ASC`
    );
    res.json({ success: true, data: { rules: result.rows } });
  } catch (error) { next(error); }
});

// Create rule
router.post('/', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const invalid = validateRuleBody(req.body);
    if (invalid) { res.status(400).json({ success: false, error: { message: invalid } }); return; }

    const {
      name, metric, threshold, severity = 'high', duration_minutes = 5,
      scope_device_ids = null, scope_group_id = null,
      enabled = true, notify_email = true, notify_webhook = true,
    } = req.body;

    const result = await query(
      `INSERT INTO alert_rules
         (name, metric, operator, threshold, duration_minutes, severity, scope_device_ids, scope_group_id,
          enabled, notify_email, notify_webhook, created_at, updated_at)
       VALUES ($1, $2, 'gte', $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       RETURNING *`,
      [
        name.trim(), metric, threshold, duration_minutes, severity,
        scope_device_ids, scope_group_id, enabled, notify_email, notify_webhook,
      ]
    );
    res.status(201).json({ success: true, data: { rule: result.rows[0] } });
  } catch (error) { next(error); }
});

// Update rule
router.put('/:id', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const existing = await query('SELECT * FROM alert_rules WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Rule not found' } });
      return;
    }

    const current = existing.rows[0];
    const merged = { ...current, ...req.body };
    const invalid = validateRuleBody(merged);
    if (invalid) { res.status(400).json({ success: false, error: { message: invalid } }); return; }

    const result = await query(
      `UPDATE alert_rules
          SET name = $1, metric = $2, threshold = $3, duration_minutes = $4, severity = $5,
              scope_device_ids = $6, scope_group_id = $7, enabled = $8,
              notify_email = $9, notify_webhook = $10, updated_at = NOW()
        WHERE id = $11
        RETURNING *`,
      [
        merged.name.trim(), merged.metric, merged.threshold, merged.duration_minutes, merged.severity,
        merged.scope_device_ids ?? null, merged.scope_group_id ?? null,
        merged.enabled !== false, merged.notify_email !== false, merged.notify_webhook !== false,
        req.params.id,
      ]
    );

    // Disabling a rule should not leave its alerts open forever.
    if (merged.enabled === false) {
      await query(
        `UPDATE alerts SET is_dismissed = true, auto_resolved_at = NOW(), dismissed_at = NOW()
          WHERE rule_id = $1 AND is_dismissed = false`,
        [req.params.id]
      );
    }

    res.json({ success: true, data: { rule: result.rows[0] } });
  } catch (error) { next(error); }
});

// Delete rule (also closes its alerts)
router.delete('/:id', authenticate, requirePermission('alerts.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await query(
      `UPDATE alerts SET is_dismissed = true, auto_resolved_at = NOW(), dismissed_at = NOW()
        WHERE rule_id = $1 AND is_dismissed = false`,
      [req.params.id]
    );
    const result = await query('DELETE FROM alert_rules WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: { message: 'Rule not found' } });
      return;
    }
    res.json({ success: true, data: { message: 'Rule deleted' } });
  } catch (error) { next(error); }
});

// Run the whole engine now (used by "Test rules" in the UI and by operators
// who do not want to wait for the next minute tick).
router.post('/evaluate', authenticate, requirePermission('alerts.manage'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await evaluateAlertRules();
    const open = await query('SELECT COUNT(*) AS count FROM alerts WHERE is_dismissed = false');
    res.json({
      success: true,
      data: { message: 'Rules evaluated', open_alerts: parseInt(String(open.rows[0]?.count || 0), 10) },
    });
  } catch (error) { next(error); }
});

export default router;

import { query } from '../config/database';
import logger from '../utils/logger';
import { autoResolveAlert, createAlert } from './alertService';
import { getSettingBool, getSettingNumber } from './settings';

/**
 * Threshold alerting engine.
 *
 * Runs once a minute, evaluates every enabled `alert_rules` row against live
 * device data, raises alerts through `createAlert` (so dedup/notification are
 * shared) and auto-resolves the alert when the condition clears — that is the
 * "re-arm" half of the lifecycle: a rule can fire again after recovery.
 *
 * Usage metrics are evaluated over the rule's `duration_minutes` window so a
 * single 600ms CPU spike does not page anyone; `offline` is evaluated against
 * `devices.last_heartbeat`.
 */

export type AlertRuleMetric = 'cpu_usage' | 'ram_usage' | 'disk_usage' | 'offline';

interface AlertRuleRow {
  id: string;
  name: string;
  metric: AlertRuleMetric;
  operator: string;
  threshold: string | number;
  duration_minutes: number;
  severity: string;
  scope_device_ids: string[] | null;
  scope_group_id: string | null;
}

const USAGE_METRICS: AlertRuleMetric[] = ['cpu_usage', 'ram_usage', 'disk_usage'];

const METRIC_COLUMN: Record<string, string> = {
  cpu_usage: 'cpu_usage',
  ram_usage: 'ram_usage',
  disk_usage: 'disk_usage',
};

function metricLabel(metric: string): string {
  return (
    {
      cpu_usage: 'CPU usage',
      ram_usage: 'RAM usage',
      disk_usage: 'Disk usage',
      offline: 'Device offline',
    }[metric] || metric
  );
}

function severityFor(metric: string): string {
  return metric === 'offline' ? 'medium' : 'high';
}

/** Devices whose usage stayed at/above the threshold across the whole window. */
async function findUsageBreaches(rule: AlertRuleRow): Promise<Array<{ id: string; hostname: string; value: number }>> {
  const column = METRIC_COLUMN[rule.metric];
  if (!column) return [];

  const threshold = Number(rule.threshold);
  const duration = Math.max(1, Number(rule.duration_minutes) || 5);
  const params: unknown[] = [threshold, String(duration)];
  const clauses: string[] = [
    `s.samples > 0`,
    `s.avg_value >= $1`,
    `s.last_sample >= NOW() - ($2 || ' minutes')::interval`,
    `d.is_authorized = true`,
  ];

  if (rule.scope_device_ids && rule.scope_device_ids.length > 0) {
    params.push(rule.scope_device_ids);
    clauses.push(`d.id = ANY($${params.length}::uuid[])`);
  }
  if (rule.scope_group_id) {
    params.push(rule.scope_group_id);
    clauses.push(
      `EXISTS (SELECT 1 FROM device_group_members m WHERE m.device_id = d.id AND m.group_id = $${params.length})`
    );
  }

  const result = await query(
    `SELECT d.id, d.hostname, s.avg_value
       FROM devices d
       JOIN LATERAL (
         SELECT AVG(h.${column})::float AS avg_value,
                COUNT(*)                AS samples,
                MAX(h.recorded_at)      AS last_sample
           FROM device_heartbeats h
          WHERE h.device_id = d.id
            AND h.${column} IS NOT NULL
            AND h.recorded_at >= NOW() - ($2 || ' minutes')::interval
       ) s ON true
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.avg_value DESC`,
    params
  );

  return result.rows.map((row) => ({
    id: row.id,
    hostname: row.hostname,
    value: Math.round(Number(row.avg_value) * 10) / 10,
  }));
}

/** Devices that have been silent longer than the rule's threshold (seconds). */
async function findOfflineDevices(rule: AlertRuleRow): Promise<Array<{ id: string; hostname: string }>> {
  const seconds = Math.max(30, Number(rule.threshold) || 300);
  const params: unknown[] = [String(seconds)];
  const clauses: string[] = [`d.is_authorized = true`, `d.status <> 'blocked'`];

  if (rule.scope_device_ids && rule.scope_device_ids.length > 0) {
    params.push(rule.scope_device_ids);
    clauses.push(`d.id = ANY($${params.length}::uuid[])`);
  }
  if (rule.scope_group_id) {
    params.push(rule.scope_group_id);
    clauses.push(
      `EXISTS (SELECT 1 FROM device_group_members m WHERE m.device_id = d.id AND m.group_id = $${params.length})`
    );
  }

  const result = await query(
    `SELECT d.id, d.hostname
       FROM devices d
      WHERE ${clauses.join(' AND ')}
        AND (d.last_heartbeat IS NULL OR d.last_heartbeat < NOW() - ($1 || ' seconds')::interval)`,
    params
  );
  return result.rows.map((row) => ({ id: row.id, hostname: row.hostname }));
}

async function evaluateRule(rule: AlertRuleRow): Promise<{ fired: number; resolved: number }> {
  const breached =
    rule.metric === 'offline'
      ? (await findOfflineDevices(rule)).map((d) => ({ ...d, value: 0 }))
      : await findUsageBreaches(rule);

  const breachedIds = new Set(breached.map((b) => b.id));
  let fired = 0;
  let resolved = 0;

  const severity = rule.severity || severityFor(rule.metric);

  for (const device of breached) {
    const dedupKey = `rule:${rule.id}:device:${device.id}`;
    const description =
      rule.metric === 'offline'
        ? `${device.hostname} has not reported a heartbeat for ${Math.round(Number(rule.threshold))}s or more (rule "${rule.name}").`
        : `${metricLabel(rule.metric)} on ${device.hostname} averaged ${device.value}% over the last ${rule.duration_minutes}m, at or above the ${rule.threshold}% threshold (rule "${rule.name}").`;

    const result = await createAlert({
      device_id: device.id,
      alert_type: `threshold_${rule.metric}`,
      severity,
      title:
        rule.metric === 'offline'
          ? `Device offline: ${device.hostname}`
          : `${metricLabel(rule.metric)} above ${rule.threshold}%`,
      description,
      dedup_key: dedupKey,
      rule_id: rule.id,
      source: 'threshold-engine',
      metadata: {
        rule_id: rule.id,
        rule_name: rule.name,
        metric: rule.metric,
        threshold: Number(rule.threshold),
        observed: device.value,
        duration_minutes: rule.duration_minutes,
      },
    });
    if (result.created) fired++;
  }

  // Re-arm: this rule had an open alert for a device that no longer breaches.
  const open = await query(
    `SELECT dedup_key, device_id FROM alerts
      WHERE rule_id = $1 AND is_dismissed = false AND dedup_key IS NOT NULL`,
    [rule.id]
  );
  for (const row of open.rows) {
    if (row.device_id && !breachedIds.has(row.device_id)) {
      await autoResolveAlert(row.dedup_key);
      resolved++;
    } else if (!row.device_id) {
      await autoResolveAlert(row.dedup_key);
      resolved++;
    }
  }

  if (fired > 0 || resolved > 0) {
    logger.info('Alert rule evaluated', { rule: rule.name, metric: rule.metric, fired, resolved });
  }

  return { fired, resolved };
}

/** Evaluate every enabled rule. Safe to call on a timer — never throws. */
export async function evaluateAlertRules(): Promise<void> {
  try {
    if (!(await getSettingBool('alerting_enabled', true))) return;

    const rules = await query(
      `SELECT id, name, metric, operator, threshold, duration_minutes, severity, scope_device_ids, scope_group_id
         FROM alert_rules
        WHERE enabled = true`
    );

    for (const rule of rules.rows as AlertRuleRow[]) {
      try {
        await evaluateRule(rule);
      } catch (error) {
        logger.error('Alert rule evaluation failed', {
          rule: rule.name,
          error: (error as Error).message,
        });
      }
    }
  } catch (error) {
    logger.error('Alert rule sweep failed', { error: (error as Error).message });
  }
}

/**
 * One-shot sweep used by the API to preview what a rule would do, and by the
 * offline-device job so a device that just went offline alerts immediately
 * instead of waiting for the next minute tick.
 */
export async function evaluateOfflineOnly(): Promise<void> {
  const rules = await query(
    `SELECT id, name, metric, operator, threshold, duration_minutes, severity, scope_device_ids, scope_group_id
       FROM alert_rules WHERE enabled = true AND metric = 'offline'`
  );
  for (const rule of rules.rows as AlertRuleRow[]) {
    try {
      await evaluateRule(rule);
    } catch (error) {
      logger.error('Offline rule evaluation failed', {
        rule: rule.name,
        error: (error as Error).message,
      });
    }
  }
}

/** Default rules seeded on first boot so alerting is live out of the box. */
export const DEFAULT_ALERT_RULES: Array<Partial<AlertRuleRow> & { name: string }> = [
  {
    name: 'Sustained high CPU',
    metric: 'cpu_usage',
    operator: 'gte',
    threshold: 90,
    duration_minutes: 5,
    severity: 'high',
  },
  {
    name: 'Sustained high memory',
    metric: 'ram_usage',
    operator: 'gte',
    threshold: 90,
    duration_minutes: 5,
    severity: 'high',
  },
  {
    name: 'Disk nearly full',
    metric: 'disk_usage',
    operator: 'gte',
    threshold: 90,
    duration_minutes: 5,
    severity: 'critical',
  },
  {
    name: 'Device offline',
    metric: 'offline',
    operator: 'gte',
    threshold: 300,
    duration_minutes: 5,
    severity: 'medium',
  },
];

/** Idempotent: inserts the default rules only when the table is empty. */
export async function seedDefaultAlertRules(): Promise<void> {
  try {
    const count = await query('SELECT COUNT(*) AS count FROM alert_rules');
    if (parseInt(String(count.rows[0]?.count || 0), 10) > 0) return;

    for (const rule of DEFAULT_ALERT_RULES) {
      await query(
        `INSERT INTO alert_rules (name, metric, operator, threshold, duration_minutes, severity, enabled, notify_email, notify_webhook, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, true, true, true, NOW(), NOW())`,
        [rule.name, rule.metric, rule.operator, rule.threshold, rule.duration_minutes, rule.severity]
      );
    }
    logger.info('Seeded default alert rules', { count: DEFAULT_ALERT_RULES.length });
  } catch (error) {
    logger.warn('Failed to seed alert rules', { error: (error as Error).message });
  }
}

/** Interval between evaluations, from settings (default 60s). */
export async function alertEvaluationIntervalMs(): Promise<number> {
  const seconds = await getSettingNumber('alert_evaluation_interval', 60);
  return Math.max(10, seconds) * 1000;
}

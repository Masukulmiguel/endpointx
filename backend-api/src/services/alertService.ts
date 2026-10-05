import { query } from '../config/database';
import logger from '../utils/logger';
import { broadcastEvent } from '../websocket';
import { sendAlertNotification } from './emailService';
import { dispatchWebhooks } from './webhookService';

/**
 * Shared alert lifecycle.
 *
 * Every producer (threshold engine, tamper detection, security scan, brute
 * force, manual UI create, HERMES) goes through `createAlert` so that dedup,
 * acknowledgement, notification and live updates behave identically. Before
 * this existed each call site hand-rolled its own 1h dedup — or, in most
 * cases, silently sent no notification at all.
 */

export interface CreateAlertInput {
  device_id?: string | null;
  alert_type: string;
  severity: string;
  title: string;
  description?: string;
  metadata?: unknown;
  /** Stable identity for this condition; used for dedup and auto re-arm. */
  dedup_key?: string | null;
  rule_id?: string | null;
  source?: string;
  /** Minutes during which repeats of the same dedup_key are folded in. */
  dedup_window_minutes?: number;
  /** Set false to record the alert without notifying anyone. */
  notify?: boolean;
}

export interface CreateAlertResult {
  alert: Record<string, unknown>;
  created: boolean;
}

export const DEFAULT_DEDUP_WINDOW_MINUTES = 60;

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

async function loadDeviceName(deviceId?: string | null): Promise<string | undefined> {
  if (!deviceId) return undefined;
  const result = await query('SELECT hostname FROM devices WHERE id = $1', [deviceId]);
  return result.rows[0]?.hostname;
}

function alertUrl(alert: Record<string, unknown>): string | undefined {
  const appUrl = process.env.APP_URL || process.env.FRONTEND_URL || '';
  if (!appUrl || !alert.device_id) return `${appUrl}/alerts`;
  return `${appUrl}/alerts?device=${alert.device_id}`;
}

/**
 * Create an alert, folding repeats into an existing open alert that shares the
 * same dedup key inside the dedup window. Notifies only on first fire.
 */
export async function createAlert(input: CreateAlertInput): Promise<CreateAlertResult> {
  const {
    device_id = null,
    alert_type,
    severity,
    title,
    description = '',
    metadata,
    dedup_key = null,
    rule_id = null,
    source = 'system',
    dedup_window_minutes = DEFAULT_DEDUP_WINDOW_MINUTES,
    notify = true,
  } = input;

  if (dedup_key) {
    const existing = await query(
      `SELECT id FROM alerts
        WHERE dedup_key = $1 AND is_dismissed = false
          AND last_seen_at >= NOW() - ($2 || ' minutes')::interval
        ORDER BY last_seen_at DESC
        LIMIT 1`,
      [dedup_key, String(dedup_window_minutes)]
    );

      if (existing.rows.length > 0) {
      // Escalate rather than downgrade: if a repeat is more severe than the
      // original, the open alert should reflect that.
      const current = await query('SELECT severity FROM alerts WHERE id = $1', [existing.rows[0].id]);
      const currentSeverity = String(current.rows[0]?.severity || 'medium');
      const nextSeverity =
        SEVERITY_RANK[severity] > SEVERITY_RANK[currentSeverity] ? severity : currentSeverity;

      const updated = await query(
        `UPDATE alerts
            SET occurrences = occurrences + 1,
                last_seen_at = NOW(),
                severity = $2
          WHERE id = $1
          RETURNING *`,
        [existing.rows[0].id, nextSeverity]
      );
      const alert = updated.rows[0] ?? { id: existing.rows[0].id };
      return { alert, created: false };
    }
  }

  const result = await query(
    `INSERT INTO alerts
       (device_id, alert_type, severity, title, description, metadata, dedup_key, rule_id, source,
        occurrences, first_seen_at, last_seen_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, NOW(), NOW(), NOW())
     RETURNING *`,
    [
      device_id,
      alert_type,
      severity,
      title,
      description,
      metadata === undefined ? null : JSON.stringify(metadata),
      dedup_key,
      rule_id,
      source,
    ]
  );

  const alert = result.rows[0];
  await notifyAlert(alert, input);
  return { alert, created: true };
}

/** Email + webhook + live socket push for a freshly created alert. */
async function notifyAlert(alert: Record<string, unknown>, input: CreateAlertInput): Promise<void> {
  const deviceId = (alert.device_id as string | null) ?? null;
  const deviceName = await loadDeviceName(deviceId);

  const payload = {
    id: String(alert.id),
    severity: String(alert.severity),
    title: String(alert.title),
    message: String(alert.description ?? ''),
    alert_type: String(alert.alert_type),
    device_id: deviceId,
    device_name: deviceName,
    url: alertUrl(alert),
  };

  broadcastEvent('alert:new', { alert, device_name: deviceName });

  if (input.notify === false) return;

  await Promise.allSettled([
    sendAlertNotification({
      severity: payload.severity,
      title: payload.title,
      message: payload.message,
      device_id: deviceId || '',
      device_name: deviceName || '',
      alert_type: payload.alert_type,
      url: payload.url,
    }),
    dispatchWebhooks('alert', payload),
  ]);
}

/** Acknowledge: someone owns it, stop paging, but keep it open. */
export async function acknowledgeAlert(
  id: string,
  userId?: string
): Promise<Record<string, unknown> | null> {
  const result = await query(
    `UPDATE alerts
        SET acknowledged_by = $1, acknowledged_at = NOW()
      WHERE id = $2 AND is_dismissed = false
      RETURNING *`,
    [userId ?? null, id]
  );
  const alert = result.rows[0] ?? null;
  if (alert) broadcastEvent('alert:acknowledged', { alert });
  return alert;
}

/**
 * Re-arm: clear the acknowledgement so the alert surfaces again. Used when an
 * operator wants the paging chain to restart for a condition that is still on.
 */
export async function rearmAlert(id: string): Promise<Record<string, unknown> | null> {
  const result = await query(
    `UPDATE alerts
        SET acknowledged_by = NULL, acknowledged_at = NULL,
            is_dismissed = false, dismissed_by = NULL, dismissed_at = NULL,
            auto_resolved_at = NULL, occurrences = 1, last_seen_at = NOW()
      WHERE id = $2
      RETURNING *`,
    [id]
  );
  const alert = result.rows[0] ?? null;
  if (alert) broadcastEvent('alert:rearmed', { alert });
  return alert;
}

/** Resolve/dismiss manually. */
export async function dismissAlert(
  id: string,
  userId?: string
): Promise<Record<string, unknown> | null> {
  const result = await query(
    `UPDATE alerts SET is_dismissed = true, dismissed_by = $1, dismissed_at = NOW() WHERE id = $2 RETURNING *`,
    [userId ?? null, id]
  );
  const alert = result.rows[0] ?? null;
  if (alert) broadcastEvent('alert:resolved', { alert });
  return alert;
}

/**
 * Automatic re-arm: the condition cleared, so close the alert without a human
 * and let the rule fire again later. Distinct from a manual dismiss so the UI
 * can tell "it recovered" from "I ignored it".
 */
export async function autoResolveAlert(dedupKey: string): Promise<number> {
  const result = await query(
    `UPDATE alerts
        SET is_dismissed = true, auto_resolved_at = NOW(), dismissed_at = NOW()
      WHERE dedup_key = $1 AND is_dismissed = false AND auto_resolved_at IS NULL`,
    [dedupKey]
  );
  const count = result.rowCount || 0;
  if (count > 0) logger.debug('Alerts auto-resolved', { dedup_key: dedupKey, count });
  return count;
}

/**
 * Shared "has this fired in the last N minutes?" guard for producers that
 * predate `createAlert` dedup keys (brute force, agent-reported alerts).
 */
export async function hasRecentAlert(
  alertType: string,
  deviceId: string | null,
  windowMinutes: number
): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM alerts
      WHERE alert_type = $1
        AND ((device_id IS NULL AND $2::uuid IS NULL) OR device_id = $2)
        AND created_at >= NOW() - ($3 || ' minutes')::interval
      LIMIT 1`,
    [alertType, deviceId, String(windowMinutes)]
  );
  return result.rows.length > 0;
}

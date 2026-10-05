import { query } from '../config/database';
import logger from '../utils/logger';
import { getSetting } from './settings';

/**
 * Outgoing webhooks (Slack / Discord / Teams compatible).
 *
 * Every payload is a generic JSON envelope so the same webhook works for all
 * three: Slack and Teams both accept `{ text }`, Discord accepts `{ content }`,
 * and generic consumers get the full structured body under `alert`.
 */

export interface WebhookAlertPayload {
  id?: string;
  severity: string;
  title: string;
  message: string;
  alert_type?: string;
  device_id?: string | null;
  device_name?: string | null;
  url?: string;
}

export interface WebhookRecord {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  events: string | null;
  is_enabled: boolean;
  min_severity: string;
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function buildPayload(payload: WebhookAlertPayload, kind: string) {
  const text =
    `[${payload.severity.toUpperCase()}] ${payload.title}` +
    (payload.device_name ? ` — ${payload.device_name}` : '') +
    (payload.message ? `\n${payload.message}` : '');

  return {
    // Slack + Teams read `text`, Discord reads `content`.
    text,
    content: text,
    event: kind,
    source: 'endpointx',
    timestamp: new Date().toISOString(),
    alert: payload,
  };
}

async function deliverOne(record: WebhookRecord, body: string): Promise<void> {
  const timeoutMs = 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (record.secret) {
      // Slack/Discord-style signature header; harmless for receivers that ignore it.
      headers['X-EndpointX-Signature'] = record.secret;
    }

    const response = await fetch(record.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    await query(
      `UPDATE webhooks SET last_status = $1, last_delivered_at = NOW(), last_error = $2, updated_at = NOW() WHERE id = $3`,
      [response.ok ? response.status : response.status, response.ok ? null : `HTTP ${response.status}`, record.id]
    );

    if (!response.ok) {
      logger.warn('Webhook delivery failed', { webhook: record.name, status: response.status });
    }
  } catch (error) {
    const message = (error as Error).message;
    logger.warn('Webhook delivery error', { webhook: record.name, error: message });
    await query(
      `UPDATE webhooks SET last_status = NULL, last_delivered_at = NOW(), last_error = $1, updated_at = NOW() WHERE id = $2`,
      [message, record.id]
    ).catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fan an alert out to every enabled webhook whose severity threshold is met.
 * Never throws: a broken webhook must not fail the request that raised the alert.
 */
export async function dispatchWebhooks(kind: string, payload: WebhookAlertPayload): Promise<void> {
  try {
    if ((await getSetting('notifications_webhooks_enabled', 'true')) === 'false') return;

    const result = await query(
      `SELECT id, name, url, secret, events, is_enabled, min_severity FROM webhooks WHERE is_enabled = true`
    );
    if (result.rows.length === 0) return;

    const payloadRank = SEVERITY_RANK[payload.severity] ?? 0;
    const jobs: Promise<void>[] = [];

    for (const row of result.rows as WebhookRecord[]) {
      const events = (row.events || 'alert').split(',').map((e) => e.trim()).filter(Boolean);
      if (!events.includes(kind) && !events.includes('*')) continue;
      const minRank = SEVERITY_RANK[row.min_severity] ?? 0;
      if (payloadRank < minRank) continue;
      if (!row.url) continue;

      jobs.push(deliverOne(row, JSON.stringify(buildPayload(payload, kind))));
    }

    await Promise.allSettled(jobs);
  } catch (error) {
    logger.warn('Webhook dispatch failed', { error: (error as Error).message });
  }
}

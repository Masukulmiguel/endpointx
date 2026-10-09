import { query } from '../config/database';
import logger from '../utils/logger';

/**
 * Prometheus exposition format for `/metrics`.
 *
 * Deliberately a fixed, read-only snapshot: every scrape costs one small
 * aggregate query per metric family, and nothing here can mutate state.
 * The endpoint is unauthenticated like `/health` — Prometheus scrapers do not
 * hold session cookies, and no customer data leaves this surface.
 */

function escapeLabel(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

interface Sample {
  name: string;
  labels?: Record<string, string>;
  value: number;
}

interface Family {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  samples: Sample[];
}

function gauge(name: string, help: string, samples: Sample[]): Family {
  return { name, help, type: 'gauge', samples };
}

function render(family: Family): string {
  const lines = [
    `# HELP ${family.name} ${family.help}`,
    `# TYPE ${family.name} ${family.type}`,
  ];
  for (const sample of family.samples) {
    const labels = sample.labels
      ? `{${Object.entries(sample.labels)
          .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
          .join(',')}}`
      : '';
    lines.push(`${sample.name}${labels} ${sample.value}`);
  }
  return lines.join('\n');
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function renderPrometheusMetrics(): Promise<string> {
  const startedAt = process.hrtime.bigint();
  const families: Family[] = [];

  try {
    const devices = await query(
      `SELECT COALESCE(LOWER(NULLIF(status, '')), 'unknown') AS status, COUNT(*) AS c
         FROM devices GROUP BY 1`
    );
    families.push(
      gauge('endpointx_devices_total', 'Registered devices by status.', [
        { name: 'endpointx_devices_total', labels: { status: 'total' },
          value: devices.rows.reduce((sum, r) => sum + toNumber(r.c), 0) },
        ...devices.rows.map((r) => ({
          name: 'endpointx_devices_total',
          labels: { status: String(r.status) },
          value: toNumber(r.c),
        })),
      ])
    );

    const heartbeat = await query(
      `SELECT
         COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '5 minutes') AS online,
         COUNT(*) FILTER (WHERE recorded_at > NOW() - INTERVAL '15 minutes') AS recent,
         COUNT(*) AS total
       FROM device_heartbeats`
    );
    const hb = heartbeat.rows[0] || {};
    families.push(
      gauge('endpointx_heartbeats', 'Heartbeat rows by recency window.', [
        { name: 'endpointx_heartbeats', labels: { window: '5m' }, value: toNumber(hb.online) },
        { name: 'endpointx_heartbeats', labels: { window: '15m' }, value: toNumber(hb.recent) },
        { name: 'endpointx_heartbeats', labels: { window: 'all' }, value: toNumber(hb.total) },
      ])
    );

    // `alerts` has no status column: "open" means not dismissed, split out by
    // whether a human has acknowledged it yet.
    const openAlerts = await query(
      `SELECT COALESCE(severity, 'unknown') AS severity,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE acknowledged_at IS NULL) AS unacknowledged
         FROM alerts
        WHERE is_dismissed = false
        GROUP BY 1`
    );
    families.push(
      gauge('endpointx_alerts_open', 'Alerts that have not been dismissed, by severity.', [
        ...openAlerts.rows.map((r) => ({
          name: 'endpointx_alerts_open',
          labels: { severity: String(r.severity) },
          value: toNumber(r.total),
        })),
        { name: 'endpointx_alerts_open', labels: { severity: 'total' },
          value: openAlerts.rows.reduce((sum, r) => sum + toNumber(r.total), 0) },
      ])
    );
    families.push(
      gauge('endpointx_alerts_unacknowledged', 'Open alerts nobody has acknowledged, by severity.', [
        ...openAlerts.rows.map((r) => ({
          name: 'endpointx_alerts_unacknowledged',
          labels: { severity: String(r.severity) },
          value: toNumber(r.unacknowledged),
        })),
        { name: 'endpointx_alerts_unacknowledged', labels: { severity: 'total' },
          value: openAlerts.rows.reduce((sum, r) => sum + toNumber(r.unacknowledged), 0) },
      ])
    );

    const recentAlerts = await query(
      `SELECT COUNT(*) AS c FROM alerts WHERE created_at > NOW() - INTERVAL '24 hours'`
    );
    families.push(
      gauge('endpointx_alerts_created_24h', 'Alerts created in the last 24 hours.', [
        { name: 'endpointx_alerts_created_24h', value: toNumber(recentAlerts.rows[0]?.c) },
      ])
    );

    const ruleState = await query(
      `SELECT
         COUNT(*) FILTER (WHERE enabled) AS enabled,
         COUNT(*) AS total
       FROM alert_rules`
    );
    families.push(
      gauge('endpointx_alert_rules', 'Alert rules by enabled state.', [
        { name: 'endpointx_alert_rules', labels: { state: 'enabled' }, value: toNumber(ruleState.rows[0]?.enabled) },
        { name: 'endpointx_alert_rules', labels: { state: 'total' }, value: toNumber(ruleState.rows[0]?.total) },
      ])
    );

    const findings = await query(
      `SELECT COALESCE(severity, 'unknown') AS severity, COUNT(*) AS c
         FROM hermes_findings WHERE status = 'open' GROUP BY 1`
    );
    families.push(
      gauge('endpointx_hermes_findings_open', 'Open HERMES findings by severity.', [
        ...findings.rows.map((r) => ({
          name: 'endpointx_hermes_findings_open',
          labels: { severity: String(r.severity) },
          value: toNumber(r.c),
        })),
        { name: 'endpointx_hermes_findings_open', labels: { severity: 'total' },
          value: findings.rows.reduce((sum, r) => sum + toNumber(r.c), 0) },
      ])
    );

    const scans = await query(
      `SELECT COALESCE(NULLIF(status, ''), 'unknown') AS status, COUNT(*) AS c
         FROM hermes_scans GROUP BY 1`
    );
    families.push(
      gauge('endpointx_hermes_scans', 'HERMES scans by status.', [
        ...scans.rows.map((r) => ({
          name: 'endpointx_hermes_scans',
          labels: { status: String(r.status) },
          value: toNumber(r.c),
        })),
      ])
    );

    const users = await query(
      `SELECT COUNT(*) FILTER (WHERE is_active) AS active, COUNT(*) AS total FROM users`
    );
    families.push(
      gauge('endpointx_users', 'Registered console users.', [
        { name: 'endpointx_users', labels: { state: 'active' }, value: toNumber(users.rows[0]?.active) },
        { name: 'endpointx_users', labels: { state: 'total' }, value: toNumber(users.rows[0]?.total) },
      ])
    );

    const webhooks = await query(
      `SELECT COUNT(*) FILTER (WHERE is_enabled) AS enabled, COUNT(*) AS total FROM webhooks`
    );
    families.push(
      gauge('endpointx_webhooks', 'Outbound webhook integrations.', [
        { name: 'endpointx_webhooks', labels: { state: 'enabled' }, value: toNumber(webhooks.rows[0]?.enabled) },
        { name: 'endpointx_webhooks', labels: { state: 'total' }, value: toNumber(webhooks.rows[0]?.total) },
      ])
    );

    const feed = await query(
      `SELECT COUNT(*) AS c, MAX(fetched_at) AS last_fetch FROM hermes_cves`
    );
    const feedRows = feed.rows[0] || {};
    families.push(
      gauge('endpointx_cve_feed_size', 'CVEs in the local knowledge base.', [
        { name: 'endpointx_cve_feed_size', value: toNumber(feedRows.c) },
      ])
    );
    const lastFetch = feedRows.last_fetch ? new Date(feedRows.last_fetch).getTime() : 0;
    families.push(
      gauge('endpointx_cve_feed_last_sync_timestamp_seconds', 'Unix time of the last CVE feed write.', [
        { name: 'endpointx_cve_feed_last_sync_timestamp_seconds',
          value: lastFetch ? Math.floor(lastFetch / 1000) : 0 },
      ])
    );

    const rollups = await query(
      `SELECT bucket_size, COUNT(*) AS c FROM metric_rollups GROUP BY 1`
    );
    families.push(
      gauge('endpointx_metric_rollups', 'Rows in metric_rollups by bucket size.', [
        ...rollups.rows.map((r) => ({
          name: 'endpointx_metric_rollups',
          labels: { bucket: String(r.bucket_size) },
          value: toNumber(r.c),
        })),
      ])
    );
  } catch (error) {
    logger.error('Prometheus scrape failed', { error: (error as Error).message });
  }

  const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  families.push(
    gauge('endpointx_scrape_duration_seconds', 'Time taken to render this scrape.', [
      { name: 'endpointx_scrape_duration_seconds', value: durationSeconds },
    ])
  );
  families.push(
    gauge('endpointx_build_info', 'Build information for this EndpointX process.', [
      { name: 'endpointx_build_info', labels: { version: process.env.npm_package_version || '1.3.0', node: process.version }, value: 1 },
    ])
  );

  return `${families.map(render).join('\n')}\n`;
}

import { query } from './config/database';
import net from 'net';
import logger from './utils/logger';
import { getSettingBool, getSettingNumber, setSetting } from './services/settings';
import { updateOfflineDevices } from './routes/devices';
import {
  alertEvaluationIntervalMs,
  evaluateAlertRules,
  evaluateOfflineOnly,
  seedDefaultAlertRules,
} from './services/thresholdEngine';
import { refreshCveFeed } from './services/cveFeed';
import { startScheduledScan } from './routes/hermes';

const OFFLINE_SWEEP_MS = 60_000;
const RETENTION_SWEEP_MS = 60 * 60_000;
const ROLLUP_SWEEP_MS = 5 * 60_000;
const CVE_FEED_SWEEP_MS = 6 * 60 * 60_000;
const SCHEDULER_TICK_MS = 60_000;
const SELF_PROBE_MS = 30_000;

const timers: NodeJS.Timeout[] = [];
let running = false;
let hermesScanStartedFor: string | '';

function every(name: string, ms: number, repeat: boolean, fn: () => Promise<unknown>): void {
  const handler = async () => {
    try {
      await fn();
    } catch (error) {
      logger.error(`Background job failed: ${name}`, { error: (error as Error).message });
    }
  };
  const id = repeat ? setInterval(handler, ms) : setTimeout(handler, ms);
  timers.push(id);
}

/**
 * Hourly purge of raw telemetry older than the configured retention window.
 * Raw rows are expensive; the rollups they feed are not.
 */
async function purgeExpiredTelemetry(): Promise<void> {
  const days = retentionDays;
  const result = await query(
    `DELETE FROM device_heartbeats WHERE recorded_at < NOW() - make_interval(days => $1)`,
    [days]
  );
  const interfaces = await query(
    `DELETE FROM device_interface_metrics WHERE recorded_at < NOW() - make_interval(days => $1)`,
    [days]
  );
  const rollups = await query(
    `DELETE FROM metric_rollups WHERE bucket_size = '5m' AND bucket_start < NOW() - make_interval(days => $1)`,
    [days]
  );
  const eventLogs = await query(
    `DELETE FROM device_event_logs WHERE recorded_at < NOW() - make_interval(days => $1)`,
    [days]
  );
  const total =
    (result.rowCount || 0) +
    (interfaces.rowCount || 0) +
    (rollups.rowCount || 0) +
    (eventLogs.rowCount || 0);
  if (total > 0) {
    logger.info('Retention sweep purged expired telemetry', {
      heartbeats: result.rowCount || 0,
      interface_metrics: interfaces.rowCount || 0,
      rollups_5m: rollups.rowCount || 0,
      event_logs: eventLogs.rowCount || 0,
      retention_days: days,
    });
  }
}

let retentionDays = 90;
async function refreshRetentionCache(): Promise<void> {
  retentionDays = Math.max(1, Math.floor(await getSettingNumber('data_retention_days', 90)));
}

const BUCKETS: Array<{ size: string; seconds: number; lookbackDays: number }> = [
  { size: '5m', seconds: 300, lookbackDays: 7 },
  { size: '1h', seconds: 3600, lookbackDays: 90 },
  { size: '1d', seconds: 86400, lookbackDays: 730 },
];

/**
 * Aggregate raw heartbeats into `metric_rollups` so long-range charts stop
 * reading millions of rows. Counters (`network_in`/`network_out`) are stored
 * as the delta within the bucket, never as a cumulative total.
 */
async function buildMetricRollups(): Promise<void> {
  if (!(await getSettingBool('metric_rollup_enabled', true))) return;

  for (const bucket of BUCKETS) {
    const since = new Date(Date.now() - bucket.lookbackDays * 86_400_000);
    const agg = await query(
      `WITH base AS (
         SELECT device_id,
                recorded_at,
                cpu_usage, ram_usage, disk_usage,
                network_in, network_out,
                LAG(network_in)  OVER (PARTITION BY device_id ORDER BY recorded_at) AS prev_in,
                LAG(network_out) OVER (PARTITION BY device_id ORDER BY recorded_at) AS prev_out
           FROM device_heartbeats
          WHERE recorded_at >= $1::timestamptz - make_interval(secs => $2)
       ),
       buckets AS (
         SELECT device_id,
                to_timestamp(floor(EXTRACT(EPOCH FROM recorded_at) / $2) * $2) AS bucket_start,
                cpu_usage, ram_usage, disk_usage,
                CASE WHEN prev_in  IS NULL OR network_in  < prev_in  THEN 0 ELSE network_in  - prev_in  END AS d_in,
                CASE WHEN prev_out IS NULL OR network_out < prev_out THEN 0 ELSE network_out - prev_out END AS d_out
           FROM base
       )
       SELECT device_id,
              bucket_start,
              AVG(cpu_usage)  AS cpu_avg,
              MAX(cpu_usage)  AS cpu_max,
              AVG(ram_usage)  AS ram_avg,
              MAX(ram_usage)  AS ram_max,
              AVG(disk_usage) AS disk_avg,
              MAX(disk_usage) AS disk_max,
              SUM(d_in)       AS network_in,
              SUM(d_out)      AS network_out,
              COUNT(*)        AS samples
         FROM buckets
        WHERE bucket_start >= $1::timestamptz
        GROUP BY device_id, bucket_start`,
      [since, bucket.seconds]
    );

    for (const row of agg.rows) {
      await query(
        `INSERT INTO metric_rollups
           (device_id, bucket_size, bucket_start, cpu_avg, cpu_max, ram_avg, ram_max,
            disk_avg, disk_max, network_in, network_out, samples)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (device_id, bucket_size, bucket_start)
         DO UPDATE SET
           cpu_avg = EXCLUDED.cpu_avg, cpu_max = EXCLUDED.cpu_max,
           ram_avg = EXCLUDED.ram_avg, ram_max = EXCLUDED.ram_max,
           disk_avg = EXCLUDED.disk_avg, disk_max = EXCLUDED.disk_max,
           network_in = EXCLUDED.network_in, network_out = EXCLUDED.network_out,
           samples = EXCLUDED.samples`,
        [
          row.device_id, bucket.size, row.bucket_start,
          row.cpu_avg, row.cpu_max, row.ram_avg, row.ram_max,
          row.disk_avg, row.disk_max,
          row.network_in || 0, row.network_out || 0, row.samples,
        ]
      );
    }

    if (agg.rows.length > 0) {
      logger.debug('Metric rollups built', { bucket: bucket.size, rows: agg.rows.length });
    }
  }
}

/** Pull CVE deltas from NVD. Never lets a feed outage stop the server. */
async function syncCveFeed(): Promise<void> {
  try {
    const result = await refreshCveFeed();
    if (result.fetched > 0) {
      logger.info('CVE feed synced', { fetched: result.fetched, pages: result.pages });
    }
  } catch (error) {
    logger.warn('CVE feed sync failed', { error: (error as Error).message });
  }
}

/** Fire the daily HERMES scan once per configured UTC hour per day. */
async function maybeRunDailyHermesScan(): Promise<void> {
  if (!(await getSettingBool('hermes_daily_scan_enabled', true))) return;

  const hour = Math.min(23, Math.max(0, Math.floor(await getSettingNumber('hermes_daily_scan_hour', 3))));
  const now = new Date();
  if (now.getUTCHours() !== hour) return;

  const dayKey = now.toISOString().slice(0, 10);
  if (hermesScanStartedFor === dayKey) return;

  const alreadyRan = await query(
    `SELECT id FROM hermes_scans
      WHERE scan_type = 'daily' AND created_at >= date_trunc('day', NOW())
      LIMIT 1`
  );
  if (alreadyRan.rows.length > 0) {
    hermesScanStartedFor = dayKey;
    return;
  }

  hermesScanStartedFor = dayKey;
  await startScheduledScan('daily');
  logger.info('Scheduled daily HERMES scan started', { hour });
}

/** Re-arm the alert-evaluation timer when the interval setting changes. */
async function scheduleAlertEvaluation(): Promise<void> {
  const ms = await alertEvaluationIntervalMs();
  every('alert-evaluation', ms, true, evaluateAlertRules);
}

/**
 * Ask the three ways an HTTP request can reach this process and persist the
 * answers to app_settings.self_probe (readable from SQL when the public API
 * itself is unreachable):
 *   local - loopback straight to the app port (Express alive?),
 *   alt   - loopback to the 10000 relay (relay alive?),
 *   publik- the public https URL, which exercises Cloudflare -> Render LB ->
 *           router -> instance end to end.
 * Comparing the three localizes where the chain is broken.
 */
async function probe(url: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const body = await res.text();
    return `http=${res.status} body=${body.slice(0, 80)}`;
  } catch (error) {
    return `erro=${(error as Error).message}`;
  }
}

/**
 * Raw TCP probe without undici: connect, send a bare GET, report whatever
 * comes back. Distinguishes "connection refused" from "accepted but silence",
 * which is exactly the ambiguity the fetch probe cannot resolve.
 */
function rawProbe(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = '';
    let settled = false;
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done(`timeout sem resposta; recebido=${JSON.stringify(buf.slice(0, 160))}`), 8000);
    socket.on('connect', () => {
      socket.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length >= 20) {
        clearTimeout(timer);
        done(`resp=${JSON.stringify(buf.slice(0, 160))}`);
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      done(`erro=${error.message}`);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      done(`conexao fechada sem resposta; recebido=${JSON.stringify(buf.slice(0, 160))}`);
    });
  });
}

async function selfProbe(): Promise<void> {
  const port = parseInt(process.env.PORT || '3001', 10);
  const [local, alt, publik, raw] = await Promise.all([
    probe(`http://127.0.0.1:${port}/health`),
    probe('http://127.0.0.1:10000/health'),
    probe('https://endpointx.onrender.com/health'),
    rawProbe(port),
  ]);
  const payload = JSON.stringify({ at: new Date().toISOString(), local, alt, public: publik, raw });
  logger.info(`Self probe ${payload}`);
  await setSetting('self_probe', payload, 'Internal HTTP reachability diagnostics');
}

export function startBackgroundJobs(): void {
  if (running) return;
  running = true;

  logger.info('Starting background jobs');

  // Alerting is live from boot, not on first alert.
  seedDefaultAlertRules()
    .then(() => scheduleAlertEvaluation())
    .catch((error) => logger.error('Failed to start alert evaluation', { error: error.message }));

  every('offline-sweep', OFFLINE_SWEEP_MS, true, async () => {
    await refreshRetentionCache();
    await updateOfflineDevices();
    await evaluateOfflineOnly();
  });

  every('retention-sweep', RETENTION_SWEEP_MS, true, async () => {
    await refreshRetentionCache();
    await purgeExpiredTelemetry();
  });

  every('rollup-sweep', ROLLUP_SWEEP_MS, true, buildMetricRollups);

  every('cve-feed-sync', CVE_FEED_SWEEP_MS, true, syncCveFeed);
  // First sync runs shortly after boot so the scanner is not blind on day one.
  every('cve-feed-initial-sync', 30_000, false, syncCveFeed);

  every('hermes-daily-scan', SCHEDULER_TICK_MS, true, maybeRunDailyHermesScan);

  every('self-probe', SELF_PROBE_MS, true, selfProbe);

  refreshRetentionCache().catch(() => undefined);
}

export function stopBackgroundJobs(): void {
  for (const id of timers) {
    clearInterval(id);
    clearTimeout(id);
  }
  timers.length = 0;
  running = false;
  hermesScanStartedFor = '';
}

import { query } from '../config/database';

/**
 * Time-series metric queries.
 *
 * Historically every chart did `SELECT * FROM device_heartbeats ... LIMIT 100`,
 * which caps the range at ~100 samples and silently truncates whatever the user
 * asked for. This module adds `from`/`to`/`interval` support and transparently
 * reads from `metric_rollups` when the requested range is longer than raw
 * retention, so charts can show months rather than minutes.
 *
 * `network_in`/`network_out` are cumulative byte counters. Every consumer used
 * them as if they were throughput; here they are converted to per-second rates
 * using the delta across each bucket.
 */

export type Interval = 'raw' | '5m' | '1h' | '1d';

const BUCKET_SECONDS: Record<Exclude<Interval, 'raw'>, number> = {
  '5m': 300,
  '1h': 3600,
  '1d': 86400,
};

export interface MetricPoint {
  time: string;
  cpu_usage: number | null;
  cpu_max: number | null;
  ram_usage: number | null;
  ram_max: number | null;
  disk_usage: number | null;
  disk_max: number | null;
  network_in: number | null;
  network_out: number | null;
  network_in_rate: number | null;
  network_out_rate: number | null;
  samples: number;
}

export interface SeriesQuery {
  deviceId?: string;
  /** SQL fragment over `devices d` enforcing tenant visibility. */
  visibilitySql?: string;
  visibilityParams?: unknown[];
  from?: Date;
  to?: Date;
  interval?: string;
}

const MAX_RANGE_DAYS = 400;

function clampDate(value: unknown, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

export function resolveRange(from?: unknown, to?: unknown): { from: Date; to: Date; seconds: number } {
  const end = clampDate(to, new Date());
  const start = clampDate(from, new Date(end.getTime() - 24 * 3600 * 1000));
  const boundedStart = new Date(Math.max(start.getTime(), end.getTime() - MAX_RANGE_DAYS * 86400 * 1000));
  return {
    from: boundedStart,
    to: end,
    seconds: Math.max(60, Math.floor((end.getTime() - boundedStart.getTime()) / 1000)),
  };
}

/** Pick a bucket size for the range unless the caller asked for one explicitly. */
export function resolveInterval(explicit: string | undefined, rangeSeconds: number): Interval {
  const requested = (explicit || '').trim();
  if (requested === 'raw') return 'raw';
  if (requested === '5m' || requested === '1h' || requested === '1d') return requested;
  if (rangeSeconds > 7 * 86400) return '1d';
  if (rangeSeconds > 48 * 3600) return '1h';
  if (rangeSeconds > 6 * 3600) return '5m';
  return 'raw';
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function num(value: unknown, digits = 1): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 10 ** digits) / 10 ** digits;
}

/**
 * Aggregated series (5m/1h/1d) computed from raw heartbeats. Used both by the
 * API and by the rollup job so the two can never disagree on bucket maths.
 */
const AGGREGATED_SQL = (bucketSeconds: number): string => `
  WITH raw AS (
    SELECT h.device_id, h.cpu_usage, h.ram_usage, h.disk_usage,
           h.network_in, h.network_out, h.recorded_at,
           to_timestamp(floor(extract(epoch from h.recorded_at) / ${bucketSeconds}) * ${bucketSeconds}) AS bucket
      FROM device_heartbeats h
      JOIN devices d ON d.id = h.device_id
     WHERE h.recorded_at >= $1 AND h.recorded_at < $2
       {{DEVICE}}
       {{VISIBILITY}}
  ),
  per_device AS (
    SELECT device_id, bucket,
           AVG(cpu_usage)   AS cpu_avg,   MAX(cpu_usage)   AS cpu_max,
           AVG(ram_usage)   AS ram_avg,   MAX(ram_usage)   AS ram_max,
           AVG(disk_usage)  AS disk_avg,  MAX(disk_usage)  AS disk_max,
           COUNT(*)         AS samples,
           GREATEST(MAX(network_in)  - MIN(network_in),  0) AS net_in_delta,
           GREATEST(MAX(network_out) - MIN(network_out), 0) AS net_out_delta,
           EXTRACT(EPOCH FROM (MAX(recorded_at) - MIN(recorded_at))) AS span
      FROM raw
     GROUP BY device_id, bucket
  )
  SELECT bucket,
         AVG(cpu_avg)  AS cpu_usage,  MAX(cpu_max)  AS cpu_max,
         AVG(ram_avg)  AS ram_usage,  MAX(ram_max)  AS ram_max,
         AVG(disk_avg) AS disk_usage, MAX(disk_max) AS disk_max,
         SUM(net_in_delta)  AS network_in,
         SUM(net_out_delta) AS network_out,
         GREATEST(AVG(span), 1) AS span_seconds,
         SUM(samples) AS samples
    FROM per_device
   GROUP BY bucket
   ORDER BY bucket ASC`;

/**
 * Raw heartbeats, bucketed per sample, with the byte counters turned into
 * per-second rates against the previous sample of the same device.
 */
const RAW_SQL = `
  SELECT h.recorded_at,
         h.cpu_usage, h.ram_usage, h.disk_usage,
         h.network_in, h.network_out,
         CASE
           WHEN prev.recorded_at IS NULL THEN NULL
           ELSE GREATEST(h.network_in - prev.network_in, 0)
                / NULLIF(EXTRACT(EPOCH FROM (h.recorded_at - prev.recorded_at)), 0)
         END AS network_in_rate,
         CASE
           WHEN prev.recorded_at IS NULL THEN NULL
           ELSE GREATEST(h.network_out - prev.network_out, 0)
                / NULLIF(EXTRACT(EPOCH FROM (h.recorded_at - prev.recorded_at)), 0)
         END AS network_out_rate,
         h.device_id
    FROM device_heartbeats h
    JOIN devices d ON d.id = h.device_id
    LEFT JOIN LATERAL (
      SELECT p.recorded_at, p.network_in, p.network_out
        FROM device_heartbeats p
       WHERE p.device_id = h.device_id AND p.recorded_at < h.recorded_at
       ORDER BY p.recorded_at DESC
       LIMIT 1
    ) prev ON true
   WHERE h.recorded_at >= $1 AND h.recorded_at < $2
     {{DEVICE}}
     {{VISIBILITY}}
   ORDER BY h.recorded_at ASC
   LIMIT 5000`;

export async function fetchHeartbeatSeries(opts: SeriesQuery): Promise<MetricPoint[]> {
  const range = resolveRange(opts.from, opts.to);
  const interval = resolveInterval(opts.interval, range.seconds);

  const baseParams: unknown[] = [range.from, range.to];
  let deviceClause = '';
  if (opts.deviceId) {
    baseParams.push(opts.deviceId);
    deviceClause = `AND h.device_id = $${baseParams.length}`;
  }

  let visibilityClause = '';
  if (opts.visibilitySql) {
    baseParams.push(...(opts.visibilityParams || []));
    visibilityClause = `AND ${opts.visibilitySql.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + baseParams.length - (opts.visibilityParams || []).length}`)}`;
  }

  if (interval === 'raw') {
    const sql = RAW_SQL.replace('{{DEVICE}}', deviceClause).replace('{{VISIBILITY}}', visibilityClause);
    const result = await query(sql, baseParams);
    return result.rows.map((row) => ({
      time: isoOrNull(row.recorded_at) || new Date().toISOString(),
      cpu_usage: num(row.cpu_usage),
      cpu_max: num(row.cpu_usage),
      ram_usage: num(row.ram_usage),
      ram_max: num(row.ram_usage),
      disk_usage: num(row.disk_usage),
      disk_max: num(row.disk_usage),
      network_in: num(row.network_in, 0),
      network_out: num(row.network_out, 0),
      network_in_rate: num(row.network_in_rate),
      network_out_rate: num(row.network_out_rate),
      samples: 1,
    }));
  }

  const sql = AGGREGATED_SQL(BUCKET_SECONDS[interval])
    .replace('{{DEVICE}}', deviceClause)
    .replace('{{VISIBILITY}}', visibilityClause);
  const result = await query(sql, baseParams);

  return result.rows.map((row) => {
    const span = Number(row.span_seconds) || 1;
    const rateIn = num(Number(row.network_in || 0) / span);
    const rateOut = num(Number(row.network_out || 0) / span);
    return {
      time: isoOrNull(row.bucket) || new Date().toISOString(),
      cpu_usage: num(row.cpu_usage),
      cpu_max: num(row.cpu_max),
      ram_usage: num(row.ram_usage),
      ram_max: num(row.ram_max),
      disk_usage: num(row.disk_usage),
      disk_max: num(row.disk_max),
      network_in: num(row.network_in, 0),
      network_out: num(row.network_out, 0),
      network_in_rate: rateIn,
      network_out_rate: rateOut,
      samples: parseInt(String(row.samples), 10) || 0,
    };
  });
}

/**
 * Long-range series served from `metric_rollups`, falling back to live
 * aggregation for buckets the rollup job has not written yet.
 */
export async function fetchRollupSeries(opts: SeriesQuery): Promise<MetricPoint[]> {
  const range = resolveRange(opts.from, opts.to);
  const interval = resolveInterval(opts.interval, range.seconds);
  if (interval === 'raw') return fetchHeartbeatSeries(opts);

  const params: unknown[] = [range.from, range.to, interval];
  const clauses: string[] = ['bucket_start >= $1', 'bucket_start < $2', 'bucket_size = $3'];
  if (opts.deviceId) {
    params.push(opts.deviceId);
    clauses.push(`device_id = $${params.length}`);
  }

  const result = await query(
    `SELECT bucket_start, cpu_avg, cpu_max, ram_avg, ram_max, disk_avg, disk_max,
            network_in, network_out, samples
       FROM metric_rollups
      WHERE ${clauses.join(' AND ')}
      ORDER BY bucket_start ASC
      LIMIT 5000`,
    params
  );

  return result.rows.map((row) => {
    const span = BUCKET_SECONDS[interval];
    return {
      time: isoOrNull(row.bucket_start) || new Date().toISOString(),
      cpu_usage: num(row.cpu_avg),
      cpu_max: num(row.cpu_max),
      ram_usage: num(row.ram_avg),
      ram_max: num(row.ram_max),
      disk_usage: num(row.disk_avg),
      disk_max: num(row.disk_max),
      network_in: num(row.network_in, 0),
      network_out: num(row.network_out, 0),
      network_in_rate: num(Number(row.network_in || 0) / span),
      network_out_rate: num(Number(row.network_out || 0) / span),
      samples: parseInt(String(row.samples), 10) || 0,
    };
  });
}

import { query } from '../config/database';
import logger from '../utils/logger';
import { getSetting, setSetting } from './settings';

/**
 * NVD-backed CVE knowledge base.
 *
 * `hermes_cves` used to hold five hand-written rules with hard-coded version
 * regexes, which meant the scanner could only ever know about five products.
 * This module keeps that local set as a floor and layers real NVD data on top:
 *
 *  - `refreshCveFeed()` pulls recent CVEs (incremental by lastModified),
 *    stores their CPE criteria, and normalises product slugs into
 *    `product_keys` so correlation is a GIN index lookup rather than a scan.
 *  - `matchProductVersion()` replays those CPE criteria (including NVD's
 *    versionStart/End ranges) against a product+version the scanner detected.
 */

const NVD_ENDPOINT = 'https://services.nvd.nist.gov/rest/json/cves/2.0';
const MAX_PAGES = 5;
const PAGE_SIZE = 2000;

export interface CpeCriteria {
  vulnerable: boolean;
  criteria: string;
  versionStartIncluding?: string;
  versionStartExcluding?: string;
  versionEndIncluding?: string;
  versionEndExcluding?: string;
}

export interface CveMatch {
  cve_id: string;
  cvss_score: number;
  severity: string;
  description: string;
  remediation: string;
  references: string[];
  source: string;
}

/** `HTTP_Server` / `http-server` / `HTTP Server` → `http server` */
export function normalizeProduct(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[_./]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a CPE 2.3 URI into its parts (fields may contain escaped colons). */
export function parseCpe(criteria: string): { part: string; vendor: string; product: string; version: string } | null {
  if (!criteria || !criteria.startsWith('cpe:')) return null;
  const raw = criteria.startsWith('cpe:2.3:') ? criteria.slice('cpe:2.3:'.length) : criteria;
  // Split on unescaped colons.
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      current += raw[i + 1];
      i++;
      continue;
    }
    if (ch === ':') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  if (parts.length < 5) return null;
  return { part: parts[0], vendor: parts[1], product: parts[2], version: parts[3] };
}

/** Searchable slugs for one product/vendor pair. */
export function productKeys(vendor: string, product: string): string[] {
  const keys = new Set<string>();
  const v = normalizeProduct(vendor);
  const p = normalizeProduct(product);
  if (p) keys.add(p);
  if (v && p) keys.add(`${v} ${p}`);
  for (const token of p.split(' ')) {
    if (token.length >= 4) keys.add(token);
  }
  return [...keys];
}

/** Numeric-aware version compare; non-numeric segments compare lexically. */
export function compareVersions(a: string, b: string): number {
  const as = String(a).split(/[.\-+_]/);
  const bs = String(b).split(/[.\-+_]/);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i] ?? '0';
    const y = bs[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else {
      const cmp = x.localeCompare(y);
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

/** Does `version` fall inside this CPE match's range? */
export function versionMatches(version: string, c: CpeCriteria): boolean {
  const v = String(version || '').trim();
  if (!v) return false;

  if (c.versionStartIncluding && compareVersions(v, c.versionStartIncluding) < 0) return false;
  if (c.versionStartExcluding && compareVersions(v, c.versionStartExcluding) <= 0) return false;
  if (c.versionEndIncluding && compareVersions(v, c.versionEndIncluding) > 0) return false;
  if (c.versionEndExcluding && compareVersions(v, c.versionEndExcluding) >= 0) return false;

  const hasRange = Boolean(
    c.versionStartIncluding || c.versionStartExcluding || c.versionEndIncluding || c.versionEndExcluding
  );
  if (hasRange) return true;

  // No ranges: the criteria carries a concrete version, or `*` / `-` (any).
  const criteriaVersion = String(c.criteria).split(':')[4];
  if (!criteriaVersion || criteriaVersion === '*' || criteriaVersion === '-') return true;
  return compareVersions(v, criteriaVersion) === 0;
}

/** Would this CPE apply to `product`? (token containment, both directions) */
export function productMatches(detected: string, cpeProduct: string): boolean {
  const a = normalizeProduct(detected);
  const b = normalizeProduct(cpeProduct);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) >= 3;
  const at = new Set(a.split(' '));
  const bt = b.split(' ');
  let hits = 0;
  for (const t of bt) if (t.length >= 4 && at.has(t)) hits++;
  return hits > 0;
}

function severityFromScore(score: number): string {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'info';
}

function extractScore(cve: any): { score: number; severity: string } {
  const metrics = cve.metrics || {};
  for (const key of ['cvssMetricV31', 'cvssMetricV30', 'cvssMetricV3', 'cvssMetricV2']) {
    const list = metrics[key];
    if (Array.isArray(list) && list.length > 0) {
      const preferred = list.find((m: any) => m.type === 'Primary') || list[0];
      const data = preferred.cvssData || {};
      const score = Number(data.baseScore ?? preferred.baseScore ?? 0);
      const severity =
        data.baseSeverity ||
        preferred.baseSeverity ||
        severityFromScore(Number.isFinite(score) ? score : 0);
      return {
        score: Number.isFinite(score) ? score : 0,
        severity: String(severity).toLowerCase(),
      };
    }
  }
  return { score: 0, severity: 'info' };
}

function extractDescription(cve: any): string {
  const list = cve.descriptions || [];
  const en = list.find((d: any) => d.lang === 'en') || list[0];
  return String(en?.value || '').slice(0, 4000);
}

function collectCriteria(cve: any): CpeCriteria[] {
  const out: CpeCriteria[] = [];
  const configurations = cve.configurations || [];
  for (const config of configurations) {
    for (const node of config.nodes || []) {
      for (const match of node.cpeMatch || []) {
        if (match.vulnerable === false) continue;
        out.push({
          vulnerable: true,
          criteria: String(match.criteria || ''),
          versionStartIncluding: match.versionStartIncluding,
          versionStartExcluding: match.versionStartExcluding,
          versionEndIncluding: match.versionEndIncluding,
          versionEndExcluding: match.versionEndExcluding,
        });
      }
    }
  }
  return out.filter((c) => c.criteria);
}

function buildProductKeys(criteria: CpeCriteria[]): string[] {
  const keys = new Set<string>();
  for (const c of criteria) {
    const parsed = parseCpe(c.criteria);
    if (!parsed || parsed.part !== 'a') continue;
    for (const k of productKeys(parsed.vendor, parsed.product)) keys.add(k);
  }
  return [...keys];
}

interface UpsertRow {
  cveId: string;
  score: number;
  severity: string;
  description: string;
  references: string[];
  publishedAt: string | null;
  lastModified: string | null;
  criteria: CpeCriteria[];
  productKeys: string[];
}

async function upsertCves(rows: UpsertRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;

  // Batched to keep the parameter count well under Postgres' 65535 limit.
  const BATCH = 50;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values: unknown[] = [];
    const placeholders = batch.map((row, idx) => {
      const base = idx * 11;
      values.push(
        row.cveId,
        row.score,
        row.severity,
        row.description,
        row.references,
        // node-postgres serialises a JS array as a Postgres array literal, so
        // the JSONB column needs an explicit string + ::jsonb cast.
        JSON.stringify(row.criteria),
        row.productKeys,
        row.publishedAt,
        row.lastModified,
        // First CPE, for display.
        row.criteria[0]?.criteria ?? null,
        row.severity === 'critical' || row.severity === 'high'
          ? 'Apply the vendor security update for the affected component.'
          : 'Review the vendor advisory and plan an update.'
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::jsonb, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, NOW())`;
    });

    await query(
      `INSERT INTO hermes_cves
         (cve_id, cvss_score, severity, description, cve_references, criteria, product_keys,
          published_at, last_modified_at, cpe, remediation, fetched_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (cve_id) DO UPDATE SET
         cvss_score = EXCLUDED.cvss_score,
         severity = EXCLUDED.severity,
         description = EXCLUDED.description,
         cve_references = EXCLUDED.cve_references,
         criteria = EXCLUDED.criteria,
         product_keys = EXCLUDED.product_keys,
         published_at = COALESCE(EXCLUDED.published_at, hermes_cves.published_at),
         last_modified_at = EXCLUDED.last_modified_at,
         cpe = COALESCE(EXCLUDED.cpe, hermes_cves.cpe),
         source = 'nvd',
         fetched_at = NOW()`,
      values
    );
    written += batch.length;
  }

  return written;
}

function toIso(date: Date): string {
  return date.toISOString();
}

/**
 * Pull CVEs published or modified since the last sync. Never throws — a feed
 * outage must not stop the scanner from using whatever it already knows.
 */
export async function refreshCveFeed(options: { full?: boolean } = {}): Promise<{ fetched: number; pages: number }> {
  if ((await getSetting('hermes_cve_feed_enabled', 'true')) === 'false') {
    return { fetched: 0, pages: 0 };
  }

  const lastSync = await getSetting('hermes_cve_feed_last_sync', '');
  const now = new Date();
  let start: Date;
  if (options.full || !lastSync) {
    // First run: cover a long but bounded window so we bootstrap quickly
    // without a multi-hour backfill.
    start = new Date(now.getTime() - 120 * 24 * 3600 * 1000);
  } else {
    start = new Date(Math.max(new Date(lastSync).getTime() - 3600 * 1000, now.getTime() - 120 * 24 * 3600 * 1000));
  }

  const apiKey = process.env.NVD_API_KEY || '';
  const headers: Record<string, string> = { 'User-Agent': 'EndpointX/1.2' };
  if (apiKey) headers['apiKey'] = apiKey;

  let startIndex = 0;
  let pages = 0;
  let fetched = 0;
  let totalResults = Infinity;

  try {
    while (pages < MAX_PAGES && startIndex < totalResults) {
      const params = new URLSearchParams({
        lastModStartDate: toIso(start),
        lastModEndDate: toIso(now),
        resultsPerPage: String(PAGE_SIZE),
        startIndex: String(startIndex),
      });

      const response = await fetch(`${NVD_ENDPOINT}?${params.toString()}`, {
        headers,
        signal: AbortSignal.timeout(60_000),
      });

      if (response.status === 403 || response.status === 429) {
        logger.warn('NVD rate limited the feed refresh', { status: response.status });
        break;
      }
      if (!response.ok) {
        logger.warn('NVD feed request failed', { status: response.status });
        break;
      }

      const body = (await response.json()) as {
        totalResults?: number;
        vulnerabilities?: Array<{ cve?: Record<string, any> }>;
      };
      totalResults = Number(body.totalResults || 0);
      const vulnerabilities = body.vulnerabilities || [];
      if (vulnerabilities.length === 0) break;

      const rows: UpsertRow[] = [];
      for (const item of vulnerabilities) {
        const cve = item.cve;
        if (!cve?.id) continue;
        const { score, severity } = extractScore(cve);
        const criteria = collectCriteria(cve);
        rows.push({
          cveId: cve.id,
          score,
          severity,
          description: extractDescription(cve),
          references: (cve.references || []).map((r: any) => String(r.url)).slice(0, 10),
          publishedAt: cve.published || null,
          lastModified: cve.lastModified || null,
          criteria,
          productKeys: buildProductKeys(criteria),
        });
      }

      fetched += await upsertCves(rows);
      pages++;
      startIndex += PAGE_SIZE;

      // NVD asks for a pause between unauthenticated requests.
      if (!apiKey && startIndex < totalResults) {
        await new Promise((resolve) => setTimeout(resolve, 6_000));
      }
    }

    await setSetting('hermes_cve_feed_last_sync', now.toISOString(), 'Last successful NVD feed refresh');
    logger.info('CVE feed refreshed', { fetched, pages });
  } catch (error) {
    logger.warn('CVE feed refresh failed', { error: (error as Error).message });
  }

  return { fetched, pages };
}

/**
 * Find NVD CVEs that apply to a product/version the scanner fingerprinted.
 * Returns at most 25 matches, best severity first.
 */
export async function matchProductVersion(product: string, version: string): Promise<CveMatch[]> {
  const key = normalizeProduct(product);
  if (!key) return [];
  const tokens = key.split(' ').filter((t) => t.length >= 3);

  const result = await query(
    `SELECT cve_id, cvss_score, severity, description, remediation, cve_references, source, criteria
       FROM hermes_cves
      WHERE source = 'nvd'
        AND product_keys && $1::text[]
        AND criteria IS NOT NULL
        AND jsonb_array_length(criteria) > 0
      ORDER BY cvss_score DESC NULLS LAST
      LIMIT 400`,
    [tokens]
  );

  const matches: CveMatch[] = [];
  for (const row of result.rows) {
    const criteria = (Array.isArray(row.criteria) ? row.criteria : []) as CpeCriteria[];
    const applies = criteria.some((c) => {
      const parsed = parseCpe(c.criteria);
      if (!parsed || parsed.part !== 'a') return false;
      if (!productMatches(product, parsed.product)) return false;
      return versionMatches(version, c);
    });
    if (!applies) continue;

    matches.push({
      cve_id: row.cve_id,
      cvss_score: Number(row.cvss_score || 0),
      severity: row.severity || severityFromScore(Number(row.cvss_score || 0)),
      description: row.description || '',
      remediation: row.remediation || 'Apply the vendor security update.',
      references: Array.isArray(row.cve_references) ? row.cve_references : [],
      source: row.source || 'nvd',
    });
    if (matches.length >= 25) break;
  }

  return matches;
}

/** Stats for the HERMES status screen. */
export async function cveFeedStatus(): Promise<Record<string, unknown>> {
  const result = await query(
    `SELECT COUNT(*) FILTER (WHERE source = 'nvd') AS nvd,
            COUNT(*) FILTER (WHERE source = 'local') AS local,
            COUNT(*) AS total,
            MAX(fetched_at) AS last_sync
       FROM hermes_cves`
  );
  const row = result.rows[0] || {};
  return {
    nvd: parseInt(String(row.nvd || 0), 10),
    local: parseInt(String(row.local || 0), 10),
    total: parseInt(String(row.total || 0), 10),
    last_sync: row.last_sync || (await getSetting('hermes_cve_feed_last_sync', '')) || null,
  };
}

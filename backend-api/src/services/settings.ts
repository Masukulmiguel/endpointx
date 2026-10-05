import { query } from '../config/database';

/**
 * Shared app_settings accessors.
 *
 * Several modules used to re-implement this query (hermes, forensics,
 * notifications). One implementation keeps caching, fallbacks and writes
 * consistent — and gives the SMTP config a single source of truth.
 */

const cache = new Map<string, string>();
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 15_000;

async function refreshCache(): Promise<void> {
  const result = await query('SELECT key, value FROM app_settings');
  cache.clear();
  for (const row of result.rows) {
    if (row.value !== null && row.value !== undefined) cache.set(row.key, String(row.value));
  }
  cacheLoadedAt = Date.now();
}

/** Read a setting. Falls back to `fallback` when the key is missing/blank. */
export async function getSetting(key: string, fallback = ''): Promise<string> {
  if (Date.now() - cacheLoadedAt > CACHE_TTL_MS) {
    try {
      await refreshCache();
    } catch {
      // A cold cache must never break a request; fall through to what we have.
    }
  }
  const value = cache.get(key);
  return value === undefined || value === '' ? fallback : value;
}

/** Read several settings in one round trip. Returns a plain key → value map. */
export async function getSettingsMap(keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  const result = await query('SELECT key, value FROM app_settings WHERE key = ANY($1::text[])', [keys]);
  const out: Record<string, string> = {};
  for (const row of result.rows) {
    if (row.value !== null && row.value !== undefined) out[row.key] = String(row.value);
  }
  return out;
}

/** Read a setting as a boolean ("true"/"1"/"yes", case-insensitive). */
export async function getSettingBool(key: string, fallback = false): Promise<boolean> {
  const raw = (await getSetting(key, fallback ? 'true' : 'false')).trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

/** Read a setting as a number, falling back when unparsable. */
export async function getSettingNumber(key: string, fallback: number): Promise<number> {
  const raw = await getSetting(key, '');
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Create or update a setting and bust the cache so the next read is fresh. */
export async function setSetting(
  key: string,
  value: string,
  description?: string,
  updatedBy?: string
): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, description, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()${
       updatedBy ? ', updated_by = $4' : ''
     }`,
    [key, value, description ?? null, updatedBy ?? null]
  );
  cache.set(key, value);
  cacheLoadedAt = Date.now();
}

/** Drop the in-process cache (used by tests and after bulk writes). */
export function invalidateSettingsCache(): void {
  cache.clear();
  cacheLoadedAt = 0;
}

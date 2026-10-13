interface CacheEntry {
  value: unknown;
  expires: number;
}

const store = new Map<string, CacheEntry>();
const MAX_ENTRIES = 500;

export function cacheGet<T>(key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { value, expires: Date.now() + ttlMs });
}

export function cacheHas(key: string): boolean {
  return cacheGet(key) !== null;
}

export function cacheInvalidate(key: string): void {
  store.delete(key);
}

export function cacheClear(): void {
  store.clear();
}

export const TTL = {
  IP: 3600_000,
  DNS: 900_000,
  WHOIS: 86400_000,
  SUBDOMAIN: 21600_000,
  VIN: 86400_000 * 30,
  SHODAN: 3600_000,
  EMAIL: 3600_000,
  PHONE: 3600_000,
} as const;

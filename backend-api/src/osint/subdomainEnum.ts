import { SubdomainEntry, OsintModuleResult } from './types';
import { cacheGet, cacheSet, TTL } from './cache';
import { isValidDomain } from './dnsLookup';

const USER_AGENT = 'EndpointX-OSINT/1.4.0';

async function fromCrtSh(domain: string): Promise<SubdomainEntry[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const resp = await fetch(`https://crt.sh/?q=${encodeURIComponent('%.' + domain)}&output=json`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timeout);

    if (!resp.ok) return [];
    const json = await resp.json() as Array<{ name_value?: string }>;
    const seen = new Set<string>();
    const results: SubdomainEntry[] = [];
    for (const entry of json) {
      const name = (entry.name_value || '').trim().toLowerCase();
      if (name && name.includes(domain) && !seen.has(name)) {
        seen.add(name);
        results.push({ domain: name, source: 'crt.sh' });
      }
    }
    return results;
  } catch {
    return [];
  }
}

async function fromHackerTarget(domain: string): Promise<SubdomainEntry[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const resp = await fetch(`https://api.hackertarget.com/hostsearch/?q=${encodeURIComponent(domain)}`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timeout);

    if (!resp.ok) return [];
    const text = await resp.text();
    if (text.includes('error')) return [];
    return text.split('\n')
      .map(line => line.split(',')[0]?.trim().toLowerCase())
      .filter((host): host is string => !!host && host.includes(domain))
      .map(host => ({ domain: host, source: 'hackertarget' }));
  } catch {
    return [];
  }
}

export async function enumerateSubdomains(domain: string): Promise<OsintModuleResult<SubdomainEntry[]>> {
  if (!isValidDomain(domain)) {
    return { success: false, error: 'Invalid domain name', source: 'crt.sh+hackertarget' };
  }

  const cacheKey = `subdomains:${domain}`;
  const cached = cacheGet<SubdomainEntry[]>(cacheKey);
  if (cached) return { success: true, data: cached, source: 'cached' };

  try {
    const [ctResults, htResults] = await Promise.all([
      fromCrtSh(domain),
      fromHackerTarget(domain),
    ]);

    const seen = new Set<string>();
    const merged: SubdomainEntry[] = [];
    for (const entry of [...ctResults, ...htResults]) {
      if (!seen.has(entry.domain)) {
        seen.add(entry.domain);
        merged.push(entry);
      }
    }

    const sources = merged.length > 0 ? [...new Set(merged.map(e => e.source))] : [];
    cacheSet(cacheKey, merged, TTL.SUBDOMAIN);
    return { success: true, data: merged, source: sources.join('+') || 'none' };
  } catch (error) {
    return { success: false, error: (error as Error).message, source: 'crt.sh+hackertarget' };
  }
}

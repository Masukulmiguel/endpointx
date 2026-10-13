import { ShodanInfo, OsintModuleResult } from './types';
import { cacheGet, cacheSet, TTL } from './cache';
import { isValidIp } from './ipLookup';

const USER_AGENT = 'EndpointX-OSINT/1.4.0';

export async function lookupShodan(ip: string, apiKey: string): Promise<OsintModuleResult<ShodanInfo>> {
  if (!isValidIp(ip)) {
    return { success: false, error: 'Invalid IP address', source: 'shodan' };
  }
  if (!apiKey) {
    return { success: false, error: 'Shodan API key not configured', source: 'shodan', requiresKey: true };
  }

  const cacheKey = `shodan:${ip}`;
  const cached = cacheGet<ShodanInfo>(cacheKey);
  if (cached) return { success: true, data: cached, source: 'shodan (cached)' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const resp = await fetch(`https://api.shodan.io/shodan/host/${encodeURIComponent(ip)}?key=${encodeURIComponent(apiKey)}`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timeout);

    if (resp.status === 404) {
      return { success: false, error: 'No Shodan data for this IP', source: 'shodan' };
    }
    if (resp.status === 401) {
      return { success: false, error: 'Invalid Shodan API key', source: 'shodan' };
    }
    if (!resp.ok) {
      return { success: false, error: `Shodan returned ${resp.status}`, source: 'shodan' };
    }

    const json = await resp.json() as any;
    const info: ShodanInfo = {
      ports: json.ports || [],
      hostnames: json.hostnames || [],
      org: json.org || '',
      os: json.os || undefined,
      vulns: json.vulns ? Object.keys(json.vulns) : undefined,
      ipStr: json.ip_str || ip,
    };

    cacheSet(cacheKey, info, TTL.SHODAN);
    return { success: true, data: info, source: 'shodan' };
  } catch (error) {
    return { success: false, error: (error as Error).message, source: 'shodan' };
  }
}

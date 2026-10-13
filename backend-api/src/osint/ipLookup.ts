import { IpInfo, OsintModuleResult } from './types';
import { cacheGet, cacheSet, TTL } from './cache';

const USER_AGENT = 'EndpointX-OSINT/1.4.0';

export function isValidIp(ip: string): boolean {
  const ipv4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
  const ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
  return ipv4.test(ip) || ipv6.test(ip);
}

export async function lookupIp(ip: string): Promise<OsintModuleResult<IpInfo>> {
  if (!isValidIp(ip)) {
    return { success: false, error: 'Invalid IP address', source: 'ip-api' };
  }

  const cacheKey = `ip:${ip}`;
  const cached = cacheGet<IpInfo>(cacheKey);
  if (cached) return { success: true, data: cached, source: 'ip-api (cached)' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,reverse,query`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      return { success: false, error: `ip-api returned ${resp.status}`, source: 'ip-api' };
    }

    const json = await resp.json() as any;
    if (json.status === 'fail') {
      return { success: false, error: json.message || 'Lookup failed', source: 'ip-api' };
    }

    const info: IpInfo = {
      country: json.country || '',
      countryCode: json.countryCode || '',
      region: json.region || '',
      regionName: json.regionName || '',
      city: json.city || '',
      zip: json.zip || '',
      lat: json.lat || 0,
      lon: json.lon || 0,
      timezone: json.timezone || '',
      isp: json.isp || '',
      org: json.org || '',
      as: json.as || '',
      asname: json.asname || '',
      reverse: json.reverse || '',
      query: json.query || ip,
    };

    cacheSet(cacheKey, info, TTL.IP);
    return { success: true, data: info, source: 'ip-api' };
  } catch (error) {
    return { success: false, error: (error as Error).message, source: 'ip-api' };
  }
}

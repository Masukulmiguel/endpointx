import { DnsRecords, OsintModuleResult } from './types';
import { cacheGet, cacheSet, TTL } from './cache';

const USER_AGENT = 'EndpointX-OSINT/1.4.0';
const RECORD_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'SOA', 'CNAME', 'PTR'] as const;
type RecordType = (typeof RECORD_TYPES)[number];

export function isValidDomain(domain: string): boolean {
  const re = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  return re.test(domain);
}

async function resolveRecord(domain: string, type: RecordType): Promise<string[]> {
  const url = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${type}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT } });
    if (!resp.ok) return [];
    const json = await resp.json() as any;
    if (json.Answer) {
      return json.Answer.map((a: any) => String(a.data || ''));
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function lookupDns(domain: string): Promise<OsintModuleResult<DnsRecords>> {
  if (!isValidDomain(domain)) {
    return { success: false, error: 'Invalid domain name', source: 'google-dns' };
  }

  const cacheKey = `dns:${domain}`;
  const cached = cacheGet<DnsRecords>(cacheKey);
  if (cached) return { success: true, data: cached, source: 'google-dns (cached)' };

  try {
    const [a, aaaa, mx, txt, ns, soa, cname] = await Promise.all([
      resolveRecord(domain, 'A'),
      resolveRecord(domain, 'AAAA'),
      resolveRecord(domain, 'MX'),
      resolveRecord(domain, 'TXT'),
      resolveRecord(domain, 'NS'),
      resolveRecord(domain, 'SOA'),
      resolveRecord(domain, 'CNAME'),
    ]);

    const records: DnsRecords = { a, aaaa, mx, txt, ns, soa, cname, ptr: [] };
    cacheSet(cacheKey, records, TTL.DNS);
    return { success: true, data: records, source: 'google-dns' };
  } catch (error) {
    return { success: false, error: (error as Error).message, source: 'google-dns' };
  }
}

export async function reverseDns(ip: string): Promise<string[]> {
  const cacheKey = `ptr:${ip}`;
  const cached = cacheGet<string[]>(cacheKey);
  if (cached) return cached;

  const arpa = ip.includes(':')
    ? ip.split(':').map(seg => seg.split('').reverse().join('')).join('.') + '.ip6.arpa'
    : ip.split('.').reverse().join('.') + '.in-addr.arpa';

  const records = await resolveRecord(arpa, 'PTR');
  cacheSet(cacheKey, records, TTL.DNS);
  return records;
}

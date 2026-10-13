import { WhoisInfo, OsintModuleResult } from './types';
import { cacheGet, cacheSet, TTL } from './cache';
import { isValidIp } from './ipLookup';
import { isValidDomain } from './dnsLookup';

const USER_AGENT = 'EndpointX-OSINT/1.4.0';

interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown[];
  handle?: string;
}

interface RdapResponse {
  objectClassName?: string;
  ldhName?: string;
  status?: string[];
  events?: Array<{ eventAction: string; eventDate: string }>;
  entities?: RdapEntity[];
  nameservers?: Array<{ ldhName?: string }>;
  publicIds?: Array<{ type: string; identifier: string }>;
  [key: string]: unknown;
}

function extractVcard(entity: RdapEntity, field: string): string | undefined {
  if (!entity.vcardArray || !Array.isArray(entity.vcardArray)) return undefined;
  const props = entity.vcardArray[1] as any[];
  if (!Array.isArray(props)) return undefined;
  const found = props.find(p => Array.isArray(p) && p[0] === field);
  if (!found || !Array.isArray(found) || found.length < 4) return undefined;
  return String(found[3]);
}

export async function lookupWhois(target: string): Promise<OsintModuleResult<WhoisInfo>> {
  const isIp = isValidIp(target);
  const isDomain = isValidDomain(target);
  if (!isIp && !isDomain) {
    return { success: false, error: 'Target must be a valid IP or domain', source: 'rdap' };
  }

  const cacheKey = `whois:${target}`;
  const cached = cacheGet<WhoisInfo>(cacheKey);
  if (cached) return { success: true, data: cached, source: 'rdap (cached)' };

  try {
    let rdapUrl: string;
    if (isIp) {
      rdapUrl = `https://rdap.org/ip/${encodeURIComponent(target)}`;
    } else {
      rdapUrl = `https://rdap.org/domain/${encodeURIComponent(target)}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const resp = await fetch(rdapUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rdap+json, application/json' },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      return { success: false, error: `RDAP returned ${resp.status}`, source: 'rdap' };
    }

    const json = await resp.json() as RdapResponse;

    const nameServers: string[] = (json.nameservers || [])
      .map(ns => ns.ldhName || '')
      .filter(Boolean);

    const events = json.events || [];
    const created = events.find(e => e.eventAction === 'registration')?.eventDate;
    const expiry = events.find(e => e.eventAction === 'expiration')?.eventDate;

    let registrar: string | undefined;
    let registrantOrg: string | undefined;
    let registrantCountry: string | undefined;

    for (const entity of json.entities || []) {
      if (entity.roles?.includes('registrar') && !registrar) {
        registrar = extractVcard(entity, 'fn') || entity.handle;
      }
      if (entity.roles?.includes('registrant') && !registrantOrg) {
        registrantOrg = extractVcard(entity, 'org') || extractVcard(entity, 'fn');
        registrantCountry = extractVcard(entity, 'country');
      }
    }

    const info: WhoisInfo = {
      registrar,
      creationDate: created,
      expiryDate: expiry,
      nameServers,
      status: json.status || [],
      registrantOrg,
      registrantCountry,
      domain: isDomain ? target : undefined,
      ip: isIp ? target : undefined,
    };

    cacheSet(cacheKey, info, TTL.WHOIS);
    return { success: true, data: info, source: 'rdap' };
  } catch (error) {
    return { success: false, error: (error as Error).message, source: 'rdap' };
  }
}

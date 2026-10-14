import { PhoneInfo, PhoneHlr, PhoneReputation, OsintModuleResult } from './types';
import { cacheGet, cacheSet, TTL } from './cache';

const USER_AGENT = 'EndpointX-OSINT/1.4.0';

interface CountryCode {
  code: string;
  dial: string;
  name: string;
}

const COUNTRY_CODES: CountryCode[] = [
  { code: 'AO', dial: '+244', name: 'Angola' },
  { code: 'BR', dial: '+55', name: 'Brazil' },
  { code: 'CN', dial: '+86', name: 'China' },
  { code: 'DE', dial: '+49', name: 'Germany' },
  { code: 'ES', dial: '+34', name: 'Spain' },
  { code: 'FR', dial: '+33', name: 'France' },
  { code: 'GB', dial: '+44', name: 'United Kingdom' },
  { code: 'ID', dial: '+62', name: 'Indonesia' },
  { code: 'IN', dial: '+91', name: 'India' },
  { code: 'IT', dial: '+39', name: 'Italy' },
  { code: 'JP', dial: '+81', name: 'Japan' },
  { code: 'MX', dial: '+52', name: 'Mexico' },
  { code: 'NG', dial: '+234', name: 'Nigeria' },
  { code: 'PT', dial: '+351', name: 'Portugal' },
  { code: 'RU', dial: '+7', name: 'Russia' },
  { code: 'US', dial: '+1', name: 'United States' },
  { code: 'ZA', dial: '+27', name: 'South Africa' },
];

export function isValidPhone(phone: string): boolean {
  const cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
  return /^\+?\d{7,15}$/.test(cleaned);
}

function detectCountry(phone: string): CountryCode | undefined {
  const cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
  if (!cleaned.startsWith('+')) return undefined;

  const sorted = [...COUNTRY_CODES].sort((a, b) => b.dial.length - a.dial.length);
  for (const cc of sorted) {
    if (cleaned.startsWith(cc.dial)) return cc;
  }
  return undefined;
}

async function lookupCarrier(numverifyKey: string, e164: string): Promise<{ carrier?: string; lineType?: string } | null> {
  if (!numverifyKey) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(`https://apilayer.net/api/validate?access_key=${encodeURIComponent(numverifyKey)}&number=${encodeURIComponent(e164)}`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const json = await resp.json() as any;
    if (!json.valid) return null;
    return { carrier: json.carrier || undefined, lineType: json.line_type || undefined };
  } catch {
    return null;
  }
}

interface AngolaPrefixRange {
  prefixes: string[];
  operator: string;
  type: 'mobile' | 'fixed';
}

const ANGOLA_PREFIXES: AngolaPrefixRange[] = [
  { prefixes: ['92', '93', '94', '97'], operator: 'Unitel', type: 'mobile' },
  { prefixes: ['91', '99'], operator: 'Movicel', type: 'mobile' },
  { prefixes: ['95', '96'], operator: 'Africell', type: 'mobile' },
  { prefixes: ['222'], operator: 'Angola Telecom', type: 'fixed' },
];

export function operatorFromPrefix(e164: string): { operator: string; type: 'mobile' | 'fixed' } | null {
  const digits = e164.replace(/\D/g, '');
  if (!digits.startsWith('244')) return null;
  const nsn = digits.slice(3);
  if (nsn.length < 2) return null;
  for (const range of ANGOLA_PREFIXES) {
    for (const prefix of range.prefixes) {
      if (nsn.startsWith(prefix)) return { operator: range.operator, type: range.type };
    }
  }
  return null;
}

export interface PhoneKeys {
  numverifyKey?: string;
  hlrApiKey?: string;
  hlrApiSecret?: string;
  hiyaApiKey?: string;
}

export function parseHlrResponse(payload: unknown): PhoneHlr | null {
  const body = (payload as any)?.body ?? payload;
  const result = body?.results?.[0];
  if (!result || result.error !== 'NONE') return null;
  const isPorted = String(result.is_ported || '').toUpperCase() === 'YES';
  return {
    connectivity: result.live_status || undefined,
    originalNetwork: result.original_network_details?.name || undefined,
    currentNetwork: result.current_network_details?.name || undefined,
    mccmnc: result.current_network_details?.mccmnc || result.original_network_details?.mccmnc || undefined,
    isPorted,
    roaming: !!result.roaming_network_details?.name,
    countryIso: result.current_network_details?.country_iso3 || result.original_network_details?.country_iso3 || undefined,
  };
}

async function lookupHlr(e164: string, apiKey: string, apiSecret: string): Promise<PhoneHlr | null> {
  if (!apiKey || !apiSecret) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const resp = await fetch('https://api.hlrlookup.com/apiv2/hlr', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'Authorization': 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64'),
      },
      body: JSON.stringify({ requests: [{ telephone_number: e164.replace('+', '') }] }),
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return parseHlrResponse(await resp.json());
  } catch {
    return null;
  }
}

export function parseHiyaProfile(payload: unknown): PhoneReputation | null {
  const body = (payload as any)?.body ?? payload;
  const result = body?.result;
  if (!result) return null;
  const displayName = result.displayName || body?.displayName || undefined;
  const category = result.profileDetails?.reputationCategoryName || body?.reputationCategoryName || undefined;
  const isSpam = body?.isSpam === true || result.isSpam === true || undefined;
  if (!displayName && !category && !isSpam) return null;
  return { displayName, category, isSpam };
}

async function lookupReputation(e164: string, apiKey: string): Promise<PhoneReputation | null> {
  if (!apiKey) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const resp = await fetch('https://api.hiya.com/v1/phones/phoneProfile', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ phone: e164 }),
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return parseHiyaProfile(await resp.json());
  } catch {
    return null;
  }
}

export async function lookupPhone(phone: string, keys: PhoneKeys = {}): Promise<OsintModuleResult<PhoneInfo>> {
  if (!isValidPhone(phone)) {
    return { success: false, error: 'Invalid phone number', source: 'local' };
  }

  const flags = [
    keys.numverifyKey ? 'nv' : '',
    keys.hlrApiKey && keys.hlrApiSecret ? 'hlr' : '',
    keys.hiyaApiKey ? 'hiya' : '',
  ].filter(Boolean).join('+') || 'local';

  const cacheKey = `phone:${phone}:${flags}`;
  const cached = cacheGet<PhoneInfo>(cacheKey);
  if (cached) return { success: true, data: cached, source: 'cached' };

  try {
    const cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
    const e164 = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
    const country = detectCountry(e164);

    let carrier: string | undefined;
    let lineType: string | undefined;
    if (keys.numverifyKey) {
      const carrierInfo = await lookupCarrier(keys.numverifyKey, e164);
      if (carrierInfo) {
        carrier = carrierInfo.carrier;
        lineType = carrierInfo.lineType;
      }
    }

    const prefix = operatorFromPrefix(e164);
    if (prefix && !carrier) carrier = prefix.operator;

    const [hlr, reputation] = await Promise.all([
      keys.hlrApiKey && keys.hlrApiSecret ? lookupHlr(e164, keys.hlrApiKey, keys.hlrApiSecret) : Promise.resolve(null),
      keys.hiyaApiKey ? lookupReputation(e164, keys.hiyaApiKey) : Promise.resolve(null),
    ]);

    const digits = e164.replace(/\D/g, '');
    const info: PhoneInfo = {
      valid: digits.length >= 8 && digits.length <= 15,
      countryCode: country?.code || '',
      country: country?.name || 'Unknown',
      carrier,
      lineType: lineType || prefix?.type || (digits.length > 10 ? 'mobile' : 'landline'),
      numberType: country ? 'international' : 'national',
      e164,
      national: cleaned.replace(/^\+\d{1,4}/, ''),
      prefixOperator: prefix?.operator,
      prefixType: prefix?.type,
      hlr: hlr || undefined,
      reputation: reputation || undefined,
      identityName: reputation?.displayName,
    };

    cacheSet(cacheKey, info, TTL.PHONE);
    return { success: true, data: info, source: flags === 'local' ? 'local' : `local+${flags}` };
  } catch (error) {
    return { success: false, error: (error as Error).message, source: 'local' };
  }
}

import { PhoneInfo, OsintModuleResult } from './types';
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

export async function lookupPhone(phone: string, numverifyKey?: string): Promise<OsintModuleResult<PhoneInfo>> {
  if (!isValidPhone(phone)) {
    return { success: false, error: 'Invalid phone number', source: 'local' };
  }

  const cacheKey = `phone:${phone}`;
  const cached = cacheGet<PhoneInfo>(cacheKey);
  if (cached) return { success: true, data: cached, source: 'cached' };

  try {
    const cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
    const e164 = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
    const country = detectCountry(e164);

    let carrier: string | undefined;
    let lineType: string | undefined;
    if (numverifyKey) {
      const carrierInfo = await lookupCarrier(numverifyKey, e164);
      if (carrierInfo) {
        carrier = carrierInfo.carrier;
        lineType = carrierInfo.lineType;
      }
    }

    const digits = e164.replace(/\D/g, '');
    const info: PhoneInfo = {
      valid: digits.length >= 8 && digits.length <= 15,
      countryCode: country?.code || '',
      country: country?.name || 'Unknown',
      carrier,
      lineType: lineType || (digits.length > 10 ? 'mobile' : 'landline'),
      numberType: country ? 'international' : 'national',
      e164,
      national: cleaned.replace(/^\+\d{1,4}/, ''),
    };

    cacheSet(cacheKey, info, TTL.PHONE);
    return { success: true, data: info, source: numverifyKey ? 'local+numverify' : 'local' };
  } catch (error) {
    return { success: false, error: (error as Error).message, source: 'local' };
  }
}

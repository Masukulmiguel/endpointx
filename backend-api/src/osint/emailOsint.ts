import { EmailInfo, OsintModuleResult, BreachEntry } from './types';
import { cacheGet, cacheSet, TTL } from './cache';

const USER_AGENT = 'EndpointX-OSINT/1.4.0';

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'maildrop.cc',
  'throwawaymail.com', 'fakeinbox.com', 'dispostable.com', 'mailnesia.com', 'minutemail.com',
  'tempr.email', 'tempmail.net', 'emailondeck.com', 'moakt.com', 'mohmal.com',
]);

const FREE_PROVIDERS: Record<string, string> = {
  'gmail.com': 'Google Gmail',
  'googlemail.com': 'Google Gmail',
  'outlook.com': 'Microsoft Outlook',
  'hotmail.com': 'Microsoft Hotmail',
  'live.com': 'Microsoft Live',
  'yahoo.com': 'Yahoo Mail',
  'ymail.com': 'Yahoo Mail',
  'aol.com': 'AOL Mail',
  'protonmail.com': 'ProtonMail',
  'proton.me': 'ProtonMail',
  'tutanota.com': 'Tutanota',
  'icloud.com': 'Apple iCloud',
  'me.com': 'Apple iCloud',
  'mac.com': 'Apple iCloud',
  'zoho.com': 'Zoho Mail',
  'gmx.com': 'GMX Mail',
  'mail.com': 'Mail.com',
  'yandex.com': 'Yandex Mail',
  'yandex.ru': 'Yandex Mail',
};

export function isValidEmail(email: string): boolean {
  const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return re.test(email);
}

async function lookupMx(domain: string): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const resp = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timeout);
    if (!resp.ok) return [];
    const json = await resp.json() as any;
    if (json.Answer) {
      return json.Answer.map((a: any) => String(a.data || '').replace(/^\d+\s+/, ''));
    }
    return [];
  } catch {
    return [];
  }
}

async function checkBreaches(email: string, apiKey: string): Promise<BreachEntry[] | null> {
  if (!apiKey) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const resp = await fetch(`https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'hibp-api-key': apiKey,
      },
    });
    clearTimeout(timeout);

    if (resp.status === 404) return [];
    if (!resp.ok) return null;

    const json = await resp.json() as Array<{ Name: string; BreachDate: string; DataClasses: string[] }>;
    return json.map(b => ({
      name: b.Name,
      breachDate: b.BreachDate,
      dataClasses: b.DataClasses || [],
    }));
  } catch {
    return null;
  }
}

export async function lookupEmail(email: string, hibpApiKey?: string): Promise<OsintModuleResult<EmailInfo>> {
  if (!isValidEmail(email)) {
    return { success: false, error: 'Invalid email address', source: 'mx+disposable' };
  }

  const cacheKey = `email:${email}`;
  const cached = cacheGet<EmailInfo>(cacheKey);
  if (cached) return { success: true, data: cached, source: 'cached' };

  try {
    const domain = email.split('@')[1].toLowerCase();
    const mxRecords = await lookupMx(domain);
    const isDisposable = DISPOSABLE_DOMAINS.has(domain);

    let provider = FREE_PROVIDERS[domain];
    if (!provider && mxRecords.length > 0) {
      const mxDomain = mxRecords[0].toLowerCase();
      for (const [key, name] of Object.entries(FREE_PROVIDERS)) {
        if (mxDomain.includes(key)) { provider = name; break; }
      }
      if (!provider) provider = mxRecords[0];
    }
    if (!provider) provider = 'Unknown';

    const breaches = await checkBreaches(email, hibpApiKey || '');

    const info: EmailInfo = {
      provider,
      mxRecords,
      isDisposable,
      breaches: breaches || undefined,
    };

    cacheSet(cacheKey, info, TTL.EMAIL);
    const sources = ['mx', 'disposable'];
    if (breaches) sources.push('hibp');
    return { success: true, data: info, source: sources.join('+') };
  } catch (error) {
    return { success: false, error: (error as Error).message, source: 'mx+disposable' };
  }
}

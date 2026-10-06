/**
 * SSRF guard for URLs the server fetches on a user's behalf
 * (outgoing webhooks: create, update, test and delivery).
 *
 * An admin-supplied webhook URL must never make the API reach loopback,
 * RFC1918, link-local/cloud-metadata or otherwise non-routable space, so a
 * compromised or malicious settings.manage session cannot pivot into the
 * host or the cloud control plane.
 *
 * Local development is the one exception: a receiver on 127.0.0.1 is a
 * legitimate test target when NODE_ENV is not 'production'. Link-local and
 * multicast stay blocked everywhere.
 *
 * The syntax pass is synchronous and DNS-free so it can be unit tested
 * offline; checkWebhookUrl() adds the async DNS resolution pass used on the
 * request path.
 */

import { promises as dns } from 'dns';
import net from 'net';

export interface UrlSafetyResult {
  ok: boolean;
  reason?: string;
}

const MAX_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Hostnames that are never a webhook receiver, whatever they resolve to.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'instance-data',
  'metadata.google.internal',
  'metadata',
]);

// Suffixes that only ever describe local infrastructure.
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa'];

type IpClass = 'public' | 'dev-ok' | 'blocked';

const stripBrackets = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

function classifyIpv4(ip: string): IpClass {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return 'blocked';
  }
  const [a, b] = octets;

  // Never fetchable: link-local (cloud metadata lives here), multicast,
  // broadcast and the remaining reserved ranges.
  if (a === 169 && b === 254) return 'blocked';
  if (a === 0 || a >= 224) return 'blocked';

  // Loopback, RFC1918 and CGNAT: fine against a dev laptop, never in prod.
  if (a === 127) return 'dev-ok';
  if (a === 10) return 'dev-ok';
  if (a === 172 && b >= 16 && b <= 31) return 'dev-ok';
  if (a === 192 && b === 168) return 'dev-ok';
  if (a === 100 && b >= 64 && b <= 127) return 'dev-ok';

  return 'public';
}

/** IPv4 address carried inside an IPv4-mapped IPv6 address, in whichever
 *  form the WHATWG URL parser normalised it to (dotted or hex). */
function mappedIpv4(normalized: string): string | null {
  const dotted = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];

  const hex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return null;
}

function classifyIpv6(ip: string): IpClass {
  const normalized = ip.toLowerCase();
  const mapped = mappedIpv4(normalized);
  if (mapped) return classifyIpv4(mapped);

  if (normalized === '::1' || normalized === '::') return 'dev-ok';
  if (/^f[cd]/.test(normalized)) return 'dev-ok'; // unique local fc00::/7
  if (/^fe[89ab]/.test(normalized)) return 'blocked'; // link-local fe80::/10
  if (/^ff/.test(normalized)) return 'blocked'; // multicast ff00::/8

  return 'public';
}

export function classifyHost(host: string): IpClass | null {
  const normalized = stripBrackets(host.toLowerCase());
  if (net.isIPv4(normalized)) return classifyIpv4(normalized);
  if (net.isIPv6(normalized)) return classifyIpv6(normalized);
  return null;
}

function isBlockedHostname(hostname: string): boolean {
  const host = stripBrackets(hostname.toLowerCase());
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function reject(reason: string): UrlSafetyResult {
  return { ok: false, reason };
}

/**
 * DNS-free validation of the URL's shape, scheme and (when the host is an IP
 * literal) its address class.
 */
export function checkWebhookUrlSyntax(raw: unknown): UrlSafetyResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return reject('url must be a non-empty string');
  }
  if (raw.length > MAX_URL_LENGTH) {
    return reject(`url must be at most ${MAX_URL_LENGTH} characters`);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return reject('url must be an absolute http(s) URL');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return reject(`url scheme ${parsed.protocol} is not allowed, use http or https`);
  }
  if (parsed.username || parsed.password) {
    return reject('url must not embed credentials');
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    return reject('url must include a hostname');
  }
  if (isBlockedHostname(hostname)) {
    return reject(`host ${stripBrackets(hostname)} is not an allowed webhook target`);
  }

  const addressClass = classifyHost(hostname);
  if (addressClass === 'blocked') {
    return reject(`address ${stripBrackets(hostname)} is not an allowed webhook target`);
  }
  if (addressClass === 'dev-ok' && process.env.NODE_ENV === 'production') {
    return reject(`address ${stripBrackets(hostname)} is not routable from production`);
  }

  return { ok: true };
}

/**
 * Syntax pass plus a DNS resolution pass: a public-looking hostname is only
 * accepted if every address it resolves to is publicly routable, which
 * defeats DNS rebinding aimed at loopback or link-local targets.
 */
export async function checkWebhookUrl(raw: unknown): Promise<UrlSafetyResult> {
  const syntax = checkWebhookUrlSyntax(raw);
  if (!syntax.ok) return syntax;

  const hostname = stripBrackets(new URL(raw as string).hostname.toLowerCase());
  if (net.isIP(hostname)) return syntax;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return reject(`host ${hostname} could not be resolved`);
  }
  if (!addresses.length) {
    return reject(`host ${hostname} did not resolve to any address`);
  }

  const production = process.env.NODE_ENV === 'production';
  for (const { address } of addresses) {
    const addressClass = classifyHost(address);
    if (addressClass === 'blocked') {
      return reject(`host ${hostname} resolves to blocked address ${address}`);
    }
    if (addressClass === 'dev-ok' && production) {
      return reject(`host ${hostname} resolves to non-routable address ${address}`);
    }
  }

  return syntax;
}

/** Throws with a user-facing reason when the URL is not safe to fetch. */
export async function assertSafeWebhookUrl(raw: unknown): Promise<void> {
  const result = await checkWebhookUrl(raw);
  if (!result.ok) {
    throw new Error(result.reason || 'url is not an allowed webhook target');
  }
}

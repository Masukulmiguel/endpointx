/**
 * CORS origin allowlist.
 *
 * The API runs on Render while the dashboard can be reached from three
 * different places: the hosted SPA, a local vite dev server, and the packaged
 * Electron shell (which serves its UI from http://127.0.0.1:<ephemeral port>).
 * Everything else is refused - a wildcard would let any site that can reach
 * the network read authenticated API responses.
 *
 * Read at call time, not import time, so tests and runtime share one source
 * of truth and a settings change does not require a restart to be picked up
 * by new requests.
 */
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1)$/;

/**
 * Deployments used when FRONTEND_URL is not configured: the API's own origin
 * (agent install pages, same-origin dashboard) and the hosted dashboard SPA,
 * which is a different Render service and reaches this API cross-origin.
 * Render's live service never received the render.yaml FRONTEND_URL, so the
 * dashboard origin must be allowed by default or every login is CORS-blocked.
 */
const DEFAULT_ORIGINS = [
  'https://endpointx.onrender.com',
  'https://endpointx-dashboard.onrender.com',
];

const configuredOrigins = (): string[] => {
  const raw = process.env.FRONTEND_URL;
  if (!raw) return DEFAULT_ORIGINS;
  const list = raw
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ORIGINS;
};

const isLocalOrigin = (origin: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.search || parsed.hash) return false;
  return LOCAL_HOSTS.test(parsed.hostname);
};

/**
 * @param origin the Origin header, or undefined when the client sent none
 *   (agents, curl, server-to-server).
 * @returns true when the origin may read API responses with credentials.
 */
export const isAllowedOrigin = (origin?: string | null): boolean => {
  if (origin === undefined || origin === null) return true;

  const candidate = origin.trim().replace(/\/+$/, '');
  if (!candidate) return true;
  if (isLocalOrigin(candidate)) return true;

  return configuredOrigins().some((allowed) => candidate === allowed);
};

import { getSettingsMap } from '../settings';

/**
 * Hard limits for seefast engine runs.
 *
 * Precedence (12-factor): env `CYBERLAB_*` > settings `cyberlab_*` > defaults.
 * Settings store MB/seconds/jobs; conversion to bytes/ms happens once per
 * cache refresh. The result is cached in memory for 60s — callers that write
 * settings (PUT /config) must call invalidateLimitsCache() so the next read
 * reflects the change immediately.
 */

export interface SeefastLimits {
  maxArtifactBytes: number;
  jobTimeoutMs: number;
  maxStdoutBytes: number;
  maxConcurrentJobs: number;
}

const DEFAULT_LIMITS: SeefastLimits = {
  maxArtifactBytes: 25 * 1024 * 1024,
  jobTimeoutMs: 120_000,
  maxStdoutBytes: 5 * 1024 * 1024,
  maxConcurrentJobs: 1,
};

const CACHE_TTL_MS = 60_000;

const SETTING_MAX_ARTIFACT_MB = 'cyberlab_max_artifact_mb';
const SETTING_JOB_TIMEOUT_S = 'cyberlab_job_timeout_s';
const SETTING_MAX_CONCURRENT = 'cyberlab_max_concurrent';

let cached: SeefastLimits | null = null;
let cachedAt = 0;

const positiveInt = (raw: unknown): number | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

const envInt = (name: string): number | null => positiveInt(process.env[name]);

/** Resolve the effective limits (env > settings > defaults), cached for 60s. */
export async function getLimits(): Promise<SeefastLimits> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return { ...cached };

  const limits: SeefastLimits = { ...DEFAULT_LIMITS };

  try {
    const settings = await getSettingsMap([SETTING_MAX_ARTIFACT_MB, SETTING_JOB_TIMEOUT_S, SETTING_MAX_CONCURRENT]);
    const artifactMb = positiveInt(settings[SETTING_MAX_ARTIFACT_MB]);
    if (artifactMb !== null) limits.maxArtifactBytes = artifactMb * 1024 * 1024;
    const timeoutS = positiveInt(settings[SETTING_JOB_TIMEOUT_S]);
    if (timeoutS !== null) limits.jobTimeoutMs = timeoutS * 1000;
    const concurrent = positiveInt(settings[SETTING_MAX_CONCURRENT]);
    if (concurrent !== null) limits.maxConcurrentJobs = concurrent;
  } catch {
    // Settings unreachable (DB down) must never break callers — env/defaults still apply.
  }

  const envArtifactMb = envInt('CYBERLAB_MAX_ARTIFACT_MB');
  if (envArtifactMb !== null) limits.maxArtifactBytes = envArtifactMb * 1024 * 1024;
  const envTimeoutS = envInt('CYBERLAB_JOB_TIMEOUT_S');
  if (envTimeoutS !== null) limits.jobTimeoutMs = envTimeoutS * 1000;
  const envConcurrent = envInt('CYBERLAB_MAX_CONCURRENT');
  if (envConcurrent !== null) limits.maxConcurrentJobs = envConcurrent;
  const envStdoutMb = envInt('CYBERLAB_MAX_STDOUT_MB');
  if (envStdoutMb !== null) limits.maxStdoutBytes = envStdoutMb * 1024 * 1024;

  cached = limits;
  cachedAt = Date.now();
  return { ...limits };
}

/** Drop the in-memory cache (PUT /config calls this after writing settings). */
export function invalidateLimitsCache(): void {
  cached = null;
  cachedAt = 0;
}

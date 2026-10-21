import { execFile } from 'child_process';
import fs from 'fs';

/**
 * Capability probe for the external engine (operator-supplied binary via the
 * `SEEFAST_CLI` env var). No env → `not_configured` without ever spawning.
 */

export type ProviderStatus = {
  available: boolean;
  reason: 'not_configured' | 'probe_failed' | null;
  version: string | null;
  detail: string | null;
};

const PROBE_TIMEOUT_MS = 15_000;
const DETAIL_MAX_CHARS = 200;

function sanitizeDetail(raw: string, cli: string): string {
  let detail = raw.replace(/\s+/g, ' ').trim();
  if (cli) detail = detail.split(cli).join('SEEFAST_CLI');
  if (detail.length > DETAIL_MAX_CHARS) detail = detail.slice(0, DETAIL_MAX_CHARS);
  return detail;
}

function extractVersion(stdout: string): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && 'version' in parsed) {
      const version = (parsed as { version: unknown }).version;
      if (typeof version === 'string' && version.trim()) return version.trim();
    }
  } catch {
    // Non-JSON probe output → honest null, never a guessed version.
  }
  return null;
}

/**
 * Whether the configured path can actually be run.
 *
 * A path that does not exist, is not a file, or carries no execute bit is
 * not a broken engine — it is an engine that was never put there. Reporting
 * that as a probe failure would blame the engine for a missing file, and
 * would send the operator looking in the wrong place. It also spares the
 * probe a pointless spawn.
 */
function isRunnablePath(cli: string): boolean {
  try {
    const stats = fs.statSync(cli);
    if (!stats.isFile()) return false;
    if (process.platform === 'win32') return true; // no execute bit on Windows
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Probe the engine's capabilities. Never spawns when SEEFAST_CLI is unset. */
export async function probeCapabilities(): Promise<ProviderStatus> {
  const cli = (process.env.SEEFAST_CLI || '').trim();
  if (!cli) return { available: false, reason: 'not_configured', version: null, detail: null };
  // A configured path with nothing at it is "not configured", not a failed
  // probe: nothing ran, so nothing failed.
  if (!isRunnablePath(cli)) {
    return { available: false, reason: 'not_configured', version: null, detail: null };
  }

  return new Promise<ProviderStatus>((resolve) => {
    const fail = (error: Error, stderr: string): void => {
      const raw = (stderr && stderr.trim()) || error.message || 'probe failed';
      resolve({
        available: false,
        reason: 'probe_failed',
        version: null,
        detail: sanitizeDetail(raw, cli) || 'probe failed',
      });
    };

    try {
      execFile(cli, ['capabilities', '--json'], { timeout: PROBE_TIMEOUT_MS }, (error, stdout, stderr) => {
        if (error) {
          fail(error, String(stderr ?? ''));
          return;
        }
        resolve({ available: true, reason: null, version: extractVersion(String(stdout ?? '')), detail: null });
      });
    } catch (error) {
      fail(error as Error, '');
    }
  });
}

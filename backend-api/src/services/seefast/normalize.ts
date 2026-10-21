import type { JobType } from './adapter';

/**
 * Engine output → findings normalisation (static analysis only, zero
 * inference): non-JSON or truncated stdout is NEVER turned into findings;
 * valid JSON yields one `fact` finding per field that is *actually present*
 * in the output (absent field ⇒ no finding). Per-type extractors are exact
 * key matches — no aliasing, no guessing.
 */

export type NewFinding = {
  kind: 'fact' | 'indicator' | 'hypothesis' | 'validated_vuln' | 'inconclusive' | 'false_positive' | 'recommendation';
  title: string;
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  confidence: 'high' | 'medium' | 'low';
  evidence: {
    source: string;
    method: string;
    observed_at: string;
    limitations: string[];
    details: Record<string, unknown>;
  };
};

export type NormalizeOutcome =
  | { ok: true; summary: string; findings: NewFinding[]; limitations: string[] }
  | { ok: false; reason: 'unparsable' | 'truncated' };

export const STATIC_LIMITATION = 'análise estática; sem execução';

type ExtractRule = { key: string; label: string; type: 'number' | 'string' };

// Count-ish fields the engine emits per operation. Only these exact keys are
// read; anything else in the output stays in evidence.details-free raw form.
const EXTRACT_RULES: Record<JobType, ExtractRule[]> = {
  js_analysis: [
    { key: 'module_count', label: 'modules detected', type: 'number' },
    { key: 'ipc_count', label: 'IPC channels detected', type: 'number' },
    { key: 'native_addon_count', label: 'native addons detected', type: 'number' },
  ],
  go_binary: [
    { key: 'compiler_version', label: 'compiler version', type: 'string' },
    { key: 'module_count', label: 'modules detected', type: 'number' },
  ],
  rust_binary: [{ key: 'package_count', label: 'packages detected', type: 'number' }],
};

function collectOutputLimitations(record: Record<string, unknown>): string[] {
  const raw = record.limitations;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim());
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeJobResult(type: JobType, rawStdout: string, truncated: boolean): NormalizeOutcome {
  if (truncated) return { ok: false, reason: 'truncated' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawStdout);
  } catch {
    return { ok: false, reason: 'unparsable' };
  }

  const record = isPlainObject(parsed) ? parsed : {};
  const outputLimitations = collectOutputLimitations(record);
  const limitations = [STATIC_LIMITATION, ...outputLimitations.filter((l) => l !== STATIC_LIMITATION)];

  const findings: NewFinding[] = [];
  if (isPlainObject(parsed)) {
    const observedAt = new Date().toISOString();
    for (const rule of EXTRACT_RULES[type]) {
      const value = parsed[rule.key];
      const present =
        rule.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === 'string' && value.trim() !== '';
      if (!present) continue;
      findings.push({
        kind: 'fact',
        title: `${rule.label}: ${String(value)}`,
        severity: 'info',
        confidence: 'high',
        evidence: {
          source: `seefast:${type}`,
          method: `static:${type}`,
          observed_at: observedAt,
          limitations,
          details: { [rule.key]: value },
        },
      });
    }
  }

  const summary =
    findings.length > 0
      ? `${type}: ${findings.map((f) => f.title).join('; ')}`
      : `${type}: analysis completed; no extractable fields`;

  return { ok: true, summary, findings, limitations };
}

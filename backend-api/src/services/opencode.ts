import logger from '../utils/logger';

const OPENCODE_URL = (process.env.OPENCODE_SERVER_URL || '').replace(/\/$/, '');
const OPENCODE_USERNAME = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
const OPENCODE_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || '';
const OPENCODE_MODEL = process.env.OPENCODE_MODEL || '';
const OPENCODE_TIMEOUT_MS = parseInt(process.env.OPENCODE_TIMEOUT_MS || '60000', 10);

export function isOpencodeConfigured(): boolean {
  return Boolean(OPENCODE_URL);
}

async function opencodeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!OPENCODE_URL) {
    throw new Error('OPENCODE_SERVER_URL não configurado');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  if (OPENCODE_PASSWORD) {
    const token = Buffer.from(`${OPENCODE_USERNAME}:${OPENCODE_PASSWORD}`).toString('base64');
    headers.Authorization = `Basic ${token}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENCODE_TIMEOUT_MS);
  try {
    return await fetch(`${OPENCODE_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function opencodeHealth(): Promise<{ ok: boolean; version?: string; error?: string }> {
  if (!OPENCODE_URL) {
    return { ok: false, error: 'OPENCODE_SERVER_URL não configurado' };
  }
  try {
    const res = await opencodeFetch('/global/health');
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { healthy?: boolean; version?: string };
    return { ok: Boolean(body.healthy), version: body.version };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

type OpencodePart = { type: string; text?: string; [key: string]: unknown };

function extractText(parts: OpencodePart[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
    .trim();
}

export async function opencodeComplete(prompt: string, system?: string): Promise<string> {
  if (!OPENCODE_URL) {
    throw new Error('OPENCODE_SERVER_URL não configurado');
  }

  const sessionRes = await opencodeFetch('/session', {
    method: 'POST',
    body: JSON.stringify({ title: 'HERMES AI' }),
  });
  if (!sessionRes.ok) {
    throw new Error(`Falha ao criar sessão opencode (HTTP ${sessionRes.status})`);
  }
  const session = (await sessionRes.json()) as { id?: string };
  const sessionId = session.id;
  if (!sessionId) {
    throw new Error('Sessão opencode sem id');
  }

  try {
    const messageBody: Record<string, unknown> = {
      parts: [{ type: 'text', text: prompt }],
    };
    if (system) messageBody.system = system;
    if (OPENCODE_MODEL) messageBody.model = OPENCODE_MODEL;
    messageBody.agent = 'build';

    const msgRes = await opencodeFetch(`/session/${sessionId}/message`, {
      method: 'POST',
      body: JSON.stringify(messageBody),
    });
    if (!msgRes.ok) {
      const errText = await msgRes.text().catch(() => '');
      throw new Error(`Falha na mensagem opencode (HTTP ${msgRes.status}) ${errText.slice(0, 200)}`);
    }
    const body = (await msgRes.json()) as { parts?: OpencodePart[] };
    const text = extractText(body.parts);
    if (!text) {
      throw new Error('Resposta opencode vazia');
    }
    return text;
  } finally {
    try {
      await opencodeFetch(`/session/${sessionId}`, { method: 'DELETE' }).catch(() => undefined);
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function analyzeSecurityContext(context: {
  assets?: number;
  openFindings?: Array<{
    title: string;
    severity: string;
    hostname?: string;
    cve_id?: string;
    description?: string;
  }>;
  scanStats?: Record<string, number>;
  postureScore?: number;
  locale?: string;
}): Promise<string> {
  const locale = context.locale === 'en' ? 'English' : 'Portuguese (pt-PT)';
  const findings = (context.openFindings || []).slice(0, 25);
  const payload = {
    assets: context.assets ?? 0,
    posture_score: context.postureScore ?? null,
    scan_stats: context.scanStats ?? {},
    open_findings: findings,
  };

  const prompt = [
    `You are the HERMES security analyst inside EndpointX. Reply in ${locale}.`,
    'Analyze the JSON below and return a concise executive security briefing:',
    '1) Top risks (max 5 bullets)',
    '2) Immediate actions (ordered, practical)',
    '3) What looks healthy',
    '4) Overall risk level: low|medium|high|critical',
    'Keep it under 400 words. No markdown code fences.',
    '',
    JSON.stringify(payload),
  ].join('\n');

  return opencodeComplete(prompt, 'You are a precise cybersecurity analyst. Be factual and terse.');
}

export async function recommendForFinding(finding: {
  title: string;
  severity: string;
  description?: string;
  hostname?: string;
  cve_id?: string;
}, locale = 'pt'): Promise<string> {
  const lang = locale === 'en' ? 'English' : 'Portuguese (pt-PT)';
  const prompt = [
    `You are HERMES remediation advisor in EndpointX. Reply in ${lang}.`,
    'Given this finding, provide:',
    '- Risk explanation (2 sentences)',
    '- Step-by-step remediation',
    '- Verification check',
    'Finding:',
    JSON.stringify({
      title: finding.title,
      severity: finding.severity,
      description: finding.description,
      hostname: finding.hostname,
      cve_id: finding.cve_id,
    }),
  ].join('\n');

  return opencodeComplete(prompt, 'You are a practical SOC remediation advisor.');
}

export { logger };

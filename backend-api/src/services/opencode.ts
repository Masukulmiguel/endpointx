import logger from '../utils/logger';

const OPENCODE_URL = (process.env.OPENCODE_SERVER_URL || '').replace(/\/$/, '');
const OPENCODE_USERNAME = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
const OPENCODE_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || '';
const OPENCODE_MODEL = process.env.OPENCODE_MODEL || '';
const OPENCODE_TIMEOUT_MS = parseInt(process.env.OPENCODE_TIMEOUT_MS || '60000', 10);

export function isOpencodeConfigured(): boolean {
  return Boolean(OPENCODE_URL);
}

export function localAnalyzeSecurityContext(context: {
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
}): string {
  const pt = context.locale !== 'en';
  const findings = context.openFindings || [];
  const assets = context.assets ?? 0;
  const posture = context.postureScore ?? 0;
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const high = findings.filter((f) => f.severity === 'high').length;
  const medium = findings.filter((f) => f.severity === 'medium').length;
  const low = findings.filter((f) => f.severity === 'low').length;
  const failedScans = context.scanStats?.failed ?? 0;
  const completedScans = context.scanStats?.completed ?? 0;

  const risk =
    critical > 0 ? 'critical' : high > 0 ? 'high' : medium > 0 || low > 0 ? 'medium' : 'low';

  const top = findings.slice(0, 5);
  const riskBullets =
    top.length > 0
      ? top.map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}${f.hostname ? ` (${f.hostname})` : ''}${f.cve_id ? ` — ${f.cve_id}` : ''}`)
      : pt
        ? ['1. Sem findings abertos com severidade elevada.']
        : ['1. No open findings at high severity.'];

  const actions = pt
    ? [
        critical > 0 ? 'Priorizar remediação dos findings críticos.' : null,
        high > 0 ? 'Revisar findings de severidade alta esta semana.' : null,
        failedScans > 0 ? `Investigar ${failedScans} scan(s) HERMES falhados.` : null,
        posture < 70 ? 'Melhorar a postura de segurança dos ativos autorizados.' : null,
        'Manter agentes no mínimo 1.1.0 e confirmar heartbeats recentes.',
      ].filter(Boolean) as string[]
    : [
        critical > 0 ? 'Remediate critical findings first.' : null,
        high > 0 ? 'Review high-severity findings this week.' : null,
        failedScans > 0 ? `Investigate ${failedScans} failed HERMES scan(s).` : null,
        posture < 70 ? 'Improve security posture on authorized assets.' : null,
        'Keep agents at 1.1.0+ and verify recent heartbeats.',
      ].filter(Boolean) as string[];

  const healthy = pt
    ? [
        `Postura média dos ativos: ${posture}/100.`,
        completedScans > 0 ? `${completedScans} scan(s) concluído(s).` : null,
        assets > 0 ? `${assets} ativo(s) sob gestão HERMES.` : null,
        'Sem indícios de paragem de emergência ativa.',
      ].filter(Boolean) as string[]
    : [
        `Average asset posture: ${posture}/100.`,
        completedScans > 0 ? `${completedScans} completed scan(s).` : null,
        assets > 0 ? `${assets} asset(s) under HERMES management.` : null,
        'No emergency stop active.',
      ].filter(Boolean) as string[];

  const lines = pt
    ? [
        'Briefing de segurança HERMES (análise local — opencode não configurado no servidor).',
        '',
        '1) Principais riscos',
        ...riskBullets,
        `   Findings: ${critical} crítico(s), ${high} alto(s), ${medium} médio(s), ${low} baixo(s).`,
        '',
        '2) Ações imediatas',
        ...actions.map((a, i) => `${i + 1}. ${a}`),
        '',
        '3) O que parece saudável',
        ...healthy.map((a, i) => `${i + 1}. ${a}`),
        '',
        `4) Nível de risco global: ${risk}`,
        '',
        'Nota: configure OPENCODE_SERVER_URL no Render para briefing gerado por IA real.',
      ]
    : [
        'HERMES security briefing (local analysis — opencode not configured on the server).',
        '',
        '1) Top risks',
        ...riskBullets,
        `   Findings: ${critical} critical, ${high} high, ${medium} medium, ${low} low.`,
        '',
        '2) Immediate actions',
        ...actions.map((a, i) => `${i + 1}. ${a}`),
        '',
        '3) What looks healthy',
        ...healthy.map((a, i) => `${i + 1}. ${a}`),
        '',
        `4) Overall risk level: ${risk}`,
        '',
        'Note: set OPENCODE_SERVER_URL on Render for real AI-generated briefings.',
      ];

  return lines.join('\n');
}

export function localRecommendForFinding(
  finding: {
    title: string;
    severity: string;
    description?: string;
    hostname?: string;
    cve_id?: string;
  },
  locale = 'pt'
): string {
  const pt = locale !== 'en';
  const sev = (finding.severity || 'medium').toLowerCase();
  const risk =
    pt
      ? `Este finding de severidade ${sev} ${finding.cve_id ? `(${finding.cve_id})` : ''} representa risco ${sev === 'critical' || sev === 'high' ? 'elevado' : 'moderado'} para ${finding.hostname || 'o ativo afetado'}.`
      : `This ${sev} severity finding ${finding.cve_id ? `(${finding.cve_id})` : ''} poses ${sev === 'critical' || sev === 'high' ? 'high' : 'moderate'} risk to ${finding.hostname || 'the affected asset'}.`;

  const steps = pt
    ? [
        '1. Confirmar o ativo e o impacto (host, serviços expostos, dados sensíveis).',
        '2. Aplicar patch/configuração recomendada pelo vendor ou regra HERMES.',
        '3. Isolar temporariamente se for crítico e não houver correção imediata.',
        '4. Reexecutar o scan HERMES no ativo para validar a remediação.',
        '5. Registar a exceção no dashboard se houver justificação de negócio.',
      ]
    : [
        '1. Confirm asset and impact (host, exposed services, sensitive data).',
        '2. Apply the vendor/HERMES recommended patch or configuration.',
        '3. Temporarily isolate if critical and no immediate fix exists.',
        '4. Re-run the HERMES scan on the asset to verify remediation.',
        '5. Document an exception in the dashboard if there is a business justification.',
      ];

  const verify = pt
    ? 'Verificação: novo scan sem o finding aberto + heartbeat OK + sem novos alertas related em 24h.'
    : 'Verification: new scan without the open finding + OK heartbeat + no related alerts in 24h.';

  return [
    pt ? 'Recomendação de remediação HERMES (análise local).' : 'HERMES remediation recommendation (local analysis).',
    '',
    pt ? 'Risco' : 'Risk',
    risk,
    finding.description ? finding.description.slice(0, 400) : '',
    '',
    pt ? 'Remediação passo a passo' : 'Step-by-step remediation',
    ...steps,
    '',
    pt ? 'Verificação' : 'Verification',
    verify,
    '',
    pt
      ? 'Nota: configure OPENCODE_SERVER_URL para recomendações geradas por IA real.'
      : 'Note: set OPENCODE_SERVER_URL for real AI-generated recommendations.',
  ]
    .filter((l) => l !== '')
    .join('\n');
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

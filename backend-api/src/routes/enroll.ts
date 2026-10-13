import { Router, Response, NextFunction } from 'express';
import express from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest } from '../middleware/auth';
import { JWT } from '../config/constants';
import logger from '../utils/logger';
import {
  buildInstallCommands,
  buildInviteUrl,
  getInviteByToken,
  getRequestByInstallJti,
  markDelivered,
  recordDecision,
  type InstallRequestRow,
} from '../services/installRequests';

const router = Router();

// TEMP DIAGNOSTIC - remove after root-causing 42703
import { query as dbQuery } from '../config/database';
router.get('/_diag', async (_req, res) => {
  const probes: Record<string, unknown> = {};
  const run = async (name: string, sql: string) => {
    try {
      const r = await dbQuery(sql);
      probes[name] = { ok: true, rows: r.rowCount };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      probes[name] = { ok: false, code: err.code, message: err.message };
    }
  };
  await run('table_exists', `SELECT to_regclass('installation_requests') AS t`);
  await run('star', `SELECT r.* FROM installation_requests r LIMIT 0`);
  await run('token_where', `SELECT r.invite_token FROM installation_requests r LIMIT 0`);
  await run('join_nodes', `SELECT r.id FROM installation_requests r JOIN network_nodes n ON n.id = r.node_id LIMIT 0`);
  await run('cols', `SELECT column_name, data_type FROM information_schema.columns WHERE table_name='installation_requests' ORDER BY ordinal_position`);
  res.json(probes);
});

// Public, unauthenticated consent surface for installation requests.
// The invite link (opaque 64-hex token) is delivered out-of-band (email, chat,
// QR). Two channels reach a decision here:
//   A) the HTML page below (any OS with a browser) - pure server-rendered
//      forms, no inline JS, so the global CSP (script-src 'self') holds.
//   B) the native dialog inside install.ps1, which POSTs /decision JSON with
//      the install JWT it received as ?t=.
// Both funnel into recordDecision() so the state machine stays single-sourced.

router.use(express.urlencoded({ extended: false }));

const DECISIONS = ['authorize', 'refuse'] as const;
type Decision = (typeof DECISIONS)[number];

function isDecision(v: unknown): v is Decision {
  return v === 'authorize' || v === 'refuse';
}

function wantsHtml(req: AuthRequest): boolean {
  const accept = String(req.headers.accept || '');
  return accept.includes('text/html');
}

// Resolve a decision token: either the raw invite token (64-hex) or the
// install JWT minted for this request (what install.ps1 carries as ?t=).
async function resolveDecisionRow(
  raw: unknown
): Promise<{ row: InstallRequestRow | null; reason: string }> {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) return { row: null, reason: 'missing_token' };

  if (/^[a-f0-9]{64}$/i.test(token)) {
    const row = await getInviteByToken(token);
    return { row, reason: row ? 'ok' : 'not_found' };
  }

  try {
    const payload = jwt.verify(token, JWT.ACCESS_SECRET) as {
      typ?: unknown;
      jti?: unknown;
    };
    if (payload?.typ !== 'install' || typeof payload.jti !== 'string' || !payload.jti) {
      return { row: null, reason: 'invalid_token' };
    }
    const row = await getRequestByInstallJti(payload.jti);
    return { row, reason: row ? 'ok' : 'not_found' };
  } catch {
    return { row: null, reason: 'invalid_token' };
  }
}

// Shared POST handler for both decision endpoints (web form / device JSON).
async function handleDecision(
  req: AuthRequest,
  res: Response,
  channel: 'web' | 'device'
): Promise<void> {
  const decision: unknown = req.body?.decision;
  if (!isDecision(decision)) {
    if (wantsHtml(req)) {
      res.status(400).type('html').send(resultPage(null, 'bad_decision'));
      return;
    }
    res.status(400).json({ success: false, error: { message: 'decision must be authorize|refuse' } });
    return;
  }
  const tokenSource = channel === 'web' ? req.params.token : req.body?.token;
  const { row, reason } = await resolveDecisionRow(tokenSource);
  if (!row) {
    if (wantsHtml(req)) {
      res.status(reason === 'not_found' ? 404 : 400).type('html').send(resultPage(null, reason));
      return;
    }
    res.status(reason === 'not_found' ? 404 : 400).json({ success: false, error: { message: reason } });
    return;
  }
  const result = await recordDecision(row.invite_token, decision, channel);
  if (!result.ok) {
    if (wantsHtml(req)) {
      res.status(400).type('html').send(resultPage(row, result.reason || 'invalid_state'));
      return;
    }
    res.status(400).json({ success: false, error: { message: result.reason } });
    return;
  }
  const updated = result.request as InstallRequestRow;
  logger.info('Install decision recorded', { request_id: row.id, decision, channel });

  if (wantsHtml(req)) {
    const commands =
      decision === 'authorize'
        ? buildInstallCommands({ id: updated.requested_by || '' }, updated)
        : null;
    res.type('html').send(resultPage(updated, 'ok', commands));
    return;
  }
  res.json({
    success: true,
    data: {
      status: updated.status,
      commands:
        decision === 'authorize'
          ? buildInstallCommands({ id: updated.requested_by || '' }, updated)
          : null,
      invitation_url: buildInviteUrl(updated.invite_token),
    },
  });
}

// ---------------------------------------------------------------------------
// GET /invite/:token - the consent page. Marks the request delivered on first
// real open (preview=1 lets the admin inspect without touching the state).
// ---------------------------------------------------------------------------
router.get('/invite/:token', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const token = String(req.params.token || '');
    const preview = req.query.preview === '1';
    const row = await getInviteByToken(token);
    if (!row) {
      res.status(404).type('html').send(consentPage(null, 'not_found'));
      return;
    }
    if (!preview) await markDelivered(row.id);
    const fresh = preview ? row : ((await getInviteByToken(token)) ?? row);
    // Re-opening an already-authorized link shows the commands right away.
    const commands =
      fresh.status === 'authorized'
        ? buildInstallCommands({ id: fresh.requested_by || '' }, fresh)
        : null;
    res.type('html').send(consentPage(fresh, 'ok', commands));
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /invite/:token/decision - the page's authorize/refuse form action.
// ---------------------------------------------------------------------------
router.post('/invite/:token/decision', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await handleDecision(req, res, 'web');
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /decision - device-channel decision (install.ps1 native dialog).
// Body: { token: <install JWT>, decision: authorize|refuse }.
// ---------------------------------------------------------------------------
router.post('/decision', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await handleDecision(req, res, 'device');
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Pages (self-contained HTML, dark theme, pt-PT, CSP-safe: no inline JS).
// ---------------------------------------------------------------------------
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const BASE_CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: #0b1220; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 560px; background: #111a2e; border: 1px solid #1e2d4a; border-radius: 16px; padding: 32px; box-shadow: 0 20px 60px rgba(0,0,0,.45); }
  .logo { font-size: 22px; font-weight: 700; letter-spacing: .12em; color: #22d3ee; margin-bottom: 4px; }
  .sub { color: #64748b; font-size: 13px; margin-bottom: 24px; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 12px; color: #f1f5f9; }
  p  { font-size: 14px; line-height: 1.6; color: #94a3b8; margin-bottom: 12px; }
  .device { background: #0b1220; border: 1px solid #1e2d4a; border-radius: 10px; padding: 14px 16px; margin: 16px 0; font-size: 13px; }
  .device div { display: flex; justify-content: space-between; padding: 3px 0; gap: 16px; }
  .device span:first-child { color: #64748b; flex-shrink: 0; }
  .device span:last-child { color: #e2e8f0; font-family: Consolas, monospace; text-align: right; word-break: break-all; }
  .actions { display: flex; gap: 12px; margin-top: 20px; }
  button { flex: 1; padding: 12px 16px; border-radius: 10px; border: none; font-size: 14px; font-weight: 600; cursor: pointer; transition: filter .15s; }
  button:hover { filter: brightness(1.12); }
  .yes { background: #0891b2; color: #fff; }
  .no  { background: #1e293b; color: #cbd5e1; border: 1px solid #334155; }
  .banner { border-radius: 10px; padding: 14px 16px; font-size: 14px; margin-top: 16px; line-height: 1.5; }
  .ok   { background: rgba(8,145,178,.12); border: 1px solid #0e7490; color: #67e8f9; }
  .err  { background: rgba(239,68,68,.1);  border: 1px solid #b91c1c; color: #fca5a5; }
  .info { background: rgba(148,163,184,.08); border: 1px solid #334155; color: #94a3b8; }
  .cmds { margin-top: 14px; }
  .cmds label { font-size: 12px; color: #64748b; display: block; margin: 12px 0 4px; }
  .cmds pre { background: #0b1220; border: 1px solid #1e2d4a; border-radius: 8px; padding: 12px; font-size: 12px; overflow-x: auto; color: #a5f3fc; font-family: Consolas, monospace; white-space: pre-wrap; word-break: break-all; user-select: all; }
  .back { display: inline-block; margin-top: 18px; color: #22d3ee; font-size: 13px; text-decoration: none; }
  .foot { margin-top: 20px; font-size: 11px; color: #475569; text-align: center; }
`;

function page(title: string, inner: string): string {
  return `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${BASE_CSS}</style></head><body><div class="card">
    <div class="logo">&#x2B21; ENDPOINTX</div><div class="sub">Gestao de endpoints</div>
    ${inner}
  </div></body></html>`;
}

function deviceBox(row: InstallRequestRow): string {
  return `<div class="device">
    <div><span>Dispositivo</span><span>${esc(row.node_hostname || row.node_ip || 'desconhecido')}</span></div>
    <div><span>Endereco IP</span><span>${esc(row.node_ip || '-')}</span></div>
    <div><span>MAC</span><span>${esc(row.node_mac || '-')}</span></div>
  </div>`;
}

function commandsBlock(commands: { windows: string; linux: string; macos: string }): string {
  return `<div class="cmds">
    <label>Windows (PowerShell)</label><pre>${esc(commands.windows)}</pre>
    <label>Linux</label><pre>${esc(commands.linux)}</pre>
    <label>macOS</label><pre>${esc(commands.macos)}</pre>
    <p style="margin-top:10px;font-size:12px;color:#64748b">Selecione o comando da plataforma deste computador e copie-o.</p>
  </div>`;
}

function consentPage(
  row: InstallRequestRow | null,
  mode: 'ok' | 'not_found',
  commands: { windows: string; linux: string; macos: string } | null = null
): string {
  const title = 'EndpointX - Pedido de instalacao do agente';
  if (mode === 'not_found' || !row) {
    return page(
      title,
      `<h1>Ligacao invalida</h1>
       <p>O pedido de instalacao nao existe ou o link expirou. Contacte o administrador da rede para gerar um novo convite.</p>
       <div class="banner err">Link invalido ou expirado.</div>`
    );
  }

  const expired = new Date(row.expires_at).getTime() < Date.now();
  const foot = `<div class="foot">EndpointX &middot; Pedido ${esc(row.id.slice(0, 8))} &middot; Expira ${esc(new Date(row.expires_at).toLocaleString('pt-PT'))}</div>`;

  if (expired && row.status !== 'authorized' && row.status !== 'refused') {
    return page(
      title,
      `<h1>Pedido expirado</h1><p>Este pedido de instalacao expirou e ja nao pode ser aceite.</p>${deviceBox(row)}
       <div class="banner info">Peca ao administrador da rede um novo convite.</div>${foot}`
    );
  }

  switch (row.status) {
    case 'refused':
      return page(
        title,
        `<h1>Instalacao recusada</h1><p>Registada a recusa. Nada foi instalado neste computador.</p>${deviceBox(row)}
         <div class="banner info">Se mudar de ideias, contacte o administrador da rede.</div>${foot}`
      );
    case 'cancelled':
      return page(
        title,
        `<h1>Pedido cancelado</h1><p>Este pedido foi cancelado pelo administrador.</p>${deviceBox(row)}${foot}`
      );
    case 'authorized':
    case 'installing':
    case 'installed':
    case 'integrated':
      return page(
        title,
        `<h1>Instalacao autorizada</h1><p>Abra o PowerShell como utilizador e execute o comando da plataforma deste computador:</p>${deviceBox(row)}
         ${commands ? commandsBlock(commands) : `<div class="banner info">Estado: ${esc(row.status)}. Peca ao administrador para reenviar o comando.</div>`}
         <div class="banner ok">Pedido autorizado.</div>${foot}`
      );
    case 'pending':
    case 'delivered':
      return page(
        title,
        `<h1>Pedido de instalacao do agente</h1>
         <p>O administrador da rede solicitou a instalacao do agente <strong>EndpointX</strong> neste computador, para gestao e seguranca do equipamento.</p>
         <p>O agente recolhe metricas de hardware e de rede. Autoriza a instalacao?</p>
         ${deviceBox(row)}
         <form class="actions" method="post" action="/api/enroll/invite/${esc(row.invite_token)}/decision">
           <button class="yes" type="submit" name="decision" value="authorize">Sim, autorizar instalacao</button>
           <button class="no"  type="submit" name="decision" value="refuse">Nao, recusar</button>
         </form>${foot}`
      );
    default:
      return page(
        title,
        `<h1>Estado do pedido</h1><p>Estado atual: <strong>${esc(row.status)}</strong></p>${deviceBox(row)}${foot}`
      );
  }
}

function resultPage(
  row: InstallRequestRow | null,
  code: string,
  commands: { windows: string; linux: string; macos: string } | null = null
): string {
  const title = 'EndpointX - Decisao registada';
  if (!row) {
    return page(
      title,
      `<h1>Erro</h1><div class="banner err">Nao foi possivel registar a decisao (${esc(code)}). Contacte o administrador da rede.</div>`
    );
  }
  if (code === 'ok' && commands) {
    return page(
      title,
      `<h1>Instalacao autorizada</h1><p>Decisao registada. Execute o comando da plataforma deste computador:</p>${deviceBox(row)}
       ${commandsBlock(commands)}
       <a class="back" href="/api/enroll/invite/${esc(row.invite_token)}">Ver esta pagina novamente</a>`
    );
  }
  if (code === 'ok') {
    return page(
      title,
      `<h1>Instalacao recusada</h1><p>Recusa registada. Nada foi instalado neste computador.</p>${deviceBox(row)}
       <div class="banner info">Se mudar de ideias, contacte o administrador da rede.</div>`
    );
  }
  return page(
    title,
    `<h1>Erro</h1><p>Nao foi possivel registar a decisao (${esc(code)}).</p>${row ? deviceBox(row) : ''}
     <div class="banner err">O pedido pode ter expirado ou ja ter sido decidido.</div>`
  );
}

export default router;

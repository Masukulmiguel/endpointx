import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import logger from '../utils/logger';
import { canAccessDevice, visibleDeviceRowsSql } from '../utils/tenant';
import {
  startInvestigation,
  listInvestigations,
  getInvestigation,
} from '../hermes/forensics';

const router = Router();

function newId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

async function audit(action: string, req: AuthRequest, targetType: string, targetId: string, details: any = {}) {
  try {
    await query(
      'INSERT INTO hermes_audit_logs (id, action, actor_id, actor_email, target_type, target_id, details, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [newId(), action, req.user?.id || null, req.user?.email || null, targetType, targetId, JSON.stringify(details), req.ip || null]
    );
  } catch (e) {
    logger.warn('HERMES forensic audit write failed', { action, error: (e as Error).message });
  }
}

const ALLOWED_SECTIONS = ['processes', 'connections', 'files', 'persistence', 'browser', 'events', 'users'];

// ---------------------------------------------------------------------------
// POST /investigations - start a read-only forensic investigation on an alert
// ---------------------------------------------------------------------------
router.post('/investigations', authenticate, requirePermission('hermes.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const alertId = String(req.body?.alert_id || '').trim();
    if (!alertId) {
      res.status(400).json({ success: false, error: { message: 'alert_id is required' } });
      return;
    }

    const rawSections = Array.isArray(req.body?.sections) ? req.body.sections : [];
    const sections = rawSections.filter((s: unknown) => ALLOWED_SECTIONS.includes(String(s)));

    try {
      const investigation = await startInvestigation({
        alertId,
        userId: req.user?.id || null,
        sections: sections.length ? sections : undefined,
      });
      await audit('forensic_investigation_started', req, 'forensic_investigation', investigation.id, { alert_id: alertId });
      res.status(201).json({ success: true, data: { investigation } });
    } catch (err: any) {
      const status = err.statusCode || err.status || 500;
      if (status < 500) {
        logger.warn('Forensic investigation refused', { alertId, message: err.message, status });
        res.status(status).json({
          success: false,
          error: { message: err.message, code: 'INVESTIGATION_NOT_STARTED', investigationId: err.investigationId },
        });
        return;
      }
      throw err;
    }
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /investigations - list investigations (tenant scoped)
// ---------------------------------------------------------------------------
router.get('/investigations', authenticate, requirePermission('hermes.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const deviceId = req.query.device_id ? String(req.query.device_id) : null;
    const limit = parseInt(String(req.query.limit || '50'), 10);
    const scopeParams: any[] = [];
    let scopeSql: string | undefined;
    if (req.user && !req.user.permissions?.includes('devices.view_all')) {
      scopeParams.push(req.user.id || null);
      scopeSql = visibleDeviceRowsSql('i.device_id', 'd.created_by', scopeParams.length, req.user);
    }

    const investigations = await listInvestigations({
      deviceId,
      limit: Number.isFinite(limit) ? limit : 50,
      scopeSql,
      scopeParams,
    });
    res.json({ success: true, data: { investigations } });
  } catch (error) {
    next(error);
  }
});

async function loadInvestigation(req: AuthRequest, res: Response): Promise<any | null> {
  const investigation = await getInvestigation(String(req.params.id));
  if (!investigation) {
    res.status(404).json({ success: false, error: { message: 'Investigation not found' } });
    return null;
  }
  if (investigation.device_id && !(await canAccessDevice(req.user, investigation.device_id))) {
    res.status(404).json({ success: false, error: { message: 'Investigation not found' } });
    return null;
  }
  return investigation;
}

// ---------------------------------------------------------------------------
// GET /investigations/:id - full investigation (artifacts, IOCs, timeline, report)
// ---------------------------------------------------------------------------
router.get('/investigations/:id', authenticate, requirePermission('hermes.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const investigation = await loadInvestigation(req, res);
    if (!investigation) return;
    res.json({ success: true, data: { investigation } });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /investigations/:id/report - report as JSON (default) or Markdown (?format=md)
// ---------------------------------------------------------------------------
router.get('/investigations/:id/report', authenticate, requirePermission('hermes.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const investigation = await loadInvestigation(req, res);
    if (!investigation) return;

    const report = investigation.report || {};
    const format = String(req.query.format || 'json').toLowerCase();

    if (format === 'md' || format === 'markdown') {
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="hermes-investigation-${investigation.id}.md"`
      );
      res.send(renderMarkdown(investigation, report));
      return;
    }

    res.json({ success: true, data: { report } });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// POST /investigations/:id/cancel - stop a queued/collecting investigation
// ---------------------------------------------------------------------------
router.post('/investigations/:id/cancel', authenticate, requirePermission('hermes.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const investigation = await loadInvestigation(req, res);
    if (!investigation) return;

    if (!['queued', 'collecting'].includes(investigation.status)) {
      res.status(409).json({ success: false, error: { message: 'This investigation can no longer be cancelled' } });
      return;
    }

    await query(
      `UPDATE forensic_investigations
          SET status = 'cancelled', error_message = $1, completed_at = NOW()
        WHERE id = $2 AND status IN ('queued','collecting')`,
      [`Cancelled by ${req.user?.email || 'operator'}`, investigation.id]
    );
    if (investigation.command_id) {
      await query(`UPDATE agent_commands SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`, [
        investigation.command_id,
      ]);
    }

    await audit('forensic_investigation_cancelled', req, 'forensic_investigation', investigation.id);
    res.json({ success: true, data: { message: 'Investigation cancelled' } });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Markdown rendering of the stored report (export / print)
// ---------------------------------------------------------------------------
function listBlock(items: any[], render: (item: any) => string): string {
  if (!Array.isArray(items) || items.length === 0) return '_None recorded._\n';
  return `${items.map((item) => `- ${render(item)}`).join('\n')}\n`;
}

function renderMarkdown(inv: any, report: any): string {
  const out: string[] = [];
  const value = (key: string) => report[key];

  out.push(`# HERMES Forensic Investigation ${inv.id}`);
  out.push('');
  out.push(`- **Endpoint:** ${report.endpoint?.hostname || inv.hostname || 'unknown'}`);
  out.push(`- **Original alert:** ${report.original_alert?.title || inv.alert_title || 'n/a'} (${report.original_alert?.severity || inv.alert_severity || 'n/a'})`);
  out.push(`- **Status:** ${inv.status}`);
  out.push(`- **Risk:** ${inv.risk || report.risk || 'info'} · **Confidence:** ${inv.confidence || report.confidence || 'low'}`);
  out.push(`- **Started:** ${inv.started_at || ''} · **Completed:** ${inv.completed_at || ''}`);
  out.push(`- **Read-only collection:** yes (no files, logs, registry keys or processes were modified)`);
  out.push('');

  out.push('## Executive summary');
  out.push('');
  out.push(String(report.executive_summary || inv.summary || '_No summary produced._'));
  out.push('');

  out.push('## Evidence chain');
  out.push('');
  out.push(listBlock(value('evidence_chain'), (item) => String(item)));

  out.push('## Evidence (observations confirmed by collected data)');
  out.push('');
  out.push(listBlock(value('evidence'), (item) => `**${item.title}** — ${item.detail} _(source: ${item.source}, confidence: ${item.confidence})_`));

  out.push('## Indicators');
  out.push('');
  out.push(listBlock(value('indicators'), (item) => `**${item.title}** — ${item.detail} _(severity: ${item.severity}, confidence: ${item.confidence})_`));

  out.push('## Correlations');
  out.push('');
  out.push(listBlock(value('correlations'), (item) => `${item.from} —${item.relation}→ ${item.to} _(basis: ${item.basis})_`));

  out.push('## Hypotheses (not confirmed)');
  out.push('');
  out.push(listBlock(value('hypotheses'), (item) => `**${item.title}** — ${item.detail} _(confidence: ${item.confidence})_`));

  out.push('## IOCs');
  out.push('');
  out.push(listBlock(value('iocs'), (item) => `\`${item.type}\` \`${item.value}\` — ${item.label} _(confidence: ${item.confidence})_`));

  out.push('## Timeline');
  out.push('');
  out.push(
    listBlock(report.timeline || [], (item) => `${item.occurred_at || 'unknown time'} — **${item.event}** (${item.source}) · ${item.entity} · ${item.evidence}`)
  );

  out.push('## Lateral movement');
  out.push('');
  out.push(
    listBlock(value('lateral_movement'), (item) => `\`${item.ioc_type}\` \`${item.value}\` seen on ${item.endpoint_count} endpoint(s): ${(item.devices || []).join(', ')}`)
  );

  out.push('## Gaps (sections not collected)');
  out.push('');
  out.push(listBlock(value('gaps'), (item) => `${item.section} — ${item.reason}`));

  out.push('## Recommendations');
  out.push('');
  out.push(listBlock(value('recommendations'), (item) => String(item)));

  out.push('## Containment options (require explicit authorization)');
  out.push('');
  out.push(listBlock(value('containment_options'), (item) => `${item.action} — ${item.label}${item.available ? '' : ' (unavailable)'}`));

  out.push('## Chain of custody');
  out.push('');
  const custody = report.chain_of_custody || {};
  out.push(`- **Collected by:** ${custody.collected_by || 'n/a'}`);
  out.push(`- **Collected at:** ${custody.collected_at || 'n/a'}`);
  out.push(`- **Analyzed at:** ${custody.analyzed_at || 'n/a'}`);
  out.push(`- **Initiated by:** ${custody.initiated_by || 'n/a'}`);
  out.push(`- **Notes:** ${custody.notes || 'n/a'}`);
  out.push('');

  return out.join('\n');
}

export default router;

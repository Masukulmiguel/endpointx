import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { canViewAllDevices } from '../utils/tenant';
import logger from '../utils/logger';

const router = Router();

// GET /devices/csv - Export devices as CSV
router.get('/devices/csv', authenticate, requirePermission('logs.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const viewAll = canViewAllDevices(req.user);
    const result = await query(
      `SELECT d.hostname, d.os_type, d.status, u.email as user_email, d.last_heartbeat,
              d.cpu_usage, d.ram_usage, d.disk_usage
       FROM devices d
       LEFT JOIN users u ON d.user_id = u.id
       ${viewAll ? '' : 'WHERE d.created_by = $1'}
       ORDER BY d.hostname`,
      viewAll ? [] : [req.user!.id]
    );

    const headers = ['Hostname', 'OS', 'Status', 'User', 'Last Heartbeat', 'CPU%', 'RAM%', 'Disk%'];
    const rows = result.rows.map((row: any) => [
      row.hostname || '',
      row.os_type || '',
      row.status || '',
      row.user_email || '',
      row.last_heartbeat ? new Date(row.last_heartbeat).toISOString() : '',
      row.cpu_usage != null ? Number(row.cpu_usage).toFixed(1) : '',
      row.ram_usage != null ? Number(row.ram_usage).toFixed(1) : '',
      row.disk_usage != null ? Number(row.disk_usage).toFixed(1) : '',
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="devices-report.csv"');
    res.send(csvContent);
  } catch (error) {
    logger.error('Report devices CSV error', { error: (error as Error).message });
    next(error);
  }
});

// GET /devices/pdf - Export devices as PDF
router.get('/devices/pdf', authenticate, requirePermission('logs.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const PDFDocument = require('pdfkit');

    const viewAll = canViewAllDevices(req.user);
    const result = await query(
      `SELECT d.hostname, d.os_type, d.status, u.email as user_email, d.last_heartbeat,
              d.cpu_usage, d.ram_usage, d.disk_usage
       FROM devices d
       LEFT JOIN users u ON d.user_id = u.id
       ${viewAll ? '' : 'WHERE d.created_by = $1'}
       ORDER BY d.hostname`,
      viewAll ? [] : [req.user!.id]
    );

    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="devices-report.pdf"');
    doc.pipe(res);

    doc.fontSize(20).text('EndpointX Device Report', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#666666')
      .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1);

    const headers = ['Hostname', 'OS', 'Status', 'User', 'Last Heartbeat', 'CPU%', 'RAM%', 'Disk%'];
    const colWidths = [120, 100, 70, 150, 140, 60, 60, 60];
    const startX = 40;
    let y = doc.y;

    doc.fontSize(9).fillColor('#333333');
    let x = startX;
    headers.forEach((header, i) => {
      doc.text(header, x, y, { width: colWidths[i], align: 'left' });
      x += colWidths[i];
    });
    y += 20;

    doc.moveTo(startX, y).lineTo(startX + colWidths.reduce((a, b) => a + b, 0), y).stroke();
    y += 5;

    doc.fontSize(8).fillColor('#000000');
    for (const row of result.rows) {
      if (y > 550) {
        doc.addPage();
        y = 40;
      }

      x = startX;
      const values = [
        row.hostname || '-',
        row.os_type || '-',
        row.status || '-',
        row.user_email || '-',
        row.last_heartbeat ? new Date(row.last_heartbeat).toLocaleDateString() : '-',
        row.cpu_usage != null ? `${Number(row.cpu_usage).toFixed(1)}%` : '-',
        row.ram_usage != null ? `${Number(row.ram_usage).toFixed(1)}%` : '-',
        row.disk_usage != null ? `${Number(row.disk_usage).toFixed(1)}%` : '-',
      ];
      values.forEach((val, i) => {
        doc.text(val, x, y, { width: colWidths[i], align: 'left' });
        x += colWidths[i];
      });
      y += 18;
    }

    doc.end();
  } catch (error) {
    logger.error('Report devices PDF error', { error: (error as Error).message });
    next(error);
  }
});

// GET /compliance/csv - Export compliance results as CSV
router.get('/compliance/csv', authenticate, requirePermission('compliance.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const viewAll = canViewAllDevices(req.user);
    const result = await query(
      `SELECT d.hostname, p.name as policy_name, cr.is_compliant, cr.violations, cr.checked_at
       FROM compliance_results cr
       JOIN devices d ON cr.device_id = d.id
       JOIN compliance_policies p ON cr.policy_id = p.id
       ${viewAll ? '' : 'WHERE d.created_by = $1'}
       ORDER BY cr.checked_at DESC`,
      viewAll ? [] : [req.user!.id]
    );

    const headers = ['Hostname', 'Policy', 'Compliant', 'Violations', 'Checked At'];
    const rows = result.rows.map((row: any) => [
      row.hostname || '',
      row.policy_name || '',
      row.is_compliant ? 'Yes' : 'No',
      row.violations ? JSON.stringify(row.violations) : '[]',
      row.checked_at ? new Date(row.checked_at).toISOString() : '',
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="compliance-report.csv"');
    res.send(csvContent);
  } catch (error) {
    logger.error('Report compliance CSV error', { error: (error as Error).message });
    next(error);
  }
});

// GET /alerts/csv - Export alerts as CSV
router.get('/alerts/csv', authenticate, requirePermission('logs.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const viewAll = canViewAllDevices(req.user);
    const result = await query(
      `SELECT a.alert_type, a.severity, a.title, a.description, d.hostname,
              a.is_dismissed, a.created_at
       FROM alerts a
       LEFT JOIN devices d ON a.device_id = d.id
       ${viewAll ? '' : 'WHERE (a.device_id IS NULL OR d.created_by = $1)'}
       ORDER BY a.created_at DESC`,
      viewAll ? [] : [req.user!.id]
    );

    const headers = ['Type', 'Severity', 'Title', 'Description', 'Device', 'Dismissed', 'Created At'];
    const rows = result.rows.map((row: any) => [
      row.alert_type || '',
      row.severity || '',
      row.title || '',
      row.description || '',
      row.hostname || '',
      row.is_dismissed ? 'Yes' : 'No',
      row.created_at ? new Date(row.created_at).toISOString() : '',
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="alerts-report.csv"');
    res.send(csvContent);
  } catch (error) {
    logger.error('Report alerts CSV error', { error: (error as Error).message });
    next(error);
  }
});

// GET /summary - Get summary report data
router.get('/summary', authenticate, requirePermission('logs.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const viewAll = canViewAllDevices(req.user);
    const p = viewAll ? [] : [req.user!.id];
    const devCond = (extra?: string) => {
      const parts: string[] = [];
      if (!viewAll) parts.push('created_by = $1');
      if (extra) parts.push(extra);
      return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
    };
    const alertsFrom = `FROM alerts a${viewAll ? '' : ' LEFT JOIN devices d ON a.device_id = d.id'}`;
    const alertsWhere = viewAll ? '' : ' WHERE (a.device_id IS NULL OR d.created_by = $1)';

    const [totalDevices, onlineDevices, offlineDevices, totalAlerts, unresolvedAlerts, deviceByOs, deviceByStatus, alertsBySeverity] = await Promise.all([
      query(`SELECT COUNT(*) as count FROM devices${devCond()}`, p),
      query(`SELECT COUNT(*) as count FROM devices${devCond("status = 'online'")}`, p),
      query(`SELECT COUNT(*) as count FROM devices${devCond("status = 'offline'")}`, p),
      query(`SELECT COUNT(*) as count ${alertsFrom}${alertsWhere}`, p),
      query(`SELECT COUNT(*) as count ${alertsFrom}${alertsWhere ? `${alertsWhere} AND a.is_dismissed = false` : ' WHERE a.is_dismissed = false'}`, p),
      query(`SELECT os_type as os, COUNT(*) as count FROM devices${devCond()} GROUP BY os_type ORDER BY count DESC`, p),
      query(`SELECT status, COUNT(*) as count FROM devices${devCond()} GROUP BY status ORDER BY count DESC`, p),
      query(`SELECT a.severity, COUNT(*) as count ${alertsFrom}${alertsWhere ? `${alertsWhere} GROUP BY a.severity` : ' GROUP BY severity'} ORDER BY count DESC`, p),
    ]);

    const total = parseInt(totalDevices.rows[0]?.count || '0', 10);
    const compliant = total > 0 ? Math.round((onlineDevices.rows[0]?.count || 0) / total * 100) : 0;

    res.json({
      success: true,
      data: {
        total_devices: total,
        online_devices: parseInt(onlineDevices.rows[0]?.count || '0', 10),
        offline_devices: parseInt(offlineDevices.rows[0]?.count || '0', 10),
        total_alerts: parseInt(totalAlerts.rows[0]?.count || '0', 10),
        unresolved_alerts: parseInt(unresolvedAlerts.rows[0]?.count || '0', 10),
        compliance_rate: compliant,
        devices_by_os: deviceByOs.rows,
        devices_by_status: deviceByStatus.rows,
        alerts_by_severity: alertsBySeverity.rows,
      },
    });
  } catch (error) {
    logger.error('Report summary error', { error: (error as Error).message });
    next(error);
  }
});

export default router;

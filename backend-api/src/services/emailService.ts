import nodemailer from 'nodemailer';
import { query } from '../config/database';

// Environment variables:
// SMTP_HOST - SMTP server hostname
// SMTP_PORT - SMTP server port (default 587)
// SMTP_USER - SMTP username
// SMTP_PASS - SMTP password
// SMTP_FROM - From address (default: 'EndpointX <noreply@endpointx.local>')

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || 'EndpointX <noreply@endpointx.local>';

let transporter: any = null;

function getTransporter(): any {
  if (!transporter) {
    if (!SMTP_HOST) {
      throw new Error('SMTP not configured');
    }
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const transport = getTransporter();
    await transport.sendMail({ from: SMTP_FROM, to, subject, html });

    // Log to notification_log table
    await query(
      'INSERT INTO notification_log (recipient_email, subject, body, status, sent_at) VALUES ($1, $2, $3, $4, NOW())',
      [to, subject, html, 'sent']
    );
    return true;
  } catch (error) {
    // Log failure
    await query(
      'INSERT INTO notification_log (recipient_email, subject, body, status, error_message) VALUES ($1, $2, $3, $4, $5)',
      [to, subject, html, 'failed', (error as Error).message]
    ).catch(() => {});
    return false;
  }
}

export async function sendAlertNotification(alert: { severity: string; title: string; message: string; device_id: string }): Promise<void> {
  try {
    // Get all admin users
    const admins = await query(
      `SELECT email FROM users WHERE is_active = true AND role_id IN (
        SELECT id FROM roles WHERE name = 'admin'
      )`
    );

    for (const admin of admins.rows) {
      const severityColor = { critical: '#dc2626', high: '#f97316', medium: '#eab308', low: '#22c55e' }[alert.severity] || '#6b7280';

      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: ${severityColor};">${alert.severity.toUpperCase()} Alert</h2>
          <h3>${alert.title}</h3>
          <p>${alert.message}</p>
          <p><strong>Device ID:</strong> ${alert.device_id}</p>
          <hr/>
          <p style="color: #6b7280; font-size: 12px;">EndpointX Security Alert</p>
        </div>
      `;

      await sendEmail(admin.email, `[EndpointX] ${alert.severity.toUpperCase()}: ${alert.title}`, html);
    }
  } catch (error) {
    console.error('Failed to send alert notification:', error);
  }
}

export async function sendComplianceAlert(deviceId: string, deviceHostname: string, violations: string[]): Promise<void> {
  try {
    const admins = await query(
      `SELECT email FROM users WHERE is_active = true AND role_id IN (
        SELECT id FROM roles WHERE name = 'admin'
      )`
    );

    for (const admin of admins.rows) {
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #f97316;">Compliance Violation</h2>
          <h3>Device: ${deviceHostname}</h3>
          <p>The following compliance violations were detected:</p>
          <ul>${violations.map(v => `<li>${v}</li>`).join('')}</ul>
          <p><strong>Device ID:</strong> ${deviceId}</p>
          <hr/>
          <p style="color: #6b7280; font-size: 12px;">EndpointX Compliance Monitor</p>
        </div>
      `;

      await sendEmail(admin.email, `[EndpointX] Compliance Violation: ${deviceHostname}`, html);
    }
  } catch (error) {
    console.error('Failed to send compliance alert:', error);
  }
}

export async function sendWelcomeEmail(email: string, name: string, tempPassword: string): Promise<void> {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px;">
      <h2>Welcome to EndpointX</h2>
      <p>Hi ${name},</p>
      <p>Your account has been created. Here are your credentials:</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Temporary Password:</strong> ${tempPassword}</p>
      <p>Please change your password after first login.</p>
      <hr/>
      <p style="color: #6b7280; font-size: 12px;">EndpointX Admin</p>
    </div>
  `;
  await sendEmail(email, 'Welcome to EndpointX - Your Account', html);
}

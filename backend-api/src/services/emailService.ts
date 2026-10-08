import nodemailer from 'nodemailer';
import { query } from '../config/database';
import logger from '../utils/logger';
import { getSetting, getSettingsMap } from './settings';

/**
 * Email delivery.
 *
 * SMTP settings are resolved at send time in this order:
 *   1. app_settings `notification_*` keys (what the Notifications UI edits)
 *   2. `process.env.SMTP_*` (docker / render style deployments)
 *   3. built-in defaults
 *
 * The previous version read the environment once at module load, so saving
 * SMTP settings in the UI had no effect until a restart — and no effect at all
 * when the env vars were absent.
 */

const ENV_FALLBACK = {
  host: process.env.SMTP_HOST || '',
  port: process.env.SMTP_PORT || '587',
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || 'EndpointX <noreply@endpointx.local>',
};

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/** Read the effective SMTP config (UI settings first, env as fallback). */
export async function getSmtpConfig(): Promise<SmtpConfig> {
  const stored = await getSettingsMap([
    'notification_SMTP_HOST',
    'notification_SMTP_PORT',
    'notification_SMTP_USER',
    'notification_SMTP_PASS',
    'notification_SMTP_FROM',
  ]);

  const host = stored.notification_SMTP_HOST || ENV_FALLBACK.host;
  const port = parseInt(stored.notification_SMTP_PORT || ENV_FALLBACK.port, 10) || 587;
  const user = stored.notification_SMTP_USER || ENV_FALLBACK.user;
  const pass = stored.notification_SMTP_PASS || ENV_FALLBACK.pass;
  const from = stored.notification_SMTP_FROM || ENV_FALLBACK.from;

  return { host, port, secure: port === 465, user, pass, from };
}

/** A fresh transporter per call: settings can change between sends. */
async function createTransporter(config: SmtpConfig): Promise<any> {
  if (!config.host) {
    throw new Error('SMTP not configured — set it in Settings → Notifications or via SMTP_HOST');
  }
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user ? { auth: { user: config.user, pass: config.pass } } : {}),
    // Self-signed / internal SMTP relays are common on LAN installs.
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10_000,
  });
}

/**
 * Strip credentials from email HTML before it lands in notification_log.
 * The log is readable by anyone with logs.view — reset links and temporary
 * passwords must not survive there. Plain alert bodies pass through unchanged.
 */
export function redactEmailBody(body: string): string {
  return body
    .replace(/([?&]token=)[^"&\s]+/gi, '$1[REDACTED]')
    .replace(
      /(<strong>\s*Temporary Password:\s*<\/strong>)[\s\S]*?(<\/p>)/gi,
      '$1 [REDACTED]$2'
    );
}

async function logMail(
  to: string,
  subject: string,
  body: string,
  status: 'sent' | 'failed',
  errorMessage?: string
): Promise<void> {
  // sent_at is its own parameter: reusing $4 here (CASE WHEN $4 = 'sent')
  // made postgres deduce text for the comparison and varchar for the column,
  // and one parameter cannot have two types - the insert was rejected.
  await query(
    `INSERT INTO notification_log (recipient_email, subject, body, status, error_message, sent_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [to, subject, redactEmailBody(body), status, errorMessage ?? null, status === 'sent' ? new Date() : null]
  ).catch((error) => logger.warn('Failed to write notification_log', { error: error.message }));
}

/** Send one email. Returns true on success; failures are logged, never thrown. */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const config = await getSmtpConfig();
    const transporter = await createTransporter(config);
    await transporter.sendMail({ from: config.from, to, subject, html });
    await logMail(to, subject, html, 'sent');
    return true;
  } catch (error) {
    const message = (error as Error).message;
    logger.warn('Email send failed', { to, subject, error: message });
    await logMail(to, subject, html, 'failed', message);
    return false;
  }
}

/** Is SMTP configured enough to actually deliver mail? */
export async function isSmtpConfigured(): Promise<boolean> {
  const config = await getSmtpConfig();
  return Boolean(config.host);
}

/** Recipients for automatic (non-manual) alert notifications. */
async function alertRecipients(): Promise<string[]> {
  const configured = await getSetting('notification_alert_recipients', '');
  if (configured.trim()) {
    return configured
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
  }

  const admins = await query(
    `SELECT u.email FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.is_active = true AND r.name = 'admin' AND u.email IS NOT NULL`
  );
  return admins.rows.map((row: { email: string }) => row.email).filter(Boolean);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface AlertEmailInput {
  severity: string;
  title: string;
  message: string;
  device_id: string;
  device_name?: string;
  alert_type?: string;
  url?: string;
}

/**
 * Email an alert to the configured recipients.
 *
 * Called for automatic alerts too (threshold breaches, tamper, security scans,
 * brute force) — previously only the manual POST /api/alerts path sent mail.
 */
export async function sendAlertNotification(alert: AlertEmailInput): Promise<void> {
  try {
    const recipients = await alertRecipients();
    if (recipients.length === 0) {
      logger.debug('No alert recipients configured; skipping email');
      return;
    }

    const severityColor =
      { critical: '#dc2626', high: '#f97316', medium: '#eab308', low: '#22c55e', info: '#3b82f6' }[
        alert.severity
      ] || '#6b7280';

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px;">
        <h2 style="color: ${severityColor};">${escapeHtml(alert.severity.toUpperCase())} Alert</h2>
        <h3>${escapeHtml(alert.title)}</h3>
        <p>${escapeHtml(alert.message)}</p>
        ${alert.device_name ? `<p><strong>Device:</strong> ${escapeHtml(alert.device_name)}</p>` : ''}
        <p><strong>Device ID:</strong> ${escapeHtml(alert.device_id || 'n/a')}</p>
        ${alert.url ? `<p><a href="${escapeHtml(alert.url)}">Open in EndpointX</a></p>` : ''}
        <hr/>
        <p style="color: #6b7280; font-size: 12px;">EndpointX Security Alert</p>
      </div>`;

    const subject = `[EndpointX] ${alert.severity.toUpperCase()}: ${alert.title}`;
    for (const recipient of recipients) {
      await sendEmail(recipient, subject, html);
    }
  } catch (error) {
    logger.error('Failed to send alert notification', { error: (error as Error).message });
  }
}

export async function sendComplianceAlert(
  deviceId: string,
  deviceHostname: string,
  violations: string[]
): Promise<void> {
  try {
    const recipients = await alertRecipients();
    for (const recipient of recipients) {
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px;">
          <h2 style="color: #f97316;">Compliance Violation</h2>
          <h3>Device: ${escapeHtml(deviceHostname)}</h3>
          <p>The following compliance violations were detected:</p>
          <ul>${violations.map((v) => `<li>${escapeHtml(v)}</li>`).join('')}</ul>
          <p><strong>Device ID:</strong> ${escapeHtml(deviceId)}</p>
          <hr/>
          <p style="color: #6b7280; font-size: 12px;">EndpointX Compliance Monitor</p>
        </div>`;

      await sendEmail(recipient, `[EndpointX] Compliance Violation: ${deviceHostname}`, html);
    }
  } catch (error) {
    logger.error('Failed to send compliance alert', { error: (error as Error).message });
  }
}

export async function sendWelcomeEmail(email: string, name: string, tempPassword: string): Promise<void> {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px;">
      <h2>Welcome to EndpointX</h2>
      <p>Hi ${escapeHtml(name)},</p>
      <p>Your account has been created. Here are your credentials:</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Temporary Password:</strong> ${escapeHtml(tempPassword)}</p>
      <p>Please change your password after first login.</p>
      <hr/>
      <p style="color: #6b7280; font-size: 12px;">EndpointX Admin</p>
    </div>`;
  await sendEmail(email, 'Welcome to EndpointX - Your Account', html);
}

export async function sendPasswordResetEmail(
  email: string,
  name: string,
  resetUrl: string
): Promise<boolean> {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px;">
      <h2>Reset your EndpointX password</h2>
      <p>Hi ${escapeHtml(name)},</p>
      <p>Click the link below to choose a new password. This link expires in 1 hour.</p>
      <p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:10px 16px;background:#0080ff;color:#fff;text-decoration:none;border-radius:6px;">Reset password</a></p>
      <p style="color:#6b7280;font-size:12px;">If you did not request this, you can ignore this email.</p>
      <hr/>
      <p style="color: #6b7280; font-size: 12px;">EndpointX Security</p>
    </div>`;
  return sendEmail(email, 'EndpointX - Reset your password', html);
}

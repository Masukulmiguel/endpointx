import { Request, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';
import { hashPassword, comparePassword, generateToken, generateRefreshToken, hashToken } from '../utils/helpers';
import { JWT, AUTH } from '../config/constants';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { sendWelcomeEmail, sendPasswordResetEmail } from '../services/emailService';

function hexId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

async function recordFailedLogin(
  req: Request,
  email: string,
  userId: string | null,
  reason: 'invalid_credentials' | 'account_locked' | 'unknown_user'
): Promise<void> {
  const ip = req.ip || null;
  const ua = (req.headers['user-agent'] as string) || null;

  await query(
    `INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, 'login_failed', 'user', $4, $5, $6, $7, $8)`,
    [hexId(), userId, email, userId, `Login failed: ${reason}`, ip, ua, JSON.stringify({ reason })]
  );

  const windowMin = 15;
  const recent = await query(
    `SELECT COUNT(*) as c FROM audit_logs
     WHERE action = 'login_failed' AND created_at > NOW() - INTERVAL '${windowMin} minutes'
       AND (ip_address::text = $1 OR user_email = $2)`,
    [ip || '', email]
  );
  const failCount = parseInt(recent.rows[0]?.c || '0', 10);

  const lockout = reason === 'account_locked' || failCount >= 5;
  const severity = lockout ? 'critical' : failCount >= 3 ? 'high' : 'medium';
  const eventType = lockout ? 'brute_force' : 'failed_login';

  await query(
    `INSERT INTO security_events (id, device_id, event_type, severity, title, description, source, raw_data)
     VALUES ($1, NULL, $2, $3, $4, $5, 'auth', $6)`,
    [
      hexId(),
      eventType,
      severity,
      lockout ? 'Possible brute-force login attempts' : 'Failed login attempt',
      `${failCount} failed login(s) in last ${windowMin} min for ${email} from ${ip || 'unknown'}`,
      JSON.stringify({ email, ip, fail_count: failCount, reason }),
    ]
  );

  if (lockout) {
    const existing = await query(
      `SELECT id FROM alerts WHERE alert_type = $1 AND is_dismissed = false
         AND created_at > NOW() - INTERVAL '15 minutes' AND title = $2 LIMIT 1`,
      [eventType, `Brute force suspected: ${email}`]
    );
    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO alerts (id, device_id, alert_type, severity, title, description, metadata)
         VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
        [
          hexId(),
          eventType,
          severity,
          `Brute force suspected: ${email}`,
          `${failCount} failed login(s) from ${ip || 'unknown'} in ${windowMin} minutes`,
          JSON.stringify({ email, ip, fail_count: failCount, reason }),
        ]
      );
    }
  }
}

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ success: false, error: { message: 'Email and password are required.' } });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const userResult = await query(
      `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.email = $1 AND u.is_active = true`,
      [normalizedEmail]
    );

    if (userResult.rows.length === 0) {
      await recordFailedLogin(req, normalizedEmail, null, 'unknown_user').catch(() => undefined);
      res.status(401).json({ success: false, error: { message: 'Invalid email or password.' } });
      return;
    }

    const user = userResult.rows[0];

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await recordFailedLogin(req, normalizedEmail, user.id, 'account_locked').catch(() => undefined);
      res.status(423).json({ success: false, error: { message: 'Account is locked. Try again later.' } });
      return;
    }

    const passwordValid = await comparePassword(password, user.password_hash);
    if (!passwordValid) {
      const attempts = (user.failed_login_attempts || 0) + 1;
      const lockout = attempts >= AUTH.MAX_LOGIN_ATTEMPTS;
      await query('UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3',
        [attempts, lockout ? new Date(Date.now() + AUTH.LOCKOUT_DURATION_MS).toISOString() : null, user.id]);
      await recordFailedLogin(req, normalizedEmail, user.id, lockout ? 'account_locked' : 'invalid_credentials').catch(() => undefined);
      res.status(401).json({ success: false, error: { message: 'Invalid email or password.' } });
      return;
    }

    // Check if MFA is enabled for this user
    const mfaResult = await query('SELECT enabled FROM user_mfa WHERE user_id = $1 AND enabled = true', [user.id]);
    if (mfaResult.rows.length > 0) {
      const tempToken = generateToken(
        { id: user.id, type: 'mfa_temp' },
        JWT.ACCESS_SECRET,
        '5m'
      );

      await query("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1", [user.id]);

      res.json({
        success: true,
        data: {
          requiresMfa: true,
          tempToken,
          message: 'MFA verification required.',
        },
      });
      return;
    }

    const permissionsResult = await query(
      'SELECT p.code FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = $1',
      [user.role_id]
    );
    const permissions = permissionsResult.rows.map((r: any) => r.code);

    const accessToken = generateToken(
      { id: user.id, email: user.email, role_id: user.role_id, role_name: user.role_name, permissions },
      JWT.ACCESS_SECRET,
      JWT.ACCESS_EXPIRES_IN
    );

    const refreshTokenStr = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshTokenStr);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await query('INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [user.id, refreshTokenHash, req.ip, req.headers['user-agent'], expiresAt.toISOString()]);

    await query("UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1", [user.id]);

    await query('INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [user.id, user.email, 'login', 'user', user.id, 'User logged in', req.ip]);

    logger.info('User logged in', { userId: user.id, email: user.email });

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken: refreshTokenStr,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          full_name: user.full_name,
          role_id: user.role_id,
          role_name: user.role_name,
          permissions,
        },
      },
    });
  } catch (error) {
    logger.error('Login error', { error: (error as Error).message });
    next(error);
  }
};

export const register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email, password, full_name, username } = req.body;
    if (!email || !password || !full_name) {
      res.status(400).json({ success: false, error: { message: 'Email, password and full name are required.' } });
      return;
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      res.status(409).json({ success: false, error: { message: 'An account with this email already exists.' } });
      return;
    }

    const passwordHash = await hashPassword(password);
    const freeRole = await query("SELECT id FROM roles WHERE name = 'user'");
    const roleId = freeRole.rows[0]?.id || null;

    const baseUsername = (username || normalizedEmail.split('@')[0]).replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase().slice(0, 50) || 'user';
    let uniqueUsername = baseUsername;
    for (let i = 0; i < 20; i++) {
      const clash = await query('SELECT id FROM users WHERE username = $1', [uniqueUsername]);
      if (clash.rows.length === 0) break;
      uniqueUsername = `${baseUsername}${Math.floor(Math.random() * 9000 + 1000)}`;
    }

    const result = await query(
      `INSERT INTO users (email, username, full_name, password_hash, role_id, is_active, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true, false) RETURNING id`,
      [normalizedEmail, uniqueUsername, full_name.trim(), passwordHash, roleId]
    );
    const userId = result.rows[0].id;

    await query(
      'INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [userId, normalizedEmail, 'user_register', 'user', userId, 'Self-registration (free early access)', req.ip]
    );

    logger.info('User self-registered', { userId, email: normalizedEmail });

    const permissionsResult = await query(
      'SELECT p.code FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = $1',
      [roleId]
    );
    const permissions = permissionsResult.rows.map((r: any) => r.code);

    const accessToken = generateToken(
      { id: userId, email: normalizedEmail, role_id: roleId, role_name: 'user', permissions },
      JWT.ACCESS_SECRET,
      JWT.ACCESS_EXPIRES_IN
    );
    const refreshTokenStr = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshTokenStr);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await query(
      'INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [userId, refreshTokenHash, req.ip, req.headers['user-agent'], expiresAt.toISOString()]
    );
    await query('UPDATE users SET last_login = NOW() WHERE id = $1', [userId]);

    res.status(201).json({
      success: true,
      data: {
        accessToken,
        refreshToken: refreshTokenStr,
        user: {
          id: userId,
          email: normalizedEmail,
          username: uniqueUsername,
          full_name: full_name.trim(),
          role_id: roleId,
          role_name: 'user',
          permissions,
        },
        message: 'Account created. Free early access activated.',
      },
    });
  } catch (error) {
    logger.error('Register error', { error: (error as Error).message });
    next(error);
  }
};

export const forgotPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email } = req.body;
    const normalizedEmail = (email || '').toLowerCase().trim();

    // Always return the same message to avoid account enumeration
    const generic = {
      success: true,
      data: { message: 'If an account exists for this email, a reset link has been sent.' },
    };

    if (!normalizedEmail) {
      res.json(generic);
      return;
    }

    const userResult = await query('SELECT id, email, full_name FROM users WHERE email = $1 AND is_active = true', [normalizedEmail]);
    if (userResult.rows.length === 0) {
      res.json(generic);
      return;
    }

    const user = userResult.rows[0];
    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(resetToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await query(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt.toISOString()]
    );

    const dashboardUrl = process.env.FRONTEND_URL || 'https://endpointx-dashboard.onrender.com';
    const resetUrl = `${dashboardUrl}/reset-password?token=${resetToken}`;

    const emailed = await sendPasswordResetEmail(user.email, user.full_name || user.email, resetUrl);
    if (!emailed) {
      logger.warn('Password reset email could not be sent (SMTP not configured or failed)', { email: user.email });
    }

    res.json(generic);
  } catch (error) {
    logger.error('Forgot password error', { error: (error as Error).message });
    next(error);
  }
};

export const resetPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      res.status(400).json({ success: false, error: { message: 'Token and password are required.' } });
      return;
    }

    const tokenHash = hashToken(token);
    const tokenResult = await query(
      `SELECT id, user_id, expires_at, used FROM password_reset_tokens
       WHERE token_hash = $1 AND used = false AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [tokenHash]
    );

    if (tokenResult.rows.length === 0) {
      res.status(400).json({ success: false, error: { message: 'Invalid or expired reset token.' } });
      return;
    }

    const resetRow = tokenResult.rows[0];
    const passwordHash = await hashPassword(password);

    await query('UPDATE users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL, must_change_password = false, password_changed_at = NOW() WHERE id = $2',
      [passwordHash, resetRow.user_id]);
    await query('UPDATE password_reset_tokens SET used = true WHERE id = $1', [resetRow.id]);
    await query('DELETE FROM user_sessions WHERE user_id = $1', [resetRow.user_id]);

    await query(
      'INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ((SELECT id FROM users WHERE id = $1), (SELECT email FROM users WHERE id = $1), $2, $3, $1, $4, $5)',
      [resetRow.user_id, 'password_reset', 'user', 'Password reset via token', req.ip]
    );

    logger.info('Password reset completed', { userId: resetRow.user_id });
    res.json({ success: true, data: { message: 'Password has been reset. You can now sign in.' } });
  } catch (error) {
    logger.error('Reset password error', { error: (error as Error).message });
    next(error);
  }
};

export const inviteUser = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email, username, full_name, role_id } = req.body;
    if (!email) {
      res.status(400).json({ success: false, error: { message: 'Email is required.' } });
      return;
    }

    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) {
      res.status(409).json({ success: false, error: { message: 'User already exists.' } });
      return;
    }

    // Generate a temporary password that user must change on first login
    const tempPassword = crypto.randomBytes(12).toString('base64url');
    const passwordHash = await hashPassword(tempPassword);

    const result = await query(
      `INSERT INTO users (email, username, full_name, password_hash, role_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
      [email.toLowerCase().trim(), username || email.split('@')[0], full_name || '', passwordHash, role_id || null]
    );

    const userId = result.rows[0].id;

    // Assign default role if none specified
    if (!role_id) {
      const userRole = await query("SELECT id FROM roles WHERE name = 'user'");
      if (userRole.rows.length > 0) {
        await query('UPDATE users SET role_id = $1 WHERE id = $2', [userRole.rows[0].id, userId]);
      }
    }

    await query('INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [req.user?.id, req.user?.email, 'user_create', 'user', userId, `User invited: ${email}`, req.ip]);

    logger.info('User invited', { invitedBy: req.user?.id, email });

    // Send welcome email (non-blocking)
    sendWelcomeEmail(email, full_name || email.split('@')[0], tempPassword).catch((err) =>
      logger.error('Failed to send welcome email', { email, error: err.message })
    );

    res.status(201).json({
      success: true,
      data: {
        id: userId,
        email,
        temp_password: tempPassword,
        message: 'User created. They must change their password on first login.',
      },
    });
  } catch (error) {
    logger.error('Invite user error', { error: (error as Error).message });
    next(error);
  }
};

export const logout = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, error: { message: 'Not authenticated' } }); return; }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
      const tokenHash = hashToken(token);
      await query('DELETE FROM user_sessions WHERE user_id = $1 AND refresh_token_hash = $2', [userId, tokenHash]);
    }

    await query('INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [userId, req.user?.email, 'logout', 'user', userId, 'User logged out', req.ip]);

    res.json({ success: true, data: { message: 'Logged out' } });
  } catch (error) { next(error); }
};

export const refreshToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) { res.status(400).json({ success: false, error: { message: 'Refresh token required' } }); return; }

    const tokenHash = hashToken(token);
    const sessionResult = await query(
      `SELECT s.*, u.email, u.role_id, u.is_active, r.name as role_name
       FROM user_sessions s
       JOIN users u ON s.user_id = u.id
       JOIN roles r ON u.role_id = r.id
       WHERE s.refresh_token_hash = $1 AND s.expires_at > NOW() AND u.is_active = true`,
      [tokenHash]
    );

    if (sessionResult.rows.length === 0) {
      res.status(401).json({ success: false, error: { message: 'Invalid refresh token' } });
      return;
    }

    const session = sessionResult.rows[0];
    await query('DELETE FROM user_sessions WHERE id = $1', [session.id]);

    const permissionsResult = await query('SELECT p.code FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = $1', [session.role_id]);
    const permissions = permissionsResult.rows.map((r: any) => r.code);

    const newAccessToken = generateToken({ id: session.user_id, email: session.email, role_id: session.role_id, role_name: session.role_name, permissions }, JWT.ACCESS_SECRET, JWT.ACCESS_EXPIRES_IN);
    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = hashToken(newRefreshToken);
    const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 7);

    await query('INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [session.user_id, newRefreshTokenHash, req.ip, req.headers['user-agent'], expiresAt.toISOString()]);

    res.json({ success: true, data: { accessToken: newAccessToken, refreshToken: newRefreshToken } });
  } catch (error) { next(error); }
};

export const changePassword = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, error: { message: 'Not authenticated' } }); return; }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) { res.status(400).json({ success: false, error: { message: 'Current and new passwords required' } }); return; }

    // Password complexity check
    if (newPassword.length < 12 ||
        !/[A-Z]/.test(newPassword) ||
        !/[a-z]/.test(newPassword) ||
        !/[0-9]/.test(newPassword) ||
        !/[^A-Za-z0-9]/.test(newPassword)) {
      res.status(400).json({ success: false, error: { message: 'Password must be at least 12 characters with uppercase, lowercase, number, and special character' } });
      return;
    }

    const userResult = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'User not found' } }); return; }

    const valid = await comparePassword(currentPassword, userResult.rows[0].password_hash);
    if (!valid) { res.status(401).json({ success: false, error: { message: 'Current password incorrect' } }); return; }

    const newHash = await hashPassword(newPassword);
    await query('UPDATE users SET password_hash = $1, must_change_password = false WHERE id = $2', [newHash, userId]);
    await query('DELETE FROM user_sessions WHERE user_id = $1', [userId]);

    res.json({ success: true, data: { message: 'Password changed' } });
  } catch (error) { next(error); }
};

export const getProfile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, error: { message: 'Not authenticated' } }); return; }

    const result = await query('SELECT u.id, u.email, u.username, u.full_name, u.role_id, u.is_active, u.mfa_enabled, u.last_login, u.created_at, r.name as role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = $1', [userId]);
    if (result.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'User not found' } }); return; }

    const user = result.rows[0];
    const permissionsResult = await query('SELECT p.code, p.name FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = $1', [user.role_id]);

    res.json({ success: true, data: { user: { ...user, permissions: permissionsResult.rows.map((p: any) => p.code) } } });
  } catch (error) { next(error); }
};

export const updateProfile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, error: { message: 'Not authenticated' } }); return; }

    const { full_name } = req.body;
    await query('UPDATE users SET full_name = COALESCE($1, full_name) WHERE id = $2', [full_name ?? null, userId]);

    res.json({ success: true, data: { message: 'Profile updated' } });
  } catch (error) { next(error); }
};

export const mfaVerify = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { tempToken, token } = req.body;
    if (!tempToken || !token) {
      res.status(400).json({ success: false, error: { message: 'tempToken and token are required' } });
      return;
    }

    let decoded: { id: string; type: string };
    try {
      decoded = jwt.verify(tempToken, JWT.ACCESS_SECRET, {
        issuer: JWT.ISSUER,
        audience: JWT.AUDIENCE,
      }) as { id: string; type: string };
    } catch {
      res.status(401).json({ success: false, error: { message: 'Invalid or expired temp token.' } });
      return;
    }

    if (decoded.type !== 'mfa_temp') {
      res.status(401).json({ success: false, error: { message: 'Invalid temp token type.' } });
      return;
    }

    const userId = decoded.id;

    const mfaResult = await query('SELECT mfa_secret, enabled, backup_codes FROM user_mfa WHERE user_id = $1', [userId]);
    if (mfaResult.rows.length === 0 || !mfaResult.rows[0].enabled) {
      res.status(400).json({ success: false, error: { message: 'MFA is not enabled for this user.' } });
      return;
    }

    const speakeasy = require('speakeasy');
    const bcrypt = require('bcryptjs');

    const mfa = mfaResult.rows[0];
    const decryptedSecret = Buffer.from(mfa.mfa_secret, 'hex').toString('utf8');

    const verified = speakeasy.totp.verify({
      secret: decryptedSecret,
      encoding: 'base32',
      token,
      window: 1,
    });

    if (!verified && mfa.backup_codes) {
      const backupCodes: string[] = JSON.parse(mfa.backup_codes);
      let backupUsed = false;
      for (let i = 0; i < backupCodes.length; i++) {
        if (bcrypt.compareSync(token, backupCodes[i])) {
          backupCodes.splice(i, 1);
          await query(
            'UPDATE user_mfa SET backup_codes = $1, updated_at = NOW() WHERE user_id = $2',
            [JSON.stringify(backupCodes), userId]
          );
          backupUsed = true;
          break;
        }
      }
      if (!backupUsed) {
        res.status(401).json({ success: false, error: { message: 'Invalid token.' } });
        return;
      }
    } else if (!verified) {
      res.status(401).json({ success: false, error: { message: 'Invalid token.' } });
      return;
    }

    const userResult = await query(
      `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1 AND u.is_active = true`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      res.status(401).json({ success: false, error: { message: 'User not found or inactive.' } });
      return;
    }

    const user = userResult.rows[0];

    const permissionsResult = await query(
      'SELECT p.code FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = $1',
      [user.role_id]
    );
    const permissions = permissionsResult.rows.map((r: any) => r.code);

    const accessToken = generateToken(
      { id: user.id, email: user.email, role_id: user.role_id, role_name: user.role_name, permissions },
      JWT.ACCESS_SECRET,
      JWT.ACCESS_EXPIRES_IN
    );

    const refreshTokenStr = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshTokenStr);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await query('INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [user.id, refreshTokenHash, req.ip, req.headers['user-agent'], expiresAt.toISOString()]);

    await query("UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1", [user.id]);

    await query('INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [user.id, user.email, 'login_mfa', 'user', user.id, 'MFA login verified', req.ip]);

    logger.info('User logged in via MFA', { userId: user.id, email: user.email });

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken: refreshTokenStr,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          full_name: user.full_name,
          role_id: user.role_id,
          role_name: user.role_name,
          permissions,
        },
      },
    });
  } catch (error) {
    logger.error('MFA verify login error', { error: (error as Error).message });
    next(error);
  }
};

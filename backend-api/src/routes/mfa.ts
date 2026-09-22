import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import * as speakeasy from 'speakeasy';
import * as QRCode from 'qrcode';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { JWT } from '../config/constants';
import logger from '../utils/logger';
import { generateToken } from '../utils/helpers';

const router = Router();

const MFA_KEY = process.env.MFA_ENCRYPTION_KEY || 'endpointx-mfa-key-change-in-production-32!';

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(MFA_KEY, 'utf-8'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text: string): string {
  const parts = text.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(MFA_KEY, 'utf-8'), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function generateBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < 10; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
}

// POST /setup - Generate TOTP secret + QR code for user
router.post('/setup', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: { message: 'Not authenticated' } });
      return;
    }

    const userResult = await query('SELECT email FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'User not found' } });
      return;
    }

    const existingMfa = await query('SELECT enabled FROM user_mfa WHERE user_id = $1', [userId]);
    if (existingMfa.rows.length > 0 && existingMfa.rows[0].enabled) {
      res.status(400).json({ success: false, error: { message: 'MFA is already enabled. Disable it first.' } });
      return;
    }

    const email = userResult.rows[0].email;
    const secret = speakeasy.generateSecret({
      name: 'EndpointX (' + email + ')',
      issuer: 'EndpointX',
    });

    const qrCode = await QRCode.toDataURL(secret.otpauth_url || '');

    const encryptedSecret = encrypt(secret.base32);

    await query(
      `INSERT INTO user_mfa (user_id, mfa_secret, enabled, method, created_at, updated_at)
       VALUES ($1, $2, false, 'totp', NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET mfa_secret = $2, updated_at = NOW()`,
      [userId, encryptedSecret]
    );

    res.json({
      success: true,
      data: {
        secret: secret.base32,
        qrCode,
      },
    });
  } catch (error) {
    logger.error('MFA setup error', { error: (error as Error).message });
    next(error);
  }
});

// POST /verify - Verify first TOTP code to enable MFA
router.post('/verify', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: { message: 'Not authenticated' } });
      return;
    }

    const { token } = req.body;
    if (!token) {
      res.status(400).json({ success: false, error: { message: 'Token is required' } });
      return;
    }

    const mfaResult = await query('SELECT mfa_secret, enabled FROM user_mfa WHERE user_id = $1', [userId]);
    if (mfaResult.rows.length === 0) {
      res.status(400).json({ success: false, error: { message: 'MFA not set up. Run /mfa/setup first.' } });
      return;
    }

    const mfa = mfaResult.rows[0];
    if (mfa.enabled) {
      res.status(400).json({ success: false, error: { message: 'MFA is already enabled.' } });
      return;
    }

    const decryptedSecret = decrypt(mfa.mfa_secret);

    const verified = speakeasy.totp.verify({
      secret: decryptedSecret,
      encoding: 'base32',
      token,
      window: 1,
    });

    if (!verified) {
      res.status(400).json({ success: false, error: { message: 'Invalid token. Please try again.' } });
      return;
    }

    const backupCodes = generateBackupCodes();
    const encryptedBackupCodes = JSON.stringify(backupCodes.map(c => bcrypt.hashSync(c, 10)));

    await query(
      'UPDATE user_mfa SET enabled = true, backup_codes = $1, updated_at = NOW() WHERE user_id = $2',
      [encryptedBackupCodes, userId]
    );

    await query(
      'UPDATE users SET mfa_enabled = true WHERE id = $1',
      [userId]
    );

    await query(
      `INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address)
       VALUES ($1, $2, 'mfa_enable', 'user', $1, 'MFA enabled via TOTP verification', $3)`,
      [userId, req.user?.email, req.ip]
    );

    res.json({
      success: true,
      data: {
        success: true,
        backupCodes,
      },
    });
  } catch (error) {
    logger.error('MFA verify error', { error: (error as Error).message });
    next(error);
  }
});

// POST /disable - Disable MFA (requires current TOTP + password)
router.post('/disable', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: { message: 'Not authenticated' } });
      return;
    }

    const { token, password } = req.body;
    if (!token || !password) {
      res.status(400).json({ success: false, error: { message: 'Token and password are required' } });
      return;
    }

    const mfaResult = await query('SELECT mfa_secret, enabled FROM user_mfa WHERE user_id = $1', [userId]);
    if (mfaResult.rows.length === 0 || !mfaResult.rows[0].enabled) {
      res.status(400).json({ success: false, error: { message: 'MFA is not enabled.' } });
      return;
    }

    const userResult = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (userResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'User not found' } });
      return;
    }

    const passwordValid = await bcrypt.compare(password, userResult.rows[0].password_hash);
    if (!passwordValid) {
      res.status(401).json({ success: false, error: { message: 'Invalid password.' } });
      return;
    }

    const decryptedSecret = decrypt(mfaResult.rows[0].mfa_secret);
    const verified = speakeasy.totp.verify({
      secret: decryptedSecret,
      encoding: 'base32',
      token,
      window: 1,
    });

    if (!verified) {
      res.status(400).json({ success: false, error: { message: 'Invalid TOTP token.' } });
      return;
    }

    await query('DELETE FROM user_mfa WHERE user_id = $1', [userId]);
    await query('UPDATE users SET mfa_enabled = false WHERE id = $1', [userId]);

    await query(
      `INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address)
       VALUES ($1, $2, 'mfa_disable', 'user', $1, 'MFA disabled', $3)`,
      [userId, req.user?.email, req.ip]
    );

    res.json({ success: true, data: { success: true } });
  } catch (error) {
    logger.error('MFA disable error', { error: (error as Error).message });
    next(error);
  }
});

// POST /login-verify - Verify TOTP during login (called from authController login flow)
router.post('/login-verify', async (req: AuthRequest, res: Response, next: NextFunction) => {
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

    const mfa = mfaResult.rows[0];
    const decryptedSecret = decrypt(mfa.mfa_secret);

    const verified = speakeasy.totp.verify({
      secret: decryptedSecret,
      encoding: 'base32',
      token,
      window: 1,
    });

    if (verified) {
      await issueFullTokens(userId, res, req);
      return;
    }

    // Try backup code verification
    if (mfa.backup_codes) {
      const backupCodes: string[] = JSON.parse(mfa.backup_codes);
      for (let i = 0; i < backupCodes.length; i++) {
        if (bcrypt.compareSync(token, backupCodes[i])) {
          backupCodes.splice(i, 1);
          await query(
            'UPDATE user_mfa SET backup_codes = $1, updated_at = NOW() WHERE user_id = $2',
            [JSON.stringify(backupCodes), userId]
          );

          await issueFullTokens(userId, res, req, true);
          return;
        }
      }
    }

    res.status(401).json({ success: false, error: { message: 'Invalid token.' } });
  } catch (error) {
    logger.error('MFA login-verify error', { error: (error as Error).message });
    next(error);
  }
});

async function issueFullTokens(userId: string, res: Response, req: AuthRequest, backupCode = false): Promise<void> {
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

  const refreshTokenStr = crypto.randomBytes(64).toString('hex');
  const refreshTokenHash = crypto.createHash('sha256').update(refreshTokenStr).digest('hex');
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  await query(
    'INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [user.id, refreshTokenHash, req.ip, req.headers['user-agent'], expiresAt.toISOString()]
  );

  await query("UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW() WHERE id = $1", [user.id]);

  await query(
    'INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [user.id, user.email, 'login_mfa', 'user', user.id, backupCode ? 'MFA login with backup code' : 'MFA login verified', req.ip]
  );

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
}

// GET /status - Check if user has MFA enabled
router.get('/status', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: { message: 'Not authenticated' } });
      return;
    }

    const mfaResult = await query('SELECT enabled, method FROM user_mfa WHERE user_id = $1', [userId]);
    const enabled = mfaResult.rows.length > 0 && mfaResult.rows[0].enabled;

    res.json({
      success: true,
      data: {
        enabled,
        method: enabled ? (mfaResult.rows[0].method || 'totp') : null,
      },
    });
  } catch (error) {
    logger.error('MFA status error', { error: (error as Error).message });
    next(error);
  }
});

export default router;

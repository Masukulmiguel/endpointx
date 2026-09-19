import { Request, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest } from '../middleware/auth';
import logger from '../utils/logger';
import { hashPassword, comparePassword, generateToken, generateRefreshToken, hashToken } from '../utils/helpers';
import { JWT, AUTH } from '../config/constants';

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ success: false, error: { message: 'Email and password are required.' } });
      return;
    }

    const userResult = query(
      `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.email = ? AND u.is_active = 1`,
      [email.toLowerCase().trim()]
    );

    if (userResult.rows.length === 0) {
      res.status(401).json({ success: false, error: { message: 'Invalid email or password.' } });
      return;
    }

    const user = userResult.rows[0];

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      res.status(423).json({ success: false, error: { message: 'Account is locked. Try again later.' } });
      return;
    }

    const passwordValid = await comparePassword(password, user.password_hash);
    if (!passwordValid) {
      const attempts = (user.login_attempts || 0) + 1;
      const lockout = attempts >= AUTH.MAX_LOGIN_ATTEMPTS;
      query('UPDATE users SET login_attempts = ?, locked_until = ? WHERE id = ?',
        [attempts, lockout ? new Date(Date.now() + AUTH.LOCKOUT_DURATION_MS).toISOString() : null, user.id]);
      res.status(401).json({ success: false, error: { message: 'Invalid email or password.' } });
      return;
    }

    const permissionsResult = query(
      'SELECT p.code FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = ?',
      [user.role_id]
    );
    const permissions = permissionsResult.rows.map((r: any) => r.code);

    const accessToken = generateToken(
      { id: user.id, email: user.email, role_id: user.role_id, role_name: user.role_name, permissions },
      JWT.ACCESS_SECRET,
      JWT.ACCESS_EXPIRES_IN
    );

    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashToken(refreshToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    query('INSERT INTO user_sessions (id, user_id, token_hash, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), user.id, refreshTokenHash, req.ip, req.headers['user-agent'], expiresAt.toISOString()]);

    query("UPDATE users SET login_attempts = 0, locked_until = NULL, last_login = datetime('now') WHERE id = ?", [user.id]);

    query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), user.id, user.email, 'login', 'user', user.id, 'User logged in', req.ip]);

    logger.info('User logged in', { userId: user.id, email: user.email });

    res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
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
    const { email, password, username, full_name, role_id } = req.body;
    if (!email || !password) {
      res.status(400).json({ success: false, error: { message: 'Email and password are required.' } });
      return;
    }

    const existing = query('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (existing.rows.length > 0) {
      res.status(409).json({ success: false, error: { message: 'User already exists.' } });
      return;
    }

    const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const passwordHash = await hashPassword(password);

    query('INSERT INTO users (id, email, username, full_name, password_hash, role_id) VALUES (?, ?, ?, ?, ?, ?)',
      [id, email.toLowerCase().trim(), username || email.split('@')[0], full_name || '', passwordHash, role_id || 'role_user']);

    res.status(201).json({ success: true, data: { id, email } });
  } catch (error) {
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
      query('DELETE FROM user_sessions WHERE user_id = ? AND token_hash = ?', [userId, tokenHash]);
    }

    query('INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), userId, req.user?.email, 'logout', 'user', userId, 'User logged out', req.ip]);

    res.json({ success: true, data: { message: 'Logged out' } });
  } catch (error) { next(error); }
};

export const refreshToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { refreshToken: token } = req.body;
    if (!token) { res.status(400).json({ success: false, error: { message: 'Refresh token required' } }); return; }

    const tokenHash = hashToken(token);
    const sessionResult = query(
      `SELECT s.*, u.email, u.role_id, u.is_active, r.name as role_name FROM user_sessions s JOIN users u ON s.user_id = u.id JOIN roles r ON u.role_id = r.id WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.is_active = 1`,
      [tokenHash]
    );

    if (sessionResult.rows.length === 0) {
      res.status(401).json({ success: false, error: { message: 'Invalid refresh token' } });
      return;
    }

    const session = sessionResult.rows[0];
    query('DELETE FROM user_sessions WHERE id = ?', [session.id]);

    const permissionsResult = query('SELECT p.code FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = ?', [session.role_id]);
    const permissions = permissionsResult.rows.map((r: any) => r.code);

    const newAccessToken = generateToken({ id: session.user_id, email: session.email, role_id: session.role_id, role_name: session.role_name, permissions }, JWT.ACCESS_SECRET, JWT.ACCESS_EXPIRES_IN);
    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = hashToken(newRefreshToken);
    const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 7);

    query('INSERT INTO user_sessions (id, user_id, token_hash, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(''), session.user_id, newRefreshTokenHash, req.ip, req.headers['user-agent'], expiresAt.toISOString()]);

    res.json({ success: true, data: { accessToken: newAccessToken, refreshToken: newRefreshToken } });
  } catch (error) { next(error); }
};

export const changePassword = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, error: { message: 'Not authenticated' } }); return; }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) { res.status(400).json({ success: false, error: { message: 'Current and new passwords required' } }); return; }

    const userResult = query('SELECT password_hash FROM users WHERE id = ?', [userId]);
    if (userResult.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'User not found' } }); return; }

    const valid = await comparePassword(currentPassword, userResult.rows[0].password_hash);
    if (!valid) { res.status(401).json({ success: false, error: { message: 'Current password incorrect' } }); return; }

    const newHash = await hashPassword(newPassword);
    query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);
    query('DELETE FROM user_sessions WHERE user_id = ?', [userId]);

    res.json({ success: true, data: { message: 'Password changed' } });
  } catch (error) { next(error); }
};

export const getProfile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, error: { message: 'Not authenticated' } }); return; }

    const result = query('SELECT u.id, u.email, u.username, u.full_name, u.role_id, u.is_active, u.mfa_enabled, u.last_login, u.created_at, r.name as role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ?', [userId]);
    if (result.rows.length === 0) { res.status(404).json({ success: false, error: { message: 'User not found' } }); return; }

    const user = result.rows[0];
    const permissionsResult = query('SELECT p.code, p.name FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = ?', [user.role_id]);

    res.json({ success: true, data: { user: { ...user, permissions: permissionsResult.rows.map((p: any) => p.code) } } });
  } catch (error) { next(error); }
};

export const updateProfile = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) { res.status(401).json({ success: false, error: { message: 'Not authenticated' } }); return; }

    const { full_name } = req.body;
    query('UPDATE users SET full_name = COALESCE(?, full_name) WHERE id = ?', [full_name ?? null, userId]);

    res.json({ success: true, data: { message: 'Profile updated' } });
  } catch (error) { next(error); }
};

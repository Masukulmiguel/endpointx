import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { JWT } from '../config/constants';
import { generateToken } from '../utils/helpers';
import logger from '../utils/logger';

const router = Router();

const SSO_ENCRYPTION_KEY = process.env.SSO_ENCRYPTION_KEY || process.env.MFA_ENCRYPTION_KEY || 'endpointx-sso-key-change-in-production-32!';

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(SSO_ENCRYPTION_KEY, 'utf-8'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text: string): string {
  const parts = text.split(':');
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(SSO_ENCRYPTION_KEY, 'utf-8'), iv);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

interface SSOProviderConfig {
  name: string;
  provider_type: string;
  client_id: string;
  client_secret_encrypted: string;
  redirect_uri: string;
  tenant_id?: string;
  domain?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  discovery_endpoint?: string;
  is_active: boolean;
  created_at: string;
}

const PROVIDER_ENDPOINTS: Record<string, { authorize: string; token: string; userinfo: string }> = {
  azure_ad: {
    authorize: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    userinfo: 'https://graph.microsoft.com/v1.0/me',
  },
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://www.googleapis.com/oauth2/v2/userinfo',
  },
  okta: {
    authorize: 'https://{domain}/oauth2/default/v1/authorize',
    token: 'https://{domain}/oauth2/default/v1/token',
    userinfo: 'https://{domain}/oauth2/default/v1/userinfo',
  },
};

function buildAuthorizeUrl(config: SSOProviderConfig, state: string): string {
  const type = config.provider_type as string;

  let authorizeEndpoint: string;
  let scopes = 'openid email profile';

  if (type === 'azure_ad') {
    if (!config.tenant_id) throw new Error('tenant_id is required for Azure AD');
    authorizeEndpoint = PROVIDER_ENDPOINTS.azure_ad.authorize.replace('{tenant}', config.tenant_id);
  } else if (type === 'google') {
    authorizeEndpoint = PROVIDER_ENDPOINTS.google.authorize;
    scopes = 'openid email profile';
  } else if (type === 'okta') {
    if (!config.domain) throw new Error('domain is required for Okta');
    authorizeEndpoint = PROVIDER_ENDPOINTS.okta.authorize.replace('{domain}', config.domain);
  } else if (config.authorization_endpoint) {
    authorizeEndpoint = config.authorization_endpoint;
  } else {
    throw new Error('Unknown provider type and no custom authorization endpoint configured');
  }

  const params = new URLSearchParams({
    client_id: config.client_id,
    redirect_uri: config.redirect_uri,
    response_type: 'code',
    scope: scopes,
    state,
  });

  return `${authorizeEndpoint}?${params.toString()}`;
}

async function exchangeCode(config: SSOProviderConfig, code: string): Promise<any> {
  const type = config.provider_type as string;

  let tokenEndpoint: string;
  if (type === 'azure_ad') {
    if (!config.tenant_id) throw new Error('tenant_id is required for Azure AD');
    tokenEndpoint = PROVIDER_ENDPOINTS.azure_ad.token.replace('{tenant}', config.tenant_id);
  } else if (type === 'google') {
    tokenEndpoint = PROVIDER_ENDPOINTS.google.token;
  } else if (type === 'okta') {
    if (!config.domain) throw new Error('domain is required for Okta');
    tokenEndpoint = PROVIDER_ENDPOINTS.okta.token.replace('{domain}', config.domain);
  } else if (config.token_endpoint) {
    tokenEndpoint = config.token_endpoint;
  } else {
    throw new Error('No token endpoint available');
  }

  const clientSecret = decrypt(config.client_secret_encrypted);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.client_id,
    client_secret: clientSecret,
    code,
    redirect_uri: config.redirect_uri,
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const errBody = await response.text();
    logger.error('SSO token exchange failed', { status: response.status, body: errBody });
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  return response.json();
}

async function fetchUserInfo(config: SSOProviderConfig, accessToken: string): Promise<any> {
  const type = config.provider_type as string;

  let userinfoEndpoint: string;
  if (type === 'azure_ad') {
    userinfoEndpoint = PROVIDER_ENDPOINTS.azure_ad.userinfo;
  } else if (type === 'google') {
    userinfoEndpoint = PROVIDER_ENDPOINTS.google.userinfo;
  } else if (type === 'okta') {
    if (!config.domain) throw new Error('domain is required for Okta');
    userinfoEndpoint = PROVIDER_ENDPOINTS.okta.userinfo.replace('{domain}', config.domain);
  } else if (config.userinfo_endpoint) {
    userinfoEndpoint = config.userinfo_endpoint;
  } else {
    throw new Error('No userinfo endpoint available');
  }

  const response = await fetch(userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const errBody = await response.text();
    logger.error('SSO userinfo fetch failed', { status: response.status, body: errBody });
    throw new Error(`UserInfo fetch failed: ${response.status}`);
  }

  return response.json();
}

function extractSAMLClaims(userInfo: any): { email: string; name: string; subject: string } {
  const email = userInfo.email || userInfo.preferred_username || userInfo.upn || '';
  const name = userInfo.name || userInfo.display_name || `${userInfo.given_name || ''} ${userInfo.family_name || ''}`.trim() || email;
  const subject = userInfo.sub || userInfo.oid || userInfo.id || '';

  return { email, name, subject };
}

// GET /providers - List configured SSO providers
router.get('/providers', authenticate, requirePermission('settings.view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `SELECT key, value FROM app_settings WHERE key LIKE 'sso_provider_%'`
    );

    const providers = result.rows.map((row: any) => {
      const config = JSON.parse(row.value);
      const id = row.key.replace('sso_provider_', '');
      return {
        id,
        name: config.name,
        provider_type: config.provider_type,
        is_active: config.is_active,
        created_at: config.created_at,
        tenant_id: config.tenant_id || null,
        domain: config.domain || null,
      };
    });

    res.json({ success: true, data: providers });
  } catch (error) {
    logger.error('SSO list providers error', { error: (error as Error).message });
    next(error);
  }
});

// POST /providers - Add/configure an SSO provider (admin only)
router.post('/providers', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { name, provider_type, client_id, client_secret, redirect_uri, tenant_id, domain, authorization_endpoint, token_endpoint, userinfo_endpoint } = req.body;

    if (!name || !provider_type || !client_id || !client_secret || !redirect_uri) {
      res.status(400).json({ success: false, error: { message: 'name, provider_type, client_id, client_secret, and redirect_uri are required' } });
      return;
    }

    const validTypes = ['azure_ad', 'google', 'okta', 'oidc'];
    if (!validTypes.includes(provider_type)) {
      res.status(400).json({ success: false, error: { message: `provider_type must be one of: ${validTypes.join(', ')}` } });
      return;
    }

    if ((provider_type === 'azure_ad') && !tenant_id) {
      res.status(400).json({ success: false, error: { message: 'tenant_id is required for Azure AD providers' } });
      return;
    }

    if ((provider_type === 'okta') && !domain) {
      res.status(400).json({ success: false, error: { message: 'domain is required for Okta providers' } });
      return;
    }

    const id = crypto.randomUUID().substring(0, 8);
    const config: SSOProviderConfig = {
      name,
      provider_type,
      client_id,
      client_secret_encrypted: encrypt(client_secret),
      redirect_uri,
      tenant_id,
      domain,
      authorization_endpoint,
      token_endpoint,
      userinfo_endpoint,
      is_active: true,
      created_at: new Date().toISOString(),
    };

    await query(
      `INSERT INTO app_settings (key, value, description, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $4, updated_at = NOW()`,
      [`sso_provider_${id}`, JSON.stringify(config), `SSO Provider: ${name} (${provider_type})`, req.user?.id]
    );

    await query(
      `INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address)
       VALUES ($1, $2, 'sso_provider_create', 'sso_provider', $3, $4, $5)`,
      [req.user?.id, req.user?.email, id, `SSO provider "${name}" created`, req.ip]
    );

    res.status(201).json({
      success: true,
      data: {
        id,
        name,
        provider_type,
        is_active: true,
      },
    });
  } catch (error) {
    logger.error('SSO add provider error', { error: (error as Error).message });
    next(error);
  }
});

// DELETE /providers/:id - Remove SSO provider (admin only)
router.delete('/providers/:id', authenticate, requirePermission('settings.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const result = await query(
      `DELETE FROM app_settings WHERE key = $1 RETURNING value`,
      [`sso_provider_${id}`]
    );

    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: { message: 'SSO provider not found' } });
      return;
    }

    const config = JSON.parse(result.rows[0].value);

    await query(
      `INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address)
       VALUES ($1, $2, 'sso_provider_delete', 'sso_provider', $3, $4, $5)`,
      [req.user?.id, req.user?.email, id, `SSO provider "${config.name}" deleted`, req.ip]
    );

    res.json({ success: true, data: { message: 'SSO provider deleted' } });
  } catch (error) {
    logger.error('SSO delete provider error', { error: (error as Error).message });
    next(error);
  }
});

// GET /authorize/:providerId - Redirect to provider's authorization endpoint
router.get('/authorize/:providerId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { providerId } = req.params;

    const result = await query(
      `SELECT value FROM app_settings WHERE key = $1`,
      [`sso_provider_${providerId}`]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'SSO provider not found' } });
      return;
    }

    const config: SSOProviderConfig = JSON.parse(result.rows[0].value);

    if (!config.is_active) {
      res.status(400).json({ success: false, error: { message: 'SSO provider is not active' } });
      return;
    }

    const state = crypto.randomBytes(32).toString('hex');

    await query(
      `INSERT INTO app_settings (key, value, description)
       VALUES ($1, $2, 'SSO CSRF state token')
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [`sso_state_${state}`, JSON.stringify({ provider_id: providerId, created_at: new Date().toISOString() })]
    );

    const authorizeUrl = buildAuthorizeUrl(config, state);

    res.json({ success: true, data: { url: authorizeUrl } });
  } catch (error) {
    logger.error('SSO authorize error', { error: (error as Error).message });
    next(error);
  }
});

// POST /callback/:providerId - Handle OAuth2 callback
router.post('/callback/:providerId', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { providerId } = req.params;
    const { code, state } = req.body;

    if (!code || !state) {
      res.status(400).json({ success: false, error: { message: 'code and state are required' } });
      return;
    }

    // Verify CSRF state
    const stateResult = await query(
      `SELECT value FROM app_settings WHERE key = $1`,
      [`sso_state_${state}`]
    );

    if (stateResult.rows.length === 0) {
      res.status(400).json({ success: false, error: { message: 'Invalid or expired state parameter' } });
      return;
    }

    const stateData = JSON.parse(stateResult.rows[0].value);
    if (stateData.provider_id !== providerId) {
      res.status(400).json({ success: false, error: { message: 'State parameter mismatch' } });
      return;
    }

    // Delete used state token
    await query(`DELETE FROM app_settings WHERE key = $1`, [`sso_state_${state}`]);

    // Load provider config
    const providerResult = await query(
      `SELECT value FROM app_settings WHERE key = $1`,
      [`sso_provider_${providerId}`]
    );

    if (providerResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'SSO provider not found' } });
      return;
    }

    const config: SSOProviderConfig = JSON.parse(providerResult.rows[0].value);

    if (!config.is_active) {
      res.status(400).json({ success: false, error: { message: 'SSO provider is not active' } });
      return;
    }

    // Exchange code for tokens
    const tokenResponse = await exchangeCode(config, code);

    // Fetch user info
    const userInfo = await fetchUserInfo(config, tokenResponse.access_token);

    const { email, name, subject } = extractSAMLClaims(userInfo);

    if (!email) {
      res.status(400).json({ success: false, error: { message: 'Could not extract email from SSO provider' } });
      return;
    }

    // Find existing user by SSO subject or email
    let userResult = await query(
      `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id
       WHERE u.sso_provider_id = $1 AND u.sso_subject = $2`,
      [providerId, subject]
    );

    let isNewUser = false;

    if (userResult.rows.length === 0) {
      // Try to find by email
      userResult = await query(
        `SELECT u.*, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id
         WHERE u.email = $1`,
        [email]
      );

      if (userResult.rows.length > 0) {
        // Link existing user to SSO
        await query(
          `UPDATE users SET sso_provider_id = $1, sso_subject = $2, updated_at = NOW()
           WHERE id = $3`,
          [providerId, subject, userResult.rows[0].id]
        );
        userResult.rows[0].sso_provider_id = providerId;
        userResult.rows[0].sso_subject = subject;
      } else {
        // Create new user
        const defaultRole = await query(`SELECT id FROM roles WHERE name = 'user'`);
        const roleId = defaultRole.rows[0]?.id;

        const username = email.split('@')[0];
        const tempPassword = crypto.randomBytes(32).toString('hex');

        const newUserResult = await query(
          `INSERT INTO users (email, username, full_name, password_hash, role_id, sso_provider_id, sso_subject, must_change_password)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false)
           RETURNING *, (SELECT name FROM roles WHERE id = $5) as role_name`,
          [email, username, name, tempPassword, roleId, providerId, subject]
        );

        userResult.rows = newUserResult.rows;
        isNewUser = true;
      }
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      res.status(403).json({ success: false, error: { message: 'Account is deactivated. Contact an administrator.' } });
      return;
    }

    // Get permissions
    const permissionsResult = await query(
      `SELECT p.code FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = $1`,
      [user.role_id]
    );
    const permissions = permissionsResult.rows.map((r: any) => r.code);

    // Generate JWT tokens
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

    await query(
      `UPDATE users SET last_login = NOW(), failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
      [user.id]
    );

    await query(
      `INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address)
       VALUES ($1, $2, 'login_sso', 'user', $3, $4, $5)`,
      [user.id, user.email, user.id, isNewUser ? 'SSO login - new user created' : `SSO login via ${config.name}`, req.ip]
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
          sso_provider_id: user.sso_provider_id,
          is_new_user: isNewUser,
        },
      },
    });
  } catch (error) {
    logger.error('SSO callback error', { error: (error as Error).message });
    next(error);
  }
});

// DELETE /disconnect - Disconnect SSO for current user
router.delete('/disconnect', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, error: { message: 'Not authenticated' } });
      return;
    }

    const userResult = await query(
      `SELECT sso_provider_id, password_hash FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'User not found' } });
      return;
    }

    const user = userResult.rows[0];

    if (!user.sso_provider_id) {
      res.status(400).json({ success: false, error: { message: 'No SSO provider is linked to this account' } });
      return;
    }

    // Check if user has a password set (cannot disconnect SSO without a password)
    if (!user.password_hash) {
      res.status(400).json({ success: false, error: { message: 'Cannot disconnect SSO without a password. Set a password first.' } });
      return;
    }

    await query(
      `UPDATE users SET sso_provider_id = NULL, sso_subject = NULL, updated_at = NOW() WHERE id = $1`,
      [userId]
    );

    await query(
      `INSERT INTO audit_logs (user_id, user_email, action, target_type, target_id, description, ip_address)
       VALUES ($1, $2, 'sso_disconnect', 'user', $1, 'SSO provider disconnected', $3)`,
      [userId, req.user?.email, req.ip]
    );

    res.json({ success: true, data: { message: 'SSO provider disconnected' } });
  } catch (error) {
    logger.error('SSO disconnect error', { error: (error as Error).message });
    next(error);
  }
});

export default router;

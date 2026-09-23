import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT } from '../config/constants';
import { query } from '../config/database';
import logger from '../utils/logger';

interface AuthUser {
  id: string;
  email: string;
  role_id: string;
  role_name: string;
  permissions: string[];
}

type AuthRequest = Request & {
  user?: AuthUser;
  [key: string]: any;
};

interface JwtPayload {
  id: string;
  email: string;
  role_id: string;
  role_name: string;
  permissions: string[];
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

// Short-lived cache so RBAC uses current DB permissions even if the JWT is stale
const permCache = new Map<string, { perms: string[]; exp: number }>();
const PERM_CACHE_TTL_MS = 60_000;

async function loadRolePermissions(roleId: string): Promise<string[] | null> {
  const hit = permCache.get(roleId);
  if (hit && hit.exp > Date.now()) return hit.perms;
  try {
    const result = await query(
      'SELECT p.code FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = $1',
      [roleId]
    );
    const perms = result.rows.map((r: { code: string }) => r.code);
    permCache.set(roleId, { perms, exp: Date.now() + PERM_CACHE_TTL_MS });
    return perms;
  } catch (error) {
    logger.warn('Failed to load role permissions from DB', {
      roleId,
      error: (error as Error).message,
    });
    return null;
  }
}

export function invalidatePermissionCache(roleId?: string) {
  if (roleId) permCache.delete(roleId);
  else permCache.clear();
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  const tokenFromCookie = (req as any).cookies?.access_token;
  if (tokenFromCookie) {
    return tokenFromCookie;
  }

  return null;
}

async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({
      success: false,
      error: {
        message: 'Authentication required. No token provided.',
        code: 'AUTH_TOKEN_MISSING',
      },
    });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT.ACCESS_SECRET, {
      issuer: JWT.ISSUER,
      audience: JWT.AUDIENCE,
    }) as JwtPayload;

    const dbPerms = await loadRolePermissions(decoded.role_id);
    const authUser: AuthUser = {
      id: decoded.id,
      email: decoded.email,
      role_id: decoded.role_id,
      role_name: decoded.role_name,
      permissions: dbPerms ?? decoded.permissions ?? [],
    };

    (req as AuthRequest).user = authUser;

    logger.debug('User authenticated', {
      userId: authUser.id,
      email: authUser.email,
      role: authUser.role_name,
    });

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        success: false,
        error: {
          message: 'Token has expired. Please log in again.',
          code: 'AUTH_TOKEN_EXPIRED',
        },
      });
      return;
    }

    if (error instanceof jwt.NotBeforeError) {
      res.status(401).json({
        success: false,
        error: {
          message: 'Token is not yet active.',
          code: 'AUTH_TOKEN_NOT_ACTIVE',
        },
      });
      return;
    }

    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        success: false,
        error: {
          message: 'Invalid authentication token.',
          code: 'AUTH_TOKEN_INVALID',
        },
      });
      return;
    }

    logger.error('Unexpected error during authentication', {
      error: (error as Error).message,
    });

    res.status(500).json({
      success: false,
      error: {
        message: 'Internal server error during authentication.',
        code: 'AUTH_INTERNAL_ERROR',
      },
    });
  }
}

async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractToken(req);

  if (!token) {
    next();
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT.ACCESS_SECRET, {
      issuer: JWT.ISSUER,
      audience: JWT.AUDIENCE,
    }) as JwtPayload;

    const dbPerms = await loadRolePermissions(decoded.role_id);
    const authUser: AuthUser = {
      id: decoded.id,
      email: decoded.email,
      role_id: decoded.role_id,
      role_name: decoded.role_name,
      permissions: dbPerms ?? decoded.permissions ?? [],
    };

    (req as AuthRequest).user = authUser;
  } catch {
    // Silently ignore invalid tokens in optionalAuth
  }

  next();
}

export { AuthRequest, AuthUser, authenticate, optionalAuth };

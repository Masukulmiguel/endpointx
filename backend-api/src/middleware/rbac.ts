import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import logger from '../utils/logger';

function requirePermission(...requiredPermissions: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: {
          message: 'Authentication required.',
          code: 'AUTH_TOKEN_MISSING',
        },
      });
      return;
    }

    const userPermissions = req.user.permissions || [];

    const hasPermission = requiredPermissions.every((permission) =>
      userPermissions.includes(permission)
    );

    if (!hasPermission) {
      const missingPermissions = requiredPermissions.filter(
        (permission) => !userPermissions.includes(permission)
      );

      logger.warn('Permission denied', {
        userId: req.user.id,
        required: requiredPermissions,
        missing: missingPermissions,
        route: req.originalUrl,
      });

      res.status(403).json({
        success: false,
        error: {
          message: 'You do not have the required permissions to perform this action.',
          code: 'AUTH_PERMISSION_DENIED',
          required: requiredPermissions,
          missing: missingPermissions,
        },
      });
      return;
    }

    next();
  };
}

function requireRole(...allowedRoles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: {
          message: 'Authentication required.',
          code: 'AUTH_TOKEN_MISSING',
        },
      });
      return;
    }

    const userRoleName = req.user.role_name;

    if (!allowedRoles.includes(userRoleName)) {
      logger.warn('Role access denied', {
        userId: req.user.id,
        userRole: userRoleName,
        allowedRoles,
        route: req.originalUrl,
      });

      res.status(403).json({
        success: false,
        error: {
          message: 'You do not have the required role to perform this action.',
          code: 'AUTH_ROLE_DENIED',
          required: allowedRoles,
          current: userRoleName,
        },
      });
      return;
    }

    next();
  };
}

export { requirePermission, requireRole };

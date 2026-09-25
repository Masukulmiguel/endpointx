import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger';

class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    isOperational: boolean = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;

    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

interface ErrorResponse {
  success: false;
  error: {
    message: string;
    code: string;
    details?: any;
    stack?: string;
  };
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function logError(err: Error, req: Request): void {
  const meta: Record<string, any> = {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  };

  if ((err as AppError).statusCode) {
    meta.statusCode = (err as AppError).statusCode;
  }

  if ((err as any).userId) {
    meta.userId = (err as any).userId;
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(err.message, { ...meta, stack: err.stack });
    } else {
      logger.warn(err.message, meta);
    }
  } else {
    logger.error(err.message || 'Unknown error occurred', {
      ...meta,
      stack: err.stack,
    });
  }
}

function handleZodError(err: ZodError, res: Response): void {
  const details = err.errors.map((e) => ({
    field: e.path.join('.'),
    message: e.message,
    code: e.code,
  }));

  const response: ErrorResponse = {
    success: false,
    error: {
      message: 'Request validation failed',
      code: 'VALIDATION_ERROR',
      details: isProduction() ? details : details,
    },
  };

  res.status(400).json(response);
}

function handleJwtError(
  err: jwt.JsonWebTokenError | jwt.TokenExpiredError | jwt.NotBeforeError,
  res: Response
): void {
  let message: string;
  let code: string;

  if (err instanceof jwt.TokenExpiredError) {
    message = 'Token has expired. Please log in again.';
    code = 'AUTH_TOKEN_EXPIRED';
  } else if (err instanceof jwt.NotBeforeError) {
    message = 'Token is not yet active.';
    code = 'AUTH_TOKEN_NOT_ACTIVE';
  } else {
    message = 'Invalid authentication token.';
    code = 'AUTH_TOKEN_INVALID';
  }

  const response: ErrorResponse = {
    success: false,
    error: { message, code },
  };

  res.status(401).json(response);
}

function handleAppError(err: AppError, res: Response): void {
  const response: ErrorResponse = {
    success: false,
    error: {
      message: err.message,
      code: err.code,
    },
  };

  res.status(err.statusCode).json(response);
}

function handlePostgresError(err: Error, res: Response): void {
  const pgErr = err as any;

  switch (pgErr.code) {
    case '23505': {
      const detail = pgErr.detail || 'A record with this value already exists';
      const response: ErrorResponse = {
        success: false,
        error: {
          message: 'A record with this value already exists.',
          code: 'CONFLICT',
          details: isProduction() ? undefined : { detail },
        },
      };
      res.status(409).json(response);
      break;
    }
    case '23503': {
      const response: ErrorResponse = {
        success: false,
        error: {
          message: 'Referenced record does not exist.',
          code: 'FOREIGN_KEY_VIOLATION',
        },
      };
      res.status(400).json(response);
      break;
    }
    case '23502': {
      const response: ErrorResponse = {
        success: false,
        error: {
          message: 'A required field is missing.',
          code: 'NOT_NULL_VIOLATION',
        },
      };
      res.status(400).json(response);
      break;
    }
    case '42P01': {
      const response: ErrorResponse = {
        success: false,
        error: {
          message: 'A database resource was not found.',
          code: 'DATABASE_ERROR',
        },
      };
      res.status(404).json(response);
      break;
    }
    default: {
      const response: ErrorResponse = {
        success: false,
        error: {
          message: 'A database error occurred.',
          code: 'DATABASE_ERROR',
          details: isProduction() ? { sqlState: pgErr.code } : pgErr.message,
        },
      };
      res.status(500).json(response);
      break;
    }
  }
}

function handleSyntaxError(err: SyntaxError, res: Response): void {
  if ('body' in err) {
    const response: ErrorResponse = {
      success: false,
      error: {
        message: 'The request body contains invalid JSON.',
        code: 'INVALID_JSON',
      },
    };
    res.status(400).json(response);
    return;
  }

  const response: ErrorResponse = {
    success: false,
    error: {
      message: isProduction()
        ? 'A processing error occurred.'
        : err.message,
      code: 'SYNTAX_ERROR',
    },
  };
  res.status(400).json(response);
}

function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  logError(err, req);

  if (err instanceof ZodError) {
    handleZodError(err, res);
    return;
  }

  if (
    err instanceof jwt.JsonWebTokenError ||
    err instanceof jwt.TokenExpiredError ||
    err instanceof jwt.NotBeforeError
  ) {
    handleJwtError(err, res);
    return;
  }

  if (err instanceof AppError) {
    handleAppError(err, res);
    return;
  }

  if (err instanceof SyntaxError) {
    handleSyntaxError(err, res);
    return;
  }

  const pgError = err as any;
  if (pgError.code && typeof pgError.code === 'string' && pgError.code.length === 5) {
    handlePostgresError(err, res);
    return;
  }

  const statusCode = (err as any).statusCode || 500;
  const code = (err as any).code || 'INTERNAL_ERROR';

  const response: ErrorResponse = {
    success: false,
    error: {
      message: isProduction()
        ? 'An unexpected error occurred. Please try again later.'
        : err.message || 'Internal server error',
      code,
      stack: isProduction() ? undefined : err.stack,
    },
  };

  res.status(statusCode >= 100 && statusCode < 600 ? statusCode : 500).json(response);
}

export { AppError, errorHandler };

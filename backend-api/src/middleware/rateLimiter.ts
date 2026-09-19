import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { RATE_LIMIT } from '../config/constants';

const createKeyGenerator = (prefix: string) => {
  return (req: any): string => {
    const userId = req.user?.id || '';
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    return `${prefix}:${userId || ip}`;
  };
};

const createRateLimiter = (
  name: string,
  windowMs: number,
  max: number
): RateLimitRequestHandler => {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: createKeyGenerator(name),
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        error: {
          message: 'Too many requests. Please try again later.',
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfter: Math.ceil(windowMs / 1000),
        },
      });
    },
  });
};

const authLimiter: RateLimitRequestHandler = createRateLimiter(
  'auth',
  RATE_LIMIT.WINDOW_MS,
  RATE_LIMIT.AUTH_MAX_REQUESTS
);

const apiLimiter: RateLimitRequestHandler = createRateLimiter(
  'api',
  RATE_LIMIT.WINDOW_MS,
  RATE_LIMIT.MAX_REQUESTS
);

const commandLimiter: RateLimitRequestHandler = createRateLimiter(
  'command',
  RATE_LIMIT.WINDOW_MS,
  20
);

export { authLimiter, apiLimiter, commandLimiter };

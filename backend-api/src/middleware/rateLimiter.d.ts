import { RateLimitRequestHandler } from 'express-rate-limit';
declare const authLimiter: RateLimitRequestHandler;
declare const apiLimiter: RateLimitRequestHandler;
declare const commandLimiter: RateLimitRequestHandler;
export { authLimiter, apiLimiter, commandLimiter };

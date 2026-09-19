import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { AUTH, PAGINATION } from '../config/constants';

export const hashPassword = async (password: string): Promise<string> => {
  return bcrypt.hash(password, AUTH.BCRYPT_ROUNDS);
};

export const comparePassword = async (
  password: string,
  hash: string
): Promise<boolean> => {
  return bcrypt.compare(password, hash);
};

export const generateToken = (
  payload: Record<string, any>,
  secret: string,
  expiresIn: string | number = '15m'
): string => {
  return jwt.sign(payload, secret, {
    expiresIn,
    issuer: 'endpointx',
    audience: 'endpointx-api',
  });
};

export const generateRefreshToken = (): string => {
  return crypto.randomBytes(AUTH.REFRESH_TOKEN_LENGTH).toString('hex');
};

export const hashToken = (token: string): string => {
  return crypto.createHash(AUTH.TOKEN_HASH_ALGORITHM).update(token).digest('hex');
};

export const paginate = (
  page: number = PAGINATION.DEFAULT_PAGE,
  limit: number = PAGINATION.DEFAULT_LIMIT
): { offset: number; limit: number } => {
  const safePage = Math.max(1, Math.floor(page));
  const safeLimit = Math.min(
    PAGINATION.MAX_LIMIT,
    Math.max(1, Math.floor(limit))
  );
  return {
    offset: (safePage - 1) * safeLimit,
    limit: safeLimit,
  };
};

export const formatDate = (date: Date | string | number): string => {
  if (date instanceof Date) {
    return date.toISOString();
  }
  return new Date(date).toISOString();
};

export const getDeviceInfo = (
  userAgent: string
): { os: string; browser: string; device: string } => {
  let os = 'Unknown';
  let browser = 'Unknown';
  let device = 'desktop';

  if (/Windows/i.test(userAgent)) {
    const match = userAgent.match(/Windows NT ([\d.]+)/);
    os = `Windows ${match ? match[1] : ''}`.trim();
  } else if (/Mac OS X/i.test(userAgent)) {
    const match = userAgent.match(/Mac OS X ([\d_]+)/);
    os = match ? `macOS ${match[1].replace(/_/g, '.')}` : 'macOS';
  } else if (/Linux/i.test(userAgent)) {
    os = 'Linux';
  } else if (/Android/i.test(userAgent)) {
    const match = userAgent.match(/Android ([\d.]+)/);
    os = match ? `Android ${match[1]}` : 'Android';
    device = 'mobile';
  } else if (/iPhone|iPad/i.test(userAgent)) {
    const match = userAgent.match(/OS ([\d_]+)/);
    os = match ? `iOS ${match[1].replace(/_/g, '.')}` : 'iOS';
    device = /iPad/i.test(userAgent) ? 'tablet' : 'mobile';
  }

  if (/Chrome/i.test(userAgent) && !/Edg/i.test(userAgent)) {
    const match = userAgent.match(/Chrome\/([\d.]+)/);
    browser = match ? `Chrome ${match[1]}` : 'Chrome';
  } else if (/Firefox/i.test(userAgent)) {
    const match = userAgent.match(/Firefox\/([\d.]+)/);
    browser = match ? `Firefox ${match[1]}` : 'Firefox';
  } else if (/Safari/i.test(userAgent) && !/Chrome/i.test(userAgent)) {
    const match = userAgent.match(/Version\/([\d.]+)/);
    browser = match ? `Safari ${match[1]}` : 'Safari';
  } else if (/Edg/i.test(userAgent)) {
    const match = userAgent.match(/Edg\/([\d.]+)/);
    browser = match ? `Edge ${match[1]}` : 'Edge';
  }

  return { os, browser, device };
};

export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const generateId = (): string => {
  return crypto.randomUUID();
};

export const sanitizeString = (str: string): string => {
  return str.replace(/[<>"'`;]/g, '').trim();
};

export const calculateTimeDifference = (
  start: Date | string,
  end: Date | string
): { days: number; hours: number; minutes: number; seconds: number } => {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffMs = endDate.getTime() - startDate.getTime();

  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);

  return { days, hours, minutes, seconds };
};

export const formatBytes = (bytes: number, decimals: number = 2): string => {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

export const parseConnectionString = (
  url: string
): { host: string; port: number; database: string; user: string; password: string } | null => {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port, 10) || 5432,
      database: parsed.pathname.slice(1),
      user: parsed.username,
      password: parsed.password,
    };
  } catch {
    return null;
  }
};

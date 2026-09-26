import dotenv from 'dotenv';
dotenv.config();

import express, { Express, Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import logger from './utils/logger';
import { initDatabase, closeDatabase } from './config/database';
import { validateSecrets } from './config/constants';
import { RATE_LIMIT } from './config/constants';
import { updateOfflineDevices } from './routes/devices';
import { errorHandler } from './middleware/errorHandler';

// Validate secrets before starting
try {
  validateSecrets();
} catch (error) {
  logger.error('Configuration error:', { message: (error as Error).message });
  process.exit(1);
}

const app: Express = express();
// Behind Render's reverse proxy: trust exactly 1 hop so req.ip (and rate-limit keys)
// resolve to the real client instead of the proxy — without this every client shares one bucket
app.set('trust proxy', 1);
const server = http.createServer(app);

export const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: process.env.FRONTEND_URL || '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Agent-Secret', 'X-Requested-With'],
  })
);
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: RATE_LIMIT.WINDOW_MS,
  max: RATE_LIMIT.AUTH_MAX_REQUESTS,
  message: { error: 'Too many authentication attempts, please try again later.' },
  standardHeaders: RATE_LIMIT.STANDARD_HEADERS,
  legacyHeaders: RATE_LIMIT.LEGACY_HEADERS,
});

// Presence heartbeats run forever from many devices; they must not consume the shared /api bucket
const isHeartbeatPath = (reqPath: string) =>
  reqPath === '/devices/heartbeat' || reqPath === '/devices/mobile/heartbeat';

const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT.WINDOW_MS,
  max: RATE_LIMIT.MAX_REQUESTS,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: RATE_LIMIT.STANDARD_HEADERS,
  legacyHeaders: RATE_LIMIT.LEGACY_HEADERS,
  skip: (req) => isHeartbeatPath(req.path),
});

// Heartbeat limiter keyed by the agent (device), so devices behind the same NAT never share a bucket
const heartbeatLimiter = rateLimit({
  windowMs: RATE_LIMIT.WINDOW_MS,
  max: RATE_LIMIT.HEARTBEAT_MAX_REQUESTS,
  message: { error: 'Too many heartbeat requests, please try again later.' },
  standardHeaders: RATE_LIMIT.STANDARD_HEADERS,
  legacyHeaders: RATE_LIMIT.LEGACY_HEADERS,
  keyGenerator: (req) => {
    const agentId = typeof req.body?.agent_id === 'string' ? req.body.agent_id.trim() : '';
    return `heartbeat:${agentId.slice(0, 64) || req.ip || 'unknown'}`;
  },
});

// Safety net on the source IP so fake agent ids cannot be used to flood the endpoint
const heartbeatIpLimiter = rateLimit({
  windowMs: RATE_LIMIT.WINDOW_MS,
  max: RATE_LIMIT.HEARTBEAT_IP_MAX_REQUESTS,
  message: { error: 'Too many heartbeat requests, please try again later.' },
  standardHeaders: RATE_LIMIT.STANDARD_HEADERS,
  legacyHeaders: RATE_LIMIT.LEGACY_HEADERS,
});

app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);
app.use('/api/devices/heartbeat', heartbeatLimiter, heartbeatIpLimiter);
app.use('/api/devices/mobile/heartbeat', heartbeatLimiter, heartbeatIpLimiter);

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Import routes
import authRoutes from './routes/auth';
import deviceRoutes from './routes/devices';
import commandRoutes from './routes/commands';
import userRoutes from './routes/users';
import roleRoutes from './routes/roles';
import alertRoutes from './routes/alerts';
import securityRoutes from './routes/security';
import auditRoutes from './routes/audit';
import dashboardRoutes from './routes/dashboard';
import settingsRoutes from './routes/settings';
import networkRoutes from './routes/network';
import agentsRoutes from './routes/agents';
import groupsRoutes from './routes/groups';
import policiesRoutes from './routes/policies';
import softwareRoutes from './routes/software';
import notificationsRoutes from './routes/notifications';
import hermesRoutes from './routes/hermes';
import netsentinelRoutes from './routes/netsentinel';
import reportsRoutes from './routes/reports';

app.use('/api/auth', authRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/commands', commandRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/network', networkRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/policies', policiesRoutes);
app.use('/api/compliance', policiesRoutes);
app.use('/api/software', softwareRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/hermes', hermesRoutes);
app.use('/api/netsentinel', netsentinelRoutes);
app.use('/api/reports', reportsRoutes);

// Public site (landing, login, register) — served before 404 handler
const publicSitePath = path.join(__dirname, '..', 'public', 'site');
app.use(express.static(publicSitePath, { index: 'index.html', extensions: ['html'] }));
app.get('/sitemap.xml', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicSitePath, 'sitemap.xml'));
});
app.get('/robots.txt', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicSitePath, 'robots.txt'));
});

// 404 handler (API JSON for /api/*, HTML for unknown site paths)
app.use((req: Request, res: Response) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ success: false, error: { message: 'Route not found', code: 'NOT_FOUND' } });
    return;
  }
  const looksLikeAsset = /\.[a-z0-9]+$/i.test(req.path);
  if (looksLikeAsset) {
    res.status(404).type('text/plain').send('Not found');
    return;
  }
  res.status(404).sendFile(path.join(publicSitePath, 'index.html'));
});

// Error handler
app.use(errorHandler);

// Socket.IO
io.on('connection', (socket) => {
  logger.debug('Client connected', { socketId: socket.id });
  socket.on('join_room', (room: string) => socket.join(room));
  socket.on('leave_room', (room: string) => socket.leave(room));
  socket.on('disconnect', (reason) => logger.debug('Client disconnected', { socketId: socket.id, reason }));
});

const PORT = parseInt(process.env.PORT || '3001', 10);

// Initialize database then start server
initDatabase().then(() => {
  server.listen(PORT, () => {
    logger.info(`EndpointX API server started on port ${PORT}`);
    logger.info(`Health check: http://localhost:${PORT}/health`);
    logger.info(`API base URL: http://localhost:${PORT}/api`);

    // Periodically mark devices as offline (every 60 seconds)
    setInterval(() => {
      try {
        updateOfflineDevices();
      } catch (err) {
        logger.error('Error in offline device check', { error: (err as Error).message });
      }
    }, 60000);
    logger.info('Offline device check running every 60s');
  });
}).catch((err) => {
  logger.error('Failed to initialize database', { error: err.message });
  process.exit(1);
});

export { app, server };
export default server;

// Graceful shutdown
const gracefulShutdown = async (signal: string) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);
  server.close(async () => {
    await closeDatabase();
    logger.info('Server shut down gracefully');
    process.exit(0);
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

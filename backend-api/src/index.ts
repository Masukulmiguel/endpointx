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
import { errorHandler } from './middleware/errorHandler';
import { initRemoteAccess } from './remote';
import { setIO } from './websocket';
import { startBackgroundJobs } from './jobs';
import { renderPrometheusMetrics } from './services/prometheus';
import { isAllowedOrigin } from './utils/cors';

// Validate secrets before starting
try {
  validateSecrets();
} catch (error) {
  logger.error('Configuration error:', { message: (error as Error).message });
  process.exit(1);
}

const app: Express = express();
// Behind Render's reverse proxy: trust exactly 1 hop so req.ip (and rate-limit keys)
// resolve to the real client instead of the proxy - without this every client shares one bucket
app.set('trust proxy', 1);
const server = http.createServer(app);

export const io = new SocketIOServer(server, {
  cors: {
    origin: isAllowedOrigin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Hand the server to the websocket helper so emitToDevice/emitToUser/
// broadcastEvent actually reach clients instead of silently returning.
setIO(io);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: isAllowedOrigin,
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

// Agent (machine-to-machine) endpoints must not consume the shared /api bucket:
// one agent polls /devices/command-poll every 3s (~300 requests per 15-min
// window), so two devices behind the same NAT already exhaust the budget and
// every dashboard request behind that IP starts getting 429.
const AGENT_PATH_RE =
  /^\/devices\/(heartbeat|mobile\/heartbeat|command-poll|command-result|register|inventory|security-scan)$/;

// req.path is already stripped of the mount point, but normalise anyway so the
// matcher keeps working if the limiter is ever mounted on the full path
const isAgentPath = (reqPath: string) => AGENT_PATH_RE.test(reqPath.replace(/^\/api/, ''));

const agentIdOf = (req: Request): string => {
  const agentId = typeof req.body?.agent_id === 'string' ? req.body.agent_id.trim() : '';
  return agentId.slice(0, 64) || req.ip || 'unknown';
};

const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT.WINDOW_MS,
  max: RATE_LIMIT.MAX_REQUESTS,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: RATE_LIMIT.STANDARD_HEADERS,
  legacyHeaders: RATE_LIMIT.LEGACY_HEADERS,
  skip: (req) => isAgentPath(req.path),
});

// Heartbeat limiter keyed by the agent (device), so devices behind the same NAT never share a bucket
const heartbeatLimiter = rateLimit({
  windowMs: RATE_LIMIT.WINDOW_MS,
  max: RATE_LIMIT.HEARTBEAT_MAX_REQUESTS,
  message: { error: 'Too many heartbeat requests, please try again later.' },
  standardHeaders: RATE_LIMIT.STANDARD_HEADERS,
  legacyHeaders: RATE_LIMIT.LEGACY_HEADERS,
  keyGenerator: (req) => `heartbeat:${agentIdOf(req)}`,
});

// Safety net on the source IP so fake agent ids cannot be used to flood the endpoint
const heartbeatIpLimiter = rateLimit({
  windowMs: RATE_LIMIT.WINDOW_MS,
  max: RATE_LIMIT.HEARTBEAT_IP_MAX_REQUESTS,
  message: { error: 'Too many heartbeat requests, please try again later.' },
  standardHeaders: RATE_LIMIT.STANDARD_HEADERS,
  legacyHeaders: RATE_LIMIT.LEGACY_HEADERS,
});

// Fast command poll (every 3s per agent) gets its own budget, keyed by agent
const commandPollLimiter = rateLimit({
  windowMs: RATE_LIMIT.WINDOW_MS,
  max: RATE_LIMIT.AGENT_POLL_MAX_REQUESTS,
  message: { error: 'Too many command poll requests, please try again later.' },
  standardHeaders: RATE_LIMIT.STANDARD_HEADERS,
  legacyHeaders: RATE_LIMIT.LEGACY_HEADERS,
  keyGenerator: (req) => `command-poll:${agentIdOf(req)}`,
});

// IP safety net for the fast poll: a client without an agent id still cannot
// flood it, while a whole office behind one NAT stays well within budget
const agentIpLimiter = rateLimit({
  windowMs: RATE_LIMIT.WINDOW_MS,
  max: RATE_LIMIT.AGENT_POLL_IP_MAX_REQUESTS,
  message: { error: 'Too many agent requests, please try again later.' },
  standardHeaders: RATE_LIMIT.STANDARD_HEADERS,
  legacyHeaders: RATE_LIMIT.LEGACY_HEADERS,
});

app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);
app.use('/api/devices/heartbeat', heartbeatLimiter, heartbeatIpLimiter);
app.use('/api/devices/mobile/heartbeat', heartbeatLimiter, heartbeatIpLimiter);
app.use('/api/devices/command-poll', commandPollLimiter, agentIpLimiter);
// Remaining agent endpoints are low frequency but still machine traffic: give
// them an IP budget of their own instead of the human /api bucket
app.use('/api/devices/register', agentIpLimiter);
app.use('/api/devices/inventory', agentIpLimiter);
app.use('/api/devices/command-result', agentIpLimiter);
app.use('/api/devices/security-scan', agentIpLimiter);

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Prometheus scrape target. Unauthenticated like /health by design — scrapers
// hold no session — and strictly read-only. Still rate-limited: each scrape
// runs several aggregate queries, so we bound how often anyone can trigger them.
const metricsLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: { error: 'Too many scrape requests, please try again later.' },
  standardHeaders: RATE_LIMIT.STANDARD_HEADERS,
  legacyHeaders: false,
});

app.get('/metrics', metricsLimiter, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const body = await renderPrometheusMetrics();
    res.status(200).set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(body);
  } catch (error) {
    next(error);
  }
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
import forensicsRoutes from './routes/forensics';
import netsentinelRoutes from './routes/netsentinel';
import reportsRoutes from './routes/reports';
import alertRulesRoutes from './routes/alertRules';

app.use('/api/auth', authRoutes);
app.use('/api/agents', agentsRoutes);
app.use('/api/devices', deviceRoutes);
app.use('/api/commands', commandRoutes);
app.use('/api/users', userRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/alert-rules', alertRulesRoutes);
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
app.use('/api/hermes', forensicsRoutes);
app.use('/api/hermes', hermesRoutes);
app.use('/api/netsentinel', netsentinelRoutes);
app.use('/api/reports', reportsRoutes);

// Public site (landing, login, register) - served before 404 handler
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

// Remote desktop relay: agents push screen frames, operators pull them and send
// input back. Everything travels over the same HTTPS/WSS origin as the API.
initRemoteAccess(server);
logger.info('Remote access relay listening on /remote');

const PORT = parseInt(process.env.PORT || '3001', 10);

// Listen first, initialize the database second. Render's deploy runs a port
// scan right after the container starts and fails the whole deploy ("no open
// HTTP ports detected") if nothing is bound within its window - and schema
// creation plus seeding can exceed that window. Route handlers that need the
// database are safe before init completes: the pool exists as soon as
// initDatabase() runs, and background jobs only start after it resolves.
server.listen(PORT, () => {
  logger.info(`EndpointX API server started on port ${PORT}`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
  logger.info(`API base URL: http://localhost:${PORT}/api`);
});

initDatabase()
  .then(() => {
    // All recurring work lives in src/jobs: offline sweep, threshold alerting,
    // heartbeat retention, metric rollups and the scheduled HERMES scan.
    startBackgroundJobs();
  })
  .catch((err) => {
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

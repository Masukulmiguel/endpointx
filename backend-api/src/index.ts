import dotenv from 'dotenv';
dotenv.config();

import express, { Express, Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import logger from './utils/logger';
import { initDatabase } from './config/database';

const app: Express = express();
const server = http.createServer(app);

export const io = new SocketIOServer(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  message: { error: 'Too many authentication attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10000,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);

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

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', { message: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

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
  });
}).catch((err) => {
  logger.error('Failed to initialize database', { error: err.message });
  process.exit(1);
});

export { app, server };
export default server;

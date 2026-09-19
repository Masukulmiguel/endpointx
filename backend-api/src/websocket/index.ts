import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { db } from '../database';
import { logger } from '../utils/logger';

let io: Server;

interface AuthPayload {
  userId: string;
  email: string;
  role: string;
}

export function initializeWebSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: {
      origin: config.frontendUrl || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true
    },
    pingInterval: 25000,
    pingTimeout: 60000
  });

  io.use(async (socket: Socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const decoded = jwt.verify(token, config.jwt.secret) as AuthPayload;

      const user = await db('users')
        .select('id', 'email', 'role_id')
        .where('id', decoded.userId)
        .first();

      if (!user) {
        return next(new Error('User not found'));
      }

      const role = await db('roles')
        .select('name')
        .where('id', user.role_id)
        .first();

      (socket as any).userId = user.id;
      (socket as any).userEmail = user.email;
      (socket as any).userRole = role?.name || 'viewer';

      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return next(new Error('Token expired'));
      }
      if (error instanceof jwt.JsonWebTokenError) {
        return next(new Error('Invalid token'));
      }
      next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket as any).userId as string;
    const userRole = (socket as any).userRole as string;

    logger.info(`WebSocket connected: user=${userId} role=${userRole} socket=${socket.id}`);

    socket.join(`role:${userRole}`);
    socket.join(`user:${userId}`);

    socket.on('device:subscribe', (deviceId: string) => {
      if (!deviceId || typeof deviceId !== 'string') {
        socket.emit('error', { message: 'Invalid device ID' });
        return;
      }
      socket.join(`device:${deviceId}`);
      logger.debug(`Socket ${socket.id} subscribed to device:${deviceId}`);
    });

    socket.on('device:unsubscribe', (deviceId: string) => {
      if (!deviceId || typeof deviceId !== 'string') {
        socket.emit('error', { message: 'Invalid device ID' });
        return;
      }
      socket.leave(`device:${deviceId}`);
      logger.debug(`Socket ${socket.id} unsubscribed from device:${deviceId}`);
    });

    socket.on('disconnect', (reason) => {
      logger.info(`WebSocket disconnected: user=${userId} reason=${reason} socket=${socket.id}`);
    });

    socket.on('error', (error) => {
      logger.error(`WebSocket error: user=${userId} error=${error.message}`);
    });
  });

  logger.info('WebSocket server initialized');
  return io;
}

export function getIO(): Server {
  if (!io) {
    throw new Error('Socket.IO not initialized. Call initializeWebSocket first.');
  }
  return io;
}

export function emitToDevice(deviceId: string, event: string, data: unknown): void {
  if (!io) return;
  io.to(`device:${deviceId}`).emit(event, data);
}

export function emitToRole(role: string, event: string, data: unknown): void {
  if (!io) return;
  io.to(`role:${role}`).emit(event, data);
}

export function emitToUser(userId: string, event: string, data: unknown): void {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

export function broadcastEvent(event: string, data: unknown): void {
  if (!io) return;
  io.emit(event, data);
}

export function broadcastToAllRoles(event: string, data: unknown): void {
  if (!io) return;
  const roles = ['admin', 'manager', 'analyst', 'viewer'];
  roles.forEach(role => {
    io.to(`role:${role}`).emit(event, data);
  });
}

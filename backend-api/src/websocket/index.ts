import { Server, Socket } from 'socket.io';
import { AuthUser, verifyAccessToken } from '../middleware/auth';

declare module 'socket.io' {
  interface SocketData {
    user?: AuthUser;
  }
}

let io: Server;

// Handshake authentication: the dashboard connects with
// auth: { token } (SocketContext.tsx). Without a valid access token the
// socket never reaches 'connection', so events and rooms are unreachable.
export async function socketAuthMiddleware(socket: Socket, next: (err?: Error) => void): Promise<void> {
  try {
    const token = socket.handshake.auth?.token as string | undefined;
    const user = await verifyAccessToken(token);
    if (!user) {
      next(new Error('unauthorized'));
      return;
    }
    socket.data.user = user;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
}

// Room policy: a socket may only observe rooms tied to its own identity.
// device:<id> requires devices.view (DeviceDetail streaming).
export function canJoinRoom(user: { id: string; role_name: string; permissions: string[] }, room: string): boolean {
  if (room === `user:${user.id}`) return true;
  if (room === `role:${user.role_name}`) return true;
  if (room.startsWith('device:')) return user.permissions.includes('devices.view');
  return false;
}

export function getIO(): Server {
  if (!io) {
    throw new Error('Socket.IO not initialized');
  }
  return io;
}

export function setIO(socketIo: Server): void {
  io = socketIo;
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

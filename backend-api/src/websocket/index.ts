import { Server, Socket } from 'socket.io';

let io: Server;

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

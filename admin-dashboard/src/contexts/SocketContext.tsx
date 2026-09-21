import React, { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';

interface DeviceStatusEvent {
  device_id: string;
  status: string;
  timestamp: string;
  ip_address?: string;
  hostname?: string;
}

interface DeviceHeartbeatEvent {
  device_id: string;
  timestamp: string;
  cpu_usage?: number;
  memory_usage?: number;
  disk_usage?: number;
}

interface AlertNewEvent {
  alert_id: string;
  type: string;
  severity: string;
  message: string;
  device_id?: string;
  timestamp: string;
}

interface SecurityEventPayload {
  event_id: string;
  type: string;
  severity: string;
  description: string;
  device_id?: string;
  user_id?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface SocketContextType {
  socket: Socket | null;
  connected: boolean;
  onDeviceStatus: (handler: (data: DeviceStatusEvent) => void) => () => void;
  onDeviceHeartbeat: (handler: (data: DeviceHeartbeatEvent) => void) => () => void;
  onAlertNew: (handler: (data: AlertNewEvent) => void) => () => void;
  onSecurityEvent: (handler: (data: SecurityEventPayload) => void) => () => void;
}

const SocketContext = createContext<SocketContextType | undefined>(undefined);

interface SocketProviderProps {
  children: ReactNode;
}

export function SocketProvider({ children }: SocketProviderProps) {
  const { user } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!user) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
        setConnected(false);
      }
      return;
    }

    const token = localStorage.getItem('access_token');
    if (!token) return;

    const newSocket = io(window.location.hostname === 'localhost' ? window.location.origin : 'https://endpointx.onrender.com', {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    newSocket.on('connect', () => {
      setConnected(true);
    });

    newSocket.on('disconnect', () => {
      setConnected(false);
    });

    newSocket.on('connect_error', () => {
      setConnected(false);
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
      setSocket(null);
      setConnected(false);
    };
  }, [user]);

  const onDeviceStatus = useCallback(
    (handler: (data: DeviceStatusEvent) => void) => {
      if (!socket) return () => {};
      socket.on('device:status', handler);
      return () => {
        socket.off('device:status', handler);
      };
    },
    [socket]
  );

  const onDeviceHeartbeat = useCallback(
    (handler: (data: DeviceHeartbeatEvent) => void) => {
      if (!socket) return () => {};
      socket.on('device:heartbeat', handler);
      return () => {
        socket.off('device:heartbeat', handler);
      };
    },
    [socket]
  );

  const onAlertNew = useCallback(
    (handler: (data: AlertNewEvent) => void) => {
      if (!socket) return () => {};
      socket.on('alert:new', handler);
      return () => {
        socket.off('alert:new', handler);
      };
    },
    [socket]
  );

  const onSecurityEvent = useCallback(
    (handler: (data: SecurityEventPayload) => void) => {
      if (!socket) return () => {};
      socket.on('security:event', handler);
      return () => {
        socket.off('security:event', handler);
      };
    },
    [socket]
  );

  const value: SocketContextType = {
    socket,
    connected,
    onDeviceStatus,
    onDeviceHeartbeat,
    onAlertNew,
    onSecurityEvent,
  };

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextType {
  const context = useContext(SocketContext);
  if (context === undefined) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}

export type {
  DeviceStatusEvent,
  DeviceHeartbeatEvent,
  AlertNewEvent,
  SecurityEventPayload,
};

export default SocketContext;

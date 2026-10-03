import { randomUUID, createHmac } from 'crypto';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { query } from '../config/database';
import { verifyAccessToken, AuthUser } from '../middleware/auth';
import { canAccessDevice } from '../utils/tenant';
import logger from '../utils/logger';

const REMOTE_PATH = '/remote';
const HANDSHAKE_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
const MAX_OPERATORS_PER_DEVICE = 4;
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Room {
  agent?: WebSocket;
  operators: Set<WebSocket>;
  /** Last screen inventory advertised by the agent (one entry per monitor). */
  monitors?: Record<string, unknown>;
  /** Last capability report (Android: screen share + accessibility input). */
  caps?: Record<string, unknown>;
}

const rooms = new Map<string, Room>();
const authenticated = new WeakSet<WebSocket>();

type AuthedSocket = WebSocket & {
  deviceId?: string;
  user?: AuthUser;
  role?: 'agent' | 'operator';
};

function getRoom(deviceId: string): Room {
  let room = rooms.get(deviceId);
  if (!room) {
    room = { operators: new Set() };
    rooms.set(deviceId, room);
  }
  return room;
}

function cleanupRoom(deviceId: string): void {
  const room = rooms.get(deviceId);
  if (!room) return;
  if (!room.agent && room.operators.size === 0) rooms.delete(deviceId);
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastToOperators(deviceId: string, payload: Record<string, unknown>): void {
  const room = rooms.get(deviceId);
  if (!room) return;
  const raw = JSON.stringify(payload);
  for (const op of room.operators) {
    if (op.readyState === WebSocket.OPEN) op.send(raw);
  }
}

async function writeAudit(
  user: AuthUser | null,
  deviceId: string,
  action: string,
  description: string,
  ip: string | undefined
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), user?.id ?? null, user?.email ?? null, action, 'device', deviceId, description, ip ?? null]
    );
  } catch (error) {
    logger.warn('Failed to write remote session audit log', {
      deviceId,
      error: (error as Error).message,
    });
  }
}

function closeWith(ws: WebSocket, message: string): void {
  sendJson(ws, { t: 'error', message });
  setTimeout(() => ws.close(), 50);
}

// Per-device credential handed to managed endpoints (the Android app) at
// enrolment time. It never leaves the device, so the shared AGENT_SECRET does
// not have to be baked into a redistributable APK - yet the relay can still
// verify the endpoint without storing anything extra.
export function remoteSecretFor(agentId: string): string {
  return createHmac('sha256', process.env.AGENT_SECRET || '')
    .update(`endpointx:remote:${agentId}`)
    .digest('hex');
}

async function handleAgentHandshake(ws: WebSocket, agentId: string, secret: string): Promise<void> {
  const expected = process.env.AGENT_SECRET;
  const allowed = !!expected && (secret === expected || secret === remoteSecretFor(agentId));
  if (!allowed) {
    closeWith(ws, 'invalid agent secret');
    return;
  }

  let deviceId: string | null = null;
  try {
    const result = await query('SELECT id FROM devices WHERE agent_id = $1 AND is_authorized = true', [agentId]);
    deviceId = result.rows.length > 0 ? result.rows[0].id : null;
  } catch (error) {
    logger.warn('Remote: agent lookup failed', { error: (error as Error).message });
  }
  if (!deviceId) {
    closeWith(ws, 'unknown agent');
    return;
  }

  const room = getRoom(deviceId);
  if (room.agent && room.agent.readyState === WebSocket.OPEN) {
    // A second connection from the same agent means the previous one is stale
    room.agent.terminate();
  }
  room.agent = ws;
  authenticated.add(ws);
  const authed = ws as AuthedSocket;
  authed.role = 'agent';
  authed.deviceId = deviceId;
  sendJson(ws, { t: 'ready', role: 'agent', device_id: deviceId });
  broadcastToOperators(deviceId, { t: 'agent', connected: true });
  // Presence: the socket is the freshest signal we have, so a phone that just
  // came back from doze is online the moment it reconnects instead of waiting
  // for the next HTTP heartbeat. Only a genuinely offline device flips, so
  // contained/blocked states are preserved (same rule as the heartbeats).
  void query(
    "UPDATE devices SET status = 'online', last_heartbeat = NOW() WHERE id = $1 AND status = 'offline'",
    [deviceId]
  ).catch((error) => logger.warn('Remote: presence update failed', { deviceId, error: (error as Error).message }));
  logger.info('Remote: agent connected', { deviceId, agentId });
}

async function handleOperatorHandshake(
  ws: WebSocket,
  deviceId: string,
  token: string,
  ip: string | undefined
): Promise<void> {
  const user = await verifyAccessToken(token);
  if (!user) {
    closeWith(ws, 'authentication failed');
    return;
  }
  if (!(await canAccessDevice(user, deviceId))) {
    closeWith(ws, 'device not available');
    return;
  }

  const room = getRoom(deviceId);
  if (room.operators.size >= MAX_OPERATORS_PER_DEVICE) {
    closeWith(ws, 'too many viewers');
    return;
  }

  room.operators.add(ws);
  authenticated.add(ws);
  const authed = ws as AuthedSocket;
  authed.role = 'operator';
  authed.deviceId = deviceId;
  authed.user = user;
  sendJson(ws, { t: 'ready', role: 'operator', device_id: deviceId, agent_connected: !!room.agent });
  if (room.monitors) sendJson(ws, room.monitors);
  if (room.caps) sendJson(ws, room.caps);
  logger.info('Remote: operator connected', { deviceId, userId: user.id });
  await writeAudit(user, deviceId, 'remote_session', `Remote session started (${deviceId})`, ip);
}

function handleAgentMessage(deviceId: string, data: Buffer | string, isBinary: boolean): void {
  const room = rooms.get(deviceId);
  if (!room) return;

  if (isBinary) {
    // Screen frame - relay as-is to every connected operator
    for (const op of room.operators) {
      if (op.readyState !== WebSocket.OPEN) continue;
      if (op.bufferedAmount > MAX_BUFFERED_BYTES) continue; // slow client: drop instead of queueing
      op.send(data, { binary: true });
    }
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (payload.t === 'monitors') room.monitors = payload;
  if (payload.t === 'caps') room.caps = payload;
  broadcastToOperators(deviceId, payload);
}

function handleOperatorMessage(deviceId: string, data: Buffer | string, isBinary: boolean, from?: WebSocket): void {
  if (isBinary) return;
  const room = rooms.get(deviceId);
  if (!room?.agent || room.agent.readyState !== WebSocket.OPEN) {
    if (from) sendJson(from, { t: 'error', message: 'O agente nao esta ligado a este dispositivo' });
    return;
  }
  room.agent.send(data, { binary: false });
}

function dropFromRoom(ws: AuthedSocket): void {
  const deviceId = ws.deviceId;
  if (!deviceId) return;
  const room = rooms.get(deviceId);
  if (!room) return;

  room.operators.delete(ws);

  if (room.operators.size === 0 && room.agent && room.agent.readyState === WebSocket.OPEN) {
    // Nobody is watching any more - stop the capture loop on the endpoint
    room.agent.send(JSON.stringify({ t: 'stop' }));
  }

  if (ws.user) {
    void writeAudit(ws.user, deviceId, 'remote_session', `Remote session ended (${deviceId})`, undefined);
  }
  broadcastToOperators(deviceId, { t: 'viewers', count: room.operators.size });
  cleanupRoom(deviceId);
}

function dropAgent(deviceId: string, socket: WebSocket): void {
  const room = rooms.get(deviceId);
  if (!room) return;
  // The agent may have already reconnected and replaced this socket: only the
  // connection that is still registered in the room may clear the slot,
  // otherwise a stale close event would orphan the live connection.
  if (room.agent !== socket) return;
  delete room.agent;
  broadcastToOperators(deviceId, { t: 'agent', connected: false });
  logger.info('Remote: agent disconnected', { deviceId });
}

export function initRemoteAccess(server: Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== REMOTE_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    let handshakeTimer: NodeJS.Timeout | undefined;
    let closed = false;
    let handshaking = false;

    const finish = () => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
    };

    handshakeTimer = setTimeout(() => {
      if (!authenticated.has(ws)) {
        closeWith(ws, 'handshake timeout');
      }
    }, HANDSHAKE_TIMEOUT_MS);

    const ip = req.socket.remoteAddress || undefined;

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (closed) return;
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);

      if (!authenticated.has(ws)) {
        if (handshaking) return;
        if (isBinary) {
          closeWith(ws, 'handshake required');
          return;
        }
        let hello: any;
        try {
          hello = JSON.parse(buf.toString());
        } catch {
          closeWith(ws, 'invalid handshake');
          return;
        }
        finish();
        handshaking = true;
        if (hello.role === 'agent') {
          const agentId = String(hello.agent_id || '');
          if (!agentId || agentId.length > 128) {
            closeWith(ws, 'invalid agent id');
            return;
          }
          void handleAgentHandshake(ws, agentId, String(hello.secret || ''));
        } else if (hello.role === 'operator') {
          const deviceId = String(hello.device_id || '');
          if (!UUID_RE.test(deviceId)) {
            closeWith(ws, 'invalid device id');
            return;
          }
          void handleOperatorHandshake(ws, deviceId, String(hello.token || ''), ip);
        } else {
          closeWith(ws, 'unknown role');
        }
        return;
      }

      const authed = ws as AuthedSocket;
      if (authed.role === 'operator' && authed.deviceId) {
        handleOperatorMessage(authed.deviceId, buf, isBinary, ws);
      } else if (authed.role === 'agent' && authed.deviceId) {
        handleAgentMessage(authed.deviceId, buf, isBinary);
      }
    });

    ws.on('pong', () => {
      (ws as any).isAlive = true;
    });

    ws.on('close', () => {
      closed = true;
      finish();
      if (authenticated.has(ws)) {
        const authed = ws as AuthedSocket;
        if (authed.role === 'operator') {
          dropFromRoom(authed);
        } else if (authed.role === 'agent' && authed.deviceId) {
          dropAgent(authed.deviceId, ws);
          cleanupRoom(authed.deviceId);
        }
      }
    });

    ws.on('error', (error) => {
      logger.warn('Remote: socket error', { error: error.message });
    });

    (ws as any).isAlive = true;
  });

  setInterval(() => {
    wss.clients.forEach((ws) => {
      if ((ws as any).isAlive === false) {
        ws.terminate();
        return;
      }
      (ws as any).isAlive = false;
      ws.ping();
    });
  }, PING_INTERVAL_MS).unref();
}

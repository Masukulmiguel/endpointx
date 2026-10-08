/**
 * RED->GREEN gate for Task 3: Socket.IO must reject unauthenticated
 * handshakes, and room joins must be scoped to the connecting user.
 * Run: npx tsx tests/socketAuth.test.ts
 */
import './testEnv';
import assert from 'assert';
import http from 'http';
import jwt from 'jsonwebtoken';
import { Server as SocketIOServer } from 'socket.io';
import { JWT } from '../src/config/constants';
import * as websocket from '../src/websocket';

let failed = 0;
const check = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${(error as Error).message}`);
  }
};

const OWN_ID = '3ccbf05c-3ead-4f92-8da3-b22476aeb16';
const OTHER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const sessionToken = (permissions: string[]) =>
  jwt.sign(
    {
      id: OWN_ID,
      email: 'viewer@endpointx.local',
      role_id: '22222222-2222-4222-8222-222222222222',
      role_name: 'user',
      permissions,
    },
    JWT.ACCESS_SECRET,
    { issuer: JWT.ISSUER, audience: JWT.AUDIENCE, expiresIn: '1h' }
  );

// Minimal Engine.IO v4 client over the global WebSocket (Node >= 22).
class SioClient {
  private messages: string[] = [];
  private closed = false;
  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (event) => this.messages.push(String(event.data)));
    ws.addEventListener('close', () => {
      this.closed = true;
    });
  }
  static open(url: string): Promise<SioClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error('ws open timeout')), 3000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new SioClient(ws));
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`ws error: ${(e as Error).message ?? e.type}`));
      });
    });
  }
  send(data: string): void {
    this.ws.send(data);
  }
  waitFor(pred: (m: string) => boolean, ms = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const hit = this.messages.find(pred);
        if (hit !== undefined) return resolve(hit);
        if (this.closed) return reject(new Error(`socket closed; saw: ${this.messages.join(' | ') || '(nothing)'}`));
        if (Date.now() - started > ms) return reject(new Error(`timeout; saw: ${this.messages.join(' | ') || '(nothing)'}`));
        setTimeout(tick, 25);
      };
      tick();
    });
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

const until = async (pred: () => boolean, ms = 2000): Promise<boolean> => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
};

async function main(): Promise<void> {
  const canJoinRoom = (websocket as { canJoinRoom?: unknown }).canJoinRoom;
  const socketAuthMiddleware = (websocket as { socketAuthMiddleware?: unknown }).socketAuthMiddleware;

  // --- Unit: canJoinRoom policy -------------------------------------------
  const user = { id: OWN_ID, role_name: 'user', permissions: ['devices.view'] } as const;
  const noDevView = { id: OWN_ID, role_name: 'user', permissions: [] } as const;
  const join = (u: unknown, room: string): unknown => {
    if (typeof canJoinRoom !== 'function') throw new Error('canJoinRoom not exported');
    return (canJoinRoom as (u: unknown, r: string) => boolean)(u, room);
  };

  const unitCases: Array<[string, () => void]> = [
    ['canJoinRoom is exported', () => assert.strictEqual(typeof canJoinRoom, 'function')],
    ['own user room allowed', () => assert.strictEqual(join(user, `user:${OWN_ID}`), true)],
    ['other user room denied', () => assert.strictEqual(join(user, `user:${OTHER_ID}`), false)],
    ['own role room allowed', () => assert.strictEqual(join(user, 'role:user'), true)],
    ['role:admin denied for non-admin', () => assert.strictEqual(join(user, 'role:admin'), false)],
    ['device room allowed with devices.view', () => assert.strictEqual(join(user, 'device:dev-1'), true)],
    ['device room denied without devices.view', () => assert.strictEqual(join(noDevView, 'device:dev-1'), false)],
    ['arbitrary room denied', () => assert.strictEqual(join(user, 'anything:else'), false)],
  ];
  for (const [label, fn] of unitCases) check(label, fn);

  // --- Integration: handshake + room gating -------------------------------
  const server = http.createServer();
  const io = new SocketIOServer(server, { cors: { origin: '*' } });
  try {
    if (typeof socketAuthMiddleware === 'function') {
      io.use(socketAuthMiddleware as Parameters<typeof io.use>[0]);
    }
    io.on('connection', (socket) => {
      socket.on('join_room', (room: string) => {
        const data = socket.data as { user?: { id: string; role_name: string; permissions: string[] } };
        if (!data.user) return;
        if (typeof canJoinRoom !== 'function') return;
        if ((canJoinRoom as (u: unknown, r: string) => boolean)(data.user, room)) void socket.join(room);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const url = (tokenPayload: string) =>
      `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`;

    // Unauthenticated connect must fail and must not yield a session id.
    {
      let client: SioClient | undefined;
      try {
        client = await SioClient.open(url(''));
        client.send('40'); // namespace CONNECT with empty auth
        const msg = await client.waitFor((m) => m.startsWith('44') || m.startsWith('40{')).catch(() => undefined);
        check('handshake without token -> connect_error, no sid', () => {
          assert.ok(msg !== undefined, 'expected connect_error or close');
          assert.ok(msg.startsWith('44'), `expected 44 packet, got: ${msg}`);
          assert.ok(!msg.startsWith('40{'), 'must not receive a session id');
        });
      } catch (error) {
        check('handshake without token -> connect_error, no sid', () => {
          throw error;
        });
      } finally {
        client?.close();
      }
    }

    // Garbage token must fail too.
    {
      let client: SioClient | undefined;
      try {
        client = await SioClient.open(url(''));
        // Wire format: the CONNECT packet data IS handshake.auth (the real
        // socket.io client spreads {auth:{...}} into the packet as {"token":...}).
        client.send('40{"token":"garbage"}');
        const msg = await client.waitFor((m) => m.startsWith('44') || m.startsWith('40{')).catch(() => undefined);
        check('handshake with garbage token -> connect_error', () => {
          assert.ok(msg !== undefined && msg.startsWith('44'), `expected 44 packet, got: ${msg}`);
        });
      } catch (error) {
        check('handshake with garbage token -> connect_error', () => {
          throw error;
        });
      } finally {
        client?.close();
      }
    }

    // Valid token connects, then room scoping applies.
    {
      let client: SioClient | undefined;
      try {
        client = await SioClient.open(url(''));
        client.send(`40{"token":"${sessionToken(['devices.view'])}"}`);
        const msg = await client.waitFor((m) => m.startsWith('40{') || m.startsWith('44'));
        check('handshake with valid token -> sid', () => {
          assert.ok(msg.startsWith('40{'), `expected sid packet, got: ${msg}`);
        });

        if (msg.startsWith('40{')) {
          const sid = (JSON.parse(msg.slice(2)) as { sid: string }).sid;

          // Negatives first, positives last: per-socket ordering means once a
          // positive room shows up, every earlier join was already processed.
          client.send(`42["join_room","user:${OTHER_ID}"]`);
          client.send('42["join_room","role:admin"]');
          client.send('42["join_room","arbitrary:room"]');
          client.send('42["join_room","role:user"]');
          client.send(`42["join_room","user:${OWN_ID}"]`);
          client.send(`42["join_room","device:dev-1"]`);

          const inRoom = (room: string) => io.of('/').adapter.rooms.get(room)?.has(sid) ?? false;
          const gotPositive = await until(() => inRoom(`user:${OWN_ID}`) && inRoom('role:user') && inRoom('device:dev-1'));

          check('join_room scoping (own user/role/device rooms join; others rejected)', () => {
            assert.ok(gotPositive, 'expected allowed rooms to be joined');
            assert.strictEqual(inRoom(`user:${OTHER_ID}`), false, 'joined foreign user room');
            assert.strictEqual(inRoom('role:admin'), false, 'joined admin room as non-admin');
            assert.strictEqual(inRoom('arbitrary:room'), false, 'joined arbitrary room');
          });
        }
      } catch (error) {
        check('valid-token connection + join scoping', () => {
          throw error;
        });
      } finally {
        client?.close();
      }
    }
  } finally {
    io.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
  }

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

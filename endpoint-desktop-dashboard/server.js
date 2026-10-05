/**
 * Local static server for the packaged dashboard.
 *
 * The Electron shell serves the built SPA from http://127.0.0.1:<port>. That
 * origin matters: the dashboard's api.ts, ssoService.ts, SocketContext.tsx and
 * RemoteViewer.tsx treat anything other than "localhost" as production and
 * send API/WebSocket traffic to the hosted backend, so the shell never has to
 * proxy or serve the API itself.
 *
 * Rules:
 *  - bind 127.0.0.1 only, never 0.0.0.0
 *  - API namespaces (/api, /socket.io, /remote) answer 404: the packaged app
 *    must not believe a local API exists
 *  - a missing path with a file extension answers 404 (a wrong MIME type on a
 *    missing chunk is worse than a 404)
 *  - any other missing path falls back to index.html so BrowserRouter deep
 *    links work (mirrors try_files $uri $uri/ /index.html in nginx.conf)
 */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const API_PREFIXES = ['/api', '/socket.io', '/remote'];

const isApiPath = (pathname) =>
  API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

const send = (req, res, status, body, headers = {}) => {
  const payload = Buffer.from(body);
  res.writeHead(status, {
    'Content-Length': payload.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(payload);
};

const contentTypeFor = (filePath) =>
  MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

const cacheFor = (pathname, isHtml) => {
  if (isHtml) return 'no-cache';
  if (pathname.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  return 'no-cache';
};

async function createStaticServer({ root, port = 0 } = {}) {
  if (!root) throw new Error('createStaticServer: root is required');

  const rootDir = path.resolve(root);
  const indexFile = path.join(rootDir, 'index.html');

  const serveFile = async (req, res, pathname, filePath) => {
    const body = await fs.readFile(filePath);
    const isHtml = path.extname(filePath).toLowerCase() === '.html';
    send(req, res, 200, body, {
      'Content-Type': contentTypeFor(filePath),
      'Cache-Control': cacheFor(pathname, isHtml),
    });
  };

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(req, res, 405, 'Method Not Allowed', {
        'Content-Type': 'text/plain; charset=utf-8',
        Allow: 'GET, HEAD',
      });
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    } catch {
      send(req, res, 400, 'Bad Request', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }
    if (!pathname.startsWith('/')) pathname = `/${pathname}`;

    const normalized = path.posix.normalize(pathname);
    if (normalized.startsWith('..')) {
      send(req, res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    if (isApiPath(normalized)) {
      send(req, res, 404, JSON.stringify({ error: 'no local API in the packaged dashboard' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return;
    }

    const candidate = path.resolve(rootDir, `.${normalized}`);
    if (candidate !== rootDir && !candidate.startsWith(rootDir + path.sep)) {
      send(req, res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) {
        await serveFile(req, res, normalized, candidate);
        return;
      }
      if (stats.isDirectory()) {
        const dirIndex = path.join(candidate, 'index.html');
        await serveFile(req, res, normalized, dirIndex);
        return;
      }
    } catch {
      // fall through to the SPA / 404 rules below
    }

    const lastSegment = normalized.split('/').pop() || '';
    if (lastSegment.includes('.')) {
      send(req, res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
      return;
    }

    try {
      await serveFile(req, res, '/', indexFile);
    } catch {
      send(req, res, 503, 'Dashboard build missing', {
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return { server, port: boundPort, url: `http://127.0.0.1:${boundPort}` };
}

module.exports = { createStaticServer, MIME };

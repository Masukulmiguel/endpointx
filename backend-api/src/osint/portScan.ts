import { PortResult, OsintModuleResult } from './types';
import { cacheGet, cacheSet, TTL } from './cache';
import { isValidIp } from './ipLookup';
import { isValidDomain } from './dnsLookup';
import * as net from 'net';

const COMMON_PORTS = [
  21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 389, 443, 445,
  993, 995, 1433, 1521, 2049, 3306, 3389, 5432, 5900, 6379, 8080, 8443, 9200, 27017,
];

const PORT_SERVICES: Record<number, string> = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP',
  110: 'POP3', 111: 'RPCBind', 135: 'MSRPC', 139: 'NetBIOS', 143: 'IMAP',
  389: 'LDAP', 443: 'HTTPS', 445: 'SMB', 993: 'IMAPS', 995: 'POP3S',
  1433: 'MSSQL', 1521: 'Oracle', 2049: 'NFS', 3306: 'MySQL', 3389: 'RDP',
  5432: 'PostgreSQL', 5900: 'VNC', 6379: 'Redis', 8080: 'HTTP-Proxy',
  8443: 'HTTPS-Alt', 9200: 'Elasticsearch', 27017: 'MongoDB',
};

const CONCURRENCY = 32;
const TIMEOUT_MS = 2000;

function probePort(host: string, port: number): Promise<PortResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let banner = '';

    socket.setTimeout(TIMEOUT_MS);
    socket.on('connect', () => {
      socket.write('\r\n');
      socket.on('data', (data) => {
        banner = data.toString('utf8').trim().slice(0, 256);
      });
      setTimeout(() => {
        socket.destroy();
        resolve({ port, state: 'open', service: PORT_SERVICES[port], banner: banner || undefined });
      }, 500);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ port, state: 'filtered', service: PORT_SERVICES[port] });
    });
    socket.on('error', () => {
      socket.destroy();
      resolve({ port, state: 'closed', service: PORT_SERVICES[port] });
    });
    socket.connect(port, host);
  });
}

export async function scanPorts(host: string, ports?: number[]): Promise<OsintModuleResult<PortResult[]>> {
  if (!isValidIp(host) && !isValidDomain(host)) {
    return { success: false, error: 'Target must be a valid IP or domain', source: 'tcp-connect' };
  }

  const targetPorts = ports && ports.length > 0 ? ports.slice(0, 100) : COMMON_PORTS;
  const cacheKey = `ports:${host}:${targetPorts.join(',')}`;
  const cached = cacheGet<PortResult[]>(cacheKey);
  if (cached) return { success: true, data: cached, source: 'cached' };

  try {
    const results: PortResult[] = [];
    let index = 0;

    async function worker() {
      while (index < targetPorts.length) {
        const i = index++;
        const result = await probePort(host, targetPorts[i]);
        results.push(result);
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targetPorts.length) }, worker));

    results.sort((a, b) => a.port - b.port);
    const openResults = results.filter(r => r.state === 'open');
    cacheSet(cacheKey, openResults.length > 0 ? results : results, TTL.DNS);
    return { success: true, data: results, source: 'tcp-connect' };
  } catch (error) {
    return { success: false, error: (error as Error).message, source: 'tcp-connect' };
  }
}

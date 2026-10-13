import { Router, Response, NextFunction } from 'express';
import { query } from '../config/database';
import { AuthRequest, authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import logger from '../utils/logger';
import {
  lookupIp, isValidIp,
  lookupDns, isValidDomain,
  lookupWhois,
  enumerateSubdomains,
  lookupEmail, isValidEmail,
  lookupPhone, isValidPhone,
  lookupVin, isValidVin,
  lookupShodan,
  scanPorts,
  LookupType,
  OsintLookupResult,
} from '../osint';

const router = Router();

function newId(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

async function audit(action: string, req: AuthRequest, targetType: string, targetId: string, details: any = {}) {
  try {
    await query(
      'INSERT INTO audit_logs (id, user_id, user_email, action, target_type, target_id, description, ip_address, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [newId(), req.user?.id || null, req.user?.email || null, action, targetType, targetId, details.reason || action, req.ip || null, JSON.stringify(details)]
    );
  } catch (e) {
    logger.warn('audit write failed', { action, error: (e as Error).message });
  }
}

async function getSetting(key: string): Promise<string | null> {
  try {
    const result = await query('SELECT value FROM osint_settings WHERE key = $1', [key]);
    return result.rows[0]?.value || null;
  } catch {
    return null;
  }
}

async function saveSetting(key: string, value: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO osint_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, value, userId]
  );
}

function maskKey(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return '****' + value.slice(-4);
}

// POST /api/osint/lookup
router.post('/lookup', authenticate, requirePermission('osint.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { type, target } = req.body as { type: LookupType; target: string };

    if (!type || !target) {
      res.status(400).json({ success: false, error: { message: 'type and target are required' } });
      return;
    }

    const validTypes: LookupType[] = ['ip', 'domain', 'email', 'phone', 'vin', 'subdomain', 'port'];
    if (!validTypes.includes(type)) {
      res.status(400).json({ success: false, error: { message: 'Invalid lookup type. Must be: ip, domain, email, phone, vin, subdomain, or port' } });
      return;
    }

    if (type === 'ip' && !isValidIp(target)) {
      res.status(400).json({ success: false, error: { message: 'Invalid IP address' } });
      return;
    }
    if ((type === 'domain' || type === 'subdomain') && !isValidDomain(target)) {
      res.status(400).json({ success: false, error: { message: 'Invalid domain name' } });
      return;
    }
    if (type === 'email' && !isValidEmail(target)) {
      res.status(400).json({ success: false, error: { message: 'Invalid email address' } });
      return;
    }
    if (type === 'phone' && !isValidPhone(target)) {
      res.status(400).json({ success: false, error: { message: 'Invalid phone number' } });
      return;
    }
    if (type === 'vin' && !isValidVin(target)) {
      res.status(400).json({ success: false, error: { message: 'Invalid VIN (must be 17 alphanumeric characters, excluding I, O, Q)' } });
      return;
    }

    const shodanKey = (await getSetting('shodan_api_key')) || '';
    const hibpKey = (await getSetting('hibp_api_key')) || '';
    const numverifyKey = (await getSetting('numverify_api_key')) || '';

    const sources: string[] = [];
    const errors: string[] = [];
    const data: OsintLookupResult['data'] = {};

    const collect = async <T>(promise: Promise<{ success: boolean; data?: T; error?: string; source?: string }>, key: keyof OsintLookupResult['data']) => {
      const result = await promise;
      if (result.success && result.data) {
        (data as any)[key] = result.data;
        if (result.source) sources.push(result.source);
      } else if (result.error) {
        errors.push(result.error);
      }
    };

    if (type === 'ip') {
      await collect(lookupIp(target), 'ip');
      await collect(lookupWhois(target), 'whois');
      await collect(lookupDns(target.replace(/^.*:/, '') + '.in-addr.arpa'), 'dns');
      if (shodanKey) await collect(lookupShodan(target, shodanKey), 'shodan');
      await collect(scanPorts(target), 'ports');
    } else if (type === 'domain') {
      await collect(lookupDns(target), 'dns');
      await collect(lookupWhois(target), 'whois');
      await collect(enumerateSubdomains(target), 'subdomains');
    } else if (type === 'subdomain') {
      await collect(lookupDns(target), 'dns');
      await collect(enumerateSubdomains(target), 'subdomains');
    } else if (type === 'email') {
      await collect(lookupEmail(target, hibpKey), 'email');
    } else if (type === 'phone') {
      await collect(lookupPhone(target, numverifyKey), 'phone');
    } else if (type === 'vin') {
      await collect(lookupVin(target), 'vin');
    } else if (type === 'port') {
      const [host, portStr] = target.split(':');
      const ports = portStr ? [parseInt(portStr, 10)].filter(p => !isNaN(p)) : undefined;
      await collect(scanPorts(host, ports), 'ports');
    }

    const result: OsintLookupResult = {
      type,
      target,
      timestamp: new Date().toISOString(),
      sources,
      data,
      errors: errors.length > 0 ? errors : undefined,
    };

    let lookupId: string;
    try {
      const insertResult = await query(
        `INSERT INTO osint_lookups (id, type, target, result, sources, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [newId(), type, target, JSON.stringify(result), sources, req.user!.id]
      );
      lookupId = insertResult.rows[0].id;
    } catch (e) {
      logger.warn('osint_lookups insert failed', { error: (e as Error).message });
      lookupId = newId();
    }

    await audit('osint.lookup', req, 'osint_lookup', lookupId, { type, target, sources });

    res.status(201).json({ success: true, data: { id: lookupId, type, target, result } });
  } catch (error) {
    next(error);
  }
});

// GET /api/osint/lookups
router.get('/lookups', authenticate, requirePermission('osint.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '20'), 10) || 20));
    const offset = (page - 1) * limit;
    const type = req.query.type as string | undefined;
    const search = req.query.search as string | undefined;

    const clauses: string[] = ['created_by = $1'];
    const params: any[] = [req.user!.id];

    if (type) {
      params.push(type);
      clauses.push(`type = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      clauses.push(`target ILIKE $${params.length}`);
    }

    const where = clauses.join(' AND ');
    const countResult = await query(`SELECT COUNT(*) as total FROM osint_lookups WHERE ${where}`, params);
    const total = parseInt(countResult.rows[0]?.total || '0', 10);

    params.push(limit, offset);
    const rows = await query(
      `SELECT id, type, target, sources, device_id, created_at
       FROM osint_lookups WHERE ${where}
       ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      success: true,
      data: {
        lookups: rows.rows,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/osint/lookups/:id
router.get('/lookups/:id', authenticate, requirePermission('osint.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      'SELECT id, type, target, result, sources, device_id, created_at FROM osint_lookups WHERE id = $1 AND created_by = $2',
      [req.params.id, req.user!.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Lookup not found' } });
      return;
    }
    res.json({ success: true, data: { lookup: result.rows[0] } });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/osint/lookups/:id
router.delete('/lookups/:id', authenticate, requirePermission('osint.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      'DELETE FROM osint_lookups WHERE id = $1 AND created_by = $2 RETURNING id',
      [req.params.id, req.user!.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Lookup not found' } });
      return;
    }
    await audit('osint.lookup.delete', req, 'osint_lookup', req.params.id);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// POST /api/osint/devices/:deviceId/enrich
router.post('/devices/:deviceId/enrich', authenticate, requirePermission('osint.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const deviceResult = await query(
      `SELECT d.id, d.ip_address FROM devices d
       WHERE d.id = $1 AND (
         d.created_by = $2 OR
         EXISTS (SELECT 1 FROM users u WHERE u.id = $2 AND u.role_id IN (SELECT id FROM roles WHERE name = 'admin'))
       )`,
      [req.params.deviceId, req.user!.id]
    );
    if (deviceResult.rows.length === 0) {
      res.status(404).json({ success: false, error: { message: 'Device not found or not accessible' } });
      return;
    }

    const device = deviceResult.rows[0];
    const ip = device.ip_address;
    if (!ip || !isValidIp(ip)) {
      res.status(400).json({ success: false, error: { message: 'Device has no valid IP address for enrichment' } });
      return;
    }

    const ipResult = await lookupIp(ip);
    const whoisResult = await lookupWhois(ip);
    const sources: string[] = [];
    const data: any = {};
    if (ipResult.success && ipResult.data) { data.ip = ipResult.data; sources.push(ipResult.source || 'ip-api'); }
    if (whoisResult.success && whoisResult.data) { data.whois = whoisResult.data; sources.push(whoisResult.source || 'rdap'); }

    const result: OsintLookupResult = {
      type: 'ip',
      target: ip,
      timestamp: new Date().toISOString(),
      sources,
      data,
    };

    let lookupId: string;
    try {
      const insertResult = await query(
        `INSERT INTO osint_lookups (id, type, target, result, sources, device_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [newId(), 'ip', ip, JSON.stringify(result), sources, device.id, req.user!.id]
      );
      lookupId = insertResult.rows[0].id;
    } catch (e) {
      logger.warn('osint device enrich insert failed', { error: (e as Error).message });
      lookupId = newId();
    }

    await audit('osint.device.enrich', req, 'device', device.id, { ip, sources });

    res.status(201).json({ success: true, data: { lookup_id: lookupId, enriched: result } });
  } catch (error) {
    next(error);
  }
});

// GET /api/osint/settings
router.get('/settings', authenticate, requirePermission('osint.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const shodanKey = await getSetting('shodan_api_key');
    const hibpKey = await getSetting('hibp_api_key');
    const numverifyKey = await getSetting('numverify_api_key');

    res.json({
      success: true,
      data: {
        settings: {
          shodan: { configured: !!shodanKey, masked: shodanKey ? maskKey(shodanKey) : '' },
          hibp: { configured: !!hibpKey, masked: hibpKey ? maskKey(hibpKey) : '' },
          numverify: { configured: !!numverifyKey, masked: numverifyKey ? maskKey(numverifyKey) : '' },
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/osint/settings
router.put('/settings', authenticate, requirePermission('osint.manage'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { shodan_api_key, hibp_api_key, numverify_api_key } = req.body as {
      shodan_api_key?: string;
      hibp_api_key?: string;
      numverify_api_key?: string;
    };

    if (shodan_api_key !== undefined) await saveSetting('shodan_api_key', shodan_api_key, req.user!.id);
    if (hibp_api_key !== undefined) await saveSetting('hibp_api_key', hibp_api_key, req.user!.id);
    if (numverify_api_key !== undefined) await saveSetting('numverify_api_key', numverify_api_key, req.user!.id);

    await audit('osint.settings.update', req, 'osint_settings', 'api_keys');
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// GET /api/osint/health
router.get('/health', authenticate, requirePermission('osint.view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const apis = [
      { name: 'ip-api', url: 'http://ip-api.com/json/8.8.8.8?fields=status' },
      { name: 'google-dns', url: 'https://dns.google/resolve?name=example.com&type=A' },
      { name: 'rdap', url: 'https://rdap.org/domain/example.com' },
      { name: 'crt.sh', url: 'https://crt.sh/?q=example.com&output=json' },
      { name: 'nhtsa-vpic', url: 'https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/1HGCM82633A004352?format=json' },
    ];

    const results = await Promise.all(
      apis.map(async (api) => {
        const start = Date.now();
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          const resp = await fetch(api.url, { signal: controller.signal, headers: { 'User-Agent': 'EndpointX-OSINT/1.4.0' } });
          clearTimeout(timeout);
          return { name: api.name, available: resp.ok, latency_ms: Date.now() - start };
        } catch {
          return { name: api.name, available: false, latency_ms: Date.now() - start };
        }
      })
    );

    const shodanKey = await getSetting('shodan_api_key');
    results.push({ name: 'shodan', available: !!shodanKey, latency_ms: 0 });

    res.json({ success: true, data: { apis: results } });
  } catch (error) {
    next(error);
  }
});

export default router;

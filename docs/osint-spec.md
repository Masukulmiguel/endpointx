# OSINT Subsystem Specification

## Overview

New standalone OSINT (Open Source Intelligence) subsystem for EndpointX, re-implemented in TypeScript as native backend modules. Provides IP geolocation, DNS/WHOIS, subdomain enumeration, email intelligence, phone lookup, VIN decoding, Shodan integration, and port/banner scanning — all accessible via a dedicated dashboard page and enrichable against existing device inventory.

**Inspired by:** [X-osint](https://github.com/Masukulmiguel/X-osint) (Python CLI framework)
**Approach:** Service-layer modular architecture (Approach A — approved)
**Constraint:** Does not modify any existing code paths; purely additive.

## Goals

1. Provide OSINT lookup capabilities natively in EndpointX (no Python dependency).
2. Enrich existing device records with external intelligence (IP, ASN, geolocation).
3. Maintain a searchable history of all OSINT queries with audit trail.
4. Support optional premium API keys (Shodan, Hunter, NumVerify) that unlock additional data when configured.
5. Use free/open APIs where possible to minimize cost and dependency.
6. Full RBAC integration — `osint.view` and `osint.manage` permissions.
7. Multi-tenant safe — lookups scoped to `created_by` user.

## Non-Goals

- Real-time continuous monitoring/crawling (single-query model only).
- Integration with paid breach databases beyond HIBP (optional).
- ProtonMail-specific OSINT (excluded from initial scope).
- Metadata extraction from uploaded files (excluded).
- VIN lookup is included but marked as low-priority niche feature.

## Architecture

### Backend Module Structure

```
backend-api/src/osint/
├── index.ts              # Barrel export of all lookup functions
├── ipLookup.ts           # IP → geolocation, ASN, org, reverse DNS, related domains
├── dnsLookup.ts          # DNS records: A, AAAA, MX, TXT, NS, SOA, CNAME, PTR
├── whoisLookup.ts        # WHOIS/RDAP for domains and IPs
├── subdomainEnum.ts      # Certificate Transparency (crt.sh) + HackerTarget
├── emailOsint.ts         # Email → MX provider, disposable check, breach count (HIBP optional)
├── phoneOsint.ts         # Phone → carrier, country, line type (libphonenumber + optional API)
├── vinLookup.ts          # VIN → vehicle data via NHTSA vPIC API
├── shodanLookup.ts       # Shodan host info (requires API key)
├── portScan.ts           # TCP connect + banner grab (reuses HERMES pattern)
├── types.ts              # Shared interfaces: LookupType, LookupResult, OsintModuleResult
└── cache.ts              # In-memory TTL cache to respect rate limits
```

### External API Matrix

| Capability | API Endpoint | Auth | Rate Limit | Fallback |
|---|---|---|---|---|
| IP Geolocation | `http://ip-api.com/json/{ip}` | None | 45/min | None (core) |
| DNS Resolution | `https://dns.google/resolve` | None | None significant | None (core) |
| WHOIS/RDAP | `https://rdap.org` | None | None significant | None (core) |
| Subdomains (CT) | `https://crt.sh/?q=*.domain&output=json` | None | None significant | None (core) |
| Subdomains (HT) | `https://api.hackertarget.com/hostsearch/?q=domain` | None | 25/day free | CT-only |
| Email MX | DNS lookup on domain | None | None | N/A |
| Disposable check | Static list (DisposableEmailDomains) | None | None | N/A |
| Email Breaches | `https://haveibeenpwned.com/api/v3/breachedaccount/{email}` | API key (paid) | 1 req/1.5s | Skip if no key |
| Phone (local) | `libphonenumber` (bundled) | None | None | N/A |
| Phone (carrier) | `http://apilayer.net/api/validate` (numverify) | API key (free tier) | 100/month free | Local only |
| VIN Decode | `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{vin}?format=json` | None | None significant | N/A |
| Shodan Host | `https://api.shodan.io/shodan/host/{ip}?key=KEY` | API key | 1 req/sec | Skip if no key |
| Port Scan | Direct TCP connect | None | Concurrency-limited | N/A |

### API Key Configuration

Keys stored in `osint_settings` table, masked in API responses (show last 4 chars only). Settings UI in dashboard allows entry, validation (test call), and clearing.

Required keys (all optional — features degrade gracefully):
- `shodan_api_key` — unlocks Shodan tab/section
- `hibp_api_key` — unlocks breach checking
- `numverify_api_key` — unlocks carrier lookup

### Data Flow

```
User Input (type + target)
  → POST /api/osint/lookup
  → Route validates (zod), checks RBAC
  → Dispatch to appropriate module(s)
  → Module makes HTTP calls (AbortSignal.timeout, User-Agent header)
  → Normalized result assembled
  → INSERT INTO osint_lookups (audit + history)
  → If IP matches a device: UPDATE device metadata enrichment
  → Return { success, data: { lookup, result } }
```

### Database Schema

```sql
-- History of all OSINT queries
CREATE TABLE IF NOT EXISTS osint_lookups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type VARCHAR(20) NOT NULL,           -- ip, domain, email, phone, vin, subdomain, port
  target TEXT NOT NULL,                -- the queried value
  result JSONB NOT NULL,               -- normalized result
  sources TEXT[] DEFAULT '{}',         -- which APIs were consulted
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_osint_lookups_type ON osint_lookups(type);
CREATE INDEX IF NOT EXISTS idx_osint_lookups_created_by ON osint_lookups(created_by);
CREATE INDEX IF NOT EXISTS idx_osint_lookups_device ON osint_lookups(device_id);
CREATE INDEX IF NOT EXISTS idx_osint_lookups_target ON osint_lookups(target);

-- API keys and feature flags
CREATE TABLE IF NOT EXISTS osint_settings (
  key VARCHAR(100) PRIMARY KEY,
  value TEXT,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Permissions

| Code | Name | Category | Description |
|---|---|---|---|
| `osint.view` | View OSINT | osint | View OSINT lookups and history |
| `osint.manage` | Manage OSINT | osint | Perform OSINT queries and manage API keys |

Seeded in `allPerms` array in `database.ts`. Admin role auto-receives both.

### API Endpoints

All routes: `authenticate` + `requirePermission(...)`.

| Method | Path | Permission | Body/Query | Response |
|---|---|---|---|---|
| POST | `/api/osint/lookup` | `osint.manage` | `{ type, target, options? }` | `{ success, data: { id, type, target, result, sources } }` |
| GET | `/api/osint/lookups` | `osint.view` | `?page=&limit=&type=&search=&device_id=` | `{ success, data: { lookups[], pagination } }` |
| GET | `/api/osint/lookups/:id` | `osint.view` | — | `{ success, data: { lookup } }` |
| DELETE | `/api/osint/lookups/:id` | `osint.manage` | — | `{ success }` |
| POST | `/api/osint/devices/:deviceId/enrich` | `osint.manage` | — | `{ success, data: { lookup_id, enriched } }` |
| GET | `/api/osint/settings` | `osint.view` | — | `{ success, data: { settings: { shodan: {configured, masked}, hibp: {...}, numverify: {...} } } }` |
| PUT | `/api/osint/settings` | `osint.manage` | `{ shodan_api_key?, hibp_api_key?, numverify_api_key? }` | `{ success }` |
| GET | `/api/osint/health` | `osint.view` | — | `{ success, data: { apis: [{name, available, latency_ms}] } }` |

### Route Registration

In `backend-api/src/index.ts`, add:
```ts
import osintRoutes from './routes/osint';
// ... in route mounting block:
app.use('/api/osint', osintRoutes);
```

### Frontend

#### Page: `admin-dashboard/src/pages/OsintPage.tsx`

Layout:
- **Header:** Title, subtitle, stats (total lookups, by type)
- **Query Bar:** Type selector dropdown (IP / Domain / Email / Phone / VIN / Port) + target input + "Lookup" button + loading state
- **Results Area:** Sectioned cards based on type:
  - IP: Geolocation card, ASN/Org card, Reverse DNS card, Shodan card (if key), Port scan card
  - Domain: DNS records table, WHOIS card, Subdomains list card
  - Email: Provider/MX card, Disposable badge, Breaches card (if HIBP key)
  - Phone: Carrier card, Country/Type card
  - VIN: Vehicle details card
  - Port: Open ports table with banners
- **History Sidebar/Panel:** Paginated list of recent lookups, filter by type, click to re-load result, delete button
- **Settings Modal:** API key entry (password inputs), test connection button, status indicators

Routing: `/osint` → `<PermissionGate permission="osint.view"><OsintPage /></PermissionGate>`

Nav: New group "Intelligence" in `Layout.tsx` containing "OSINT" item.

i18n: `nav.osint`, `osint.*` keys in both `pt` and `en` dictionaries.

### Result Shape (Normalized)

```ts
interface OsintLookupResult {
  type: 'ip' | 'domain' | 'email' | 'phone' | 'vin' | 'subdomain' | 'port';
  target: string;
  timestamp: string;
  sources: string[];           // e.g. ['ip-api', 'google-dns', 'rdap']
  data: {
    // IP-specific
    ip?: { country, countryCode, region, regionName, city, zip, lat, lon, timezone, isp, org, as, asname, reverse, query };
    // Domain-specific
    dns?: { a: string[], aaaa: string[], mx: string[], txt: string[], ns: string[], soa: string[], cname: string[], ptr: string[] };
    whois?: { registrar, creationDate, expiryDate, nameServers: string[], status: string[], registrantOrg?, registrantCountry? };
    subdomains?: { domain: string, source: string }[];
    // Email-specific
    email?: { provider, mxRecords: string[], isDisposable: boolean, domainAge?, breaches?: { name, breachDate, dataClasses }[] };
    // Phone-specific
    phone?: { valid, countryCode, country, carrier?, lineType?, numberType? };
    // VIN-specific
    vin?: { make, model, modelYear, bodyClass, manufacturer, plantCountry, series, trim, engineCylinders?, fuelTypePrimary? };
    // Shodan-specific
    shodan?: { ports: number[], hostnames: string[], org, os?, vulns?: string[] };
    // Port scan-specific
    ports?: { port: number, state: 'open'|'closed'|'filtered', service?: string, banner?: string }[];
  };
}
```

### Caching & Rate Limiting

- In-memory LRU cache with per-module TTL:
  - IP geolocation: 1 hour
  - DNS: 15 minutes
  - WHOIS: 24 hours
  - Subdomains: 6 hours
  - VIN: permanent (VINs don't change)
  - Shodan: 1 hour
- Cache key: `{module}:{target}`
- HTTP calls use `AbortSignal.timeout(10_000)` (10s).
- User-Agent: `EndpointX-OSINT/1.3.0`

### Error Handling

- External API failure → return partial result with `sources` indicating which succeeded/failed. Never fail the entire lookup if at least one source returns data.
- All API keys optional → modules requiring keys return `null` with a `requiresKey: true` flag when key not configured.
- Rate limit exceeded (429) → retry once after 1s, then return error for that source.
- Invalid target format → 400 with descriptive message (e.g. "Invalid IP address", "Invalid email format", "VIN must be 17 characters").

### Security Considerations

- API keys never logged; masked in API responses.
- SQL injection prevented via parameterized queries (existing `query()` helper).
- No SSRF risk — target is validated as IP/domain/email/phone/VIN format before any HTTP call; no arbitrary URL fetching.
- Rate limiting via Express rate limiter (already mounted) + module-level concurrency caps.
- RBAC enforced on every endpoint.
- Audit trail: every lookup recorded in `osint_lookups` with `created_by`.
- Multi-tenant: lookups filtered by `created_by` via `visibleDevicesSql` pattern.

## Implementation Priority

| Phase | Components | Effort |
|---|---|---|
| 1 | Schema, permissions, settings seeding, route skeleton, barrel | Small |
| 2 | ipLookup, dnsLookup, whoisLookup (core, no API keys) | Medium |
| 3 | subdomainEnum, emailOsint (MX/disposable), portScan | Medium |
| 4 | vinLookup, phoneOsint (libphonenumber), shodanLookup (optional key) | Medium |
| 5 | Routes with full CRUD + enrich endpoint | Medium |
| 6 | Frontend: OsintPage with all sections, settings modal, history | Large |
| 7 | i18n, nav, routing, tests | Small |

## Verification Criteria

- `npm run typecheck` — 0 errors
- `npm run test` — all existing + new OSINT tests pass
- `npm run build` (dashboard) — builds without errors
- Manual: Query public IP → returns geolocation, ASN, DNS, WHOIS
- Manual: Query domain → returns DNS records, subdomains, WHOIS
- Manual: Query email → returns MX provider, disposable check
- Manual: Query VIN → returns vehicle make/model/year
- Manual: Enrich device → device metadata updated with OSINT data
- Manual: History persists across page reloads
- Manual: Settings modal saves/clears API keys; keys masked on reload

# OSINT Subsystem Implementation Plan

## Overview
Implement the OSINT subsystem as a purely additive module: new backend files, new route file, new frontend page, schema additions, permission seeds. Zero changes to existing route logic.

## Tasks

### Phase 1 — Schema, Permissions, Settings
- **1.1** Append `osint_lookups` + `osint_settings` tables and indexes to the schema string in `backend-api/src/config/database.ts` (end of `createInlineSchema`, before closing backtick).
- **1.2** Add `['osint.view', 'View OSINT', 'View OSINT lookups and history', 'osint']` and `['osint.manage', 'Manage OSINT', 'Perform OSINT queries and manage API keys', 'osint']` tuples to `allPerms` array.
- **1.3** No role grants needed beyond admin auto-grant (admin gets every perm).

### Phase 2 — OSINT Service Modules
- **2.1** Create `backend-api/src/osint/types.ts` — shared interfaces (`LookupType`, `OsintLookupResult`, module result shapes).
- **2.2** Create `backend-api/src/osint/cache.ts` — in-memory TTL LRU cache with `get/set/has/invalidate`.
- **2.3** Create `backend-api/src/osint/ipLookup.ts` — `lookupIp(ip)` calls ip-api.com, returns geolocation/ASN/ISP/reverse.
- **2.4** Create `backend-api/src/osint/dnsLookup.ts` — `lookupDns(domain)` calls dns.google DoH for A/AAAA/MX/TXT/NS/SOA/CNAME/PTR.
- **2.5** Create `backend-api/src/osint/whoisLookup.ts` — `lookupWhois(domainOrIp)` calls rdap.org bootstrap, parses registration data.
- **2.6** Create `backend-api/src/osint/subdomainEnum.ts` — `enumerateSubdomains(domain)` queries crt.sh CT logs + HackerTarget.
- **2.7** Create `backend-api/src/osint/emailOsint.ts` — `lookupEmail(email)` does MX DNS lookup + disposable domain check; optional HIBP breach check if key configured.
- **2.8** Create `backend-api/src/osint/phoneOsint.ts` — `lookupPhone(phone)` uses bundled `libphonenumber` for local parse + optional NumVerify carrier lookup.
- **2.9** Create `backend-api/src/osint/vinLookup.ts` — `lookupVin(vin)` calls NHTSA vPIC API.
- **2.10** Create `backend-api/src/osint/shodanLookup.ts` — `lookupShodan(ip)` calls Shodan API if key configured.
- **2.11** Create `backend-api/src/osint/portScan.ts` — `scanPorts(host, ports?)` does TCP connect scan with concurrency limit + banner grab (reuse HERMES pattern).
- **2.12** Create `backend-api/src/osint/index.ts` — barrel export of all lookup functions.

### Phase 3 — Routes
- **3.1** Create `backend-api/src/routes/osint.ts` with header pattern from `netsentinel.ts` (authenticate, audit helper, newId helper).
- **3.2** Implement `POST /lookup` — validates type/target, dispatches to module, saves to `osint_lookups`, returns result.
- **3.3** Implement `GET /lookups` — paginated history with type/search filters, scoped to `created_by`.
- **3.4** Implement `GET /lookups/:id` — single lookup detail.
- **3.5** Implement `DELETE /lookups/:id` — remove lookup.
- **3.6** Implement `POST /devices/:deviceId/enrich` — get device IP, run IP lookup, save with device_id link.
- **3.7** Implement `GET /settings` — return masked API key status.
- **3.8** Implement `PUT /settings` — update API keys in `osint_settings`.
- **3.9** Implement `GET /health` — ping each external API, report availability + latency.
- **3.10** Mount in `backend-api/src/index.ts`: `import osintRoutes from './routes/osint'; app.use('/api/osint', osintRoutes);`

### Phase 4 — Frontend
- **4.1** Add PT + EN i18n keys `nav.osint` and `osint.*` to `admin-dashboard/src/i18n/index.tsx`.
- **4.2** Add nav entry "OSINT" under new group "Intelligence" in `admin-dashboard/src/components/Layout.tsx` + `routeTitleKeys`.
- **4.3** Add route in `admin-dashboard/src/App.tsx`: `/osint` wrapped in `PermissionGate permission="osint.view"`.
- **4.4** Create `admin-dashboard/src/pages/OsintPage.tsx` — query bar, results sections, history panel, settings modal.
- **4.5** Add any needed API helper methods (or use `api.request` directly).

### Phase 5 — Tests
- **5.1** Create `backend-api/tests/osint.test.ts` — test validation logic, cache, route permission enforcement, DB insert.
- **5.2** Add `"test:osint": "npx tsx tests/osint.test.ts"` to package.json scripts and append to chain in `"test"`.

### Phase 6 — Build & Verify
- **6.1** `npm run typecheck` in backend-api — 0 errors.
- **6.2** `npm run test` in backend-api — all pass.
- **6.3** `npm run build` in admin-dashboard — no errors.
- **6.4** Manual smoke: start dev server, query IP 8.8.8.8, verify geolocation + DNS returned.

## File Inventory (New)
```
backend-api/src/osint/types.ts
backend-api/src/osint/cache.ts
backend-api/src/osint/ipLookup.ts
backend-api/src/osint/dnsLookup.ts
backend-api/src/osint/whoisLookup.ts
backend-api/src/osint/subdomainEnum.ts
backend-api/src/osint/emailOsint.ts
backend-api/src/osint/phoneOsint.ts
backend-api/src/osint/vinLookup.ts
backend-api/src/osint/shodanLookup.ts
backend-api/src/osint/portScan.ts
backend-api/src/osint/index.ts
backend-api/src/routes/osint.ts
backend-api/tests/osint.test.ts
admin-dashboard/src/pages/OsintPage.tsx
```

## Files Modified (Minimal, Additive)
```
backend-api/src/config/database.ts      — append schema block + allPerms tuples
backend-api/src/index.ts                — add import + mount
backend-api/package.json                — add test:osint script
admin-dashboard/src/App.tsx             — add route
admin-dashboard/src/components/Layout.tsx — add nav item + group
admin-dashboard/src/i18n/index.tsx      — add pt/en keys
```

## Verification
- typecheck = 0, test suite pass, dashboard build pass
- New page renders, query works, history persists, settings save
- Existing pages unaffected (no diff in their code paths)

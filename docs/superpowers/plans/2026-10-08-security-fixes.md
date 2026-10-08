# EndpointX Security Fixes (v1.2.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the critical/high security findings from the 2026-10-08 audit of EndpointX, in the priority order the user approved.

**Architecture:** Backend (Express/TS) hardening: gate agent-credential endpoints behind enrolment tokens + RBAC, authenticate the Socket.IO plane, redact credential-bearing email logs, verify agent secrets on heartbeat, reject MFA temp tokens, remove hardcoded crypto-key fallbacks, plus infra hygiene (.dockerignore, test script, CI, CSP). All tests are standalone `tsx` scripts in `backend-api/tests/` following the existing `cors.test.ts` pattern (assert + exit code, no DB required).

**Tech Stack:** TypeScript, Express 4, socket.io 4, jsonwebtoken 9, node:assert, tsx.

**Spec:** The 2026-10-08 audit findings (delivered in conversation) â€” no separate spec file. The audit's severity-ranked fix list is the binding requirement.

## Global Constraints

- No database available in this environment: tests must exercise middleware/handlers up to the point of a DB call (handlers fall back or fail closed) and never require a live PostgreSQL.
- Test command per file: `npx tsx tests/<file>.ts` (exit 0 = pass). Project gate after each task: `npm run typecheck` (backend-api).
- Env for tests: set `process.env.JWT_SECRET` / `JWT_REFRESH_SECRET` / `AGENT_SECRET` **before** first import of app modules (dynamic `await import()` after env setup). Secrets must be â‰¥48 chars and free of the weak-substring list in `config/constants.ts:111-116`.
- No git commits (global rule: commit only when the user explicitly asks). Record evidence in the ledger instead.
- Do not change public API response shapes except where a finding requires it (install scripts 403, heartbeat 401, socket connect_error).
- Dashboard (admin-dashboard) changes: `npx tsc --noEmit` must pass after any `.tsx/.ts` edit.

## Review Focus

- Enrolment-token gating must not lock out the dashboard's own Install page flow (it mints `?t=` via `GET /devices/enroll-token`) â€” but must lock out anonymous and free-role callers.
- Socket.IO auth must not break the dashboard's existing `SocketContext` (it already sends `auth: { token }`) or the events the SPA listens to.
- Redaction must strip reset links (`?token=`) and invite temp passwords without corrupting ordinary alert email bodies.
- Heartbeat secret check must match what the Python agent actually sends (`X-Agent-Secret` header â€” `agent.py:505`) so live agents keep working.
- CSP must not break the static site (inline scripts/theme toggles, Google Fonts) or the SPA (fonts, map tiles, API/websocket connections).

---

### Task 1: Fix corrupted `src/index.ts:156` (server cannot start)

**Files:**
- Modify: `backend-api/src/index.ts:156`

**Interfaces:**
- Consumes: none.
- Produces: working `apiLimiter` + heartbeat limiter mounts (load-bearing for Tasks 2/5 rate limits).

- [x] **Step 1 (RED):** Run `npx tsc --noEmit` in `backend-api/`.
  Expected: fails with `src/index.ts(156,29): error TS1127: Invalid character` (literal `\n` bytes outside a string).
- [x] **Step 2 (fix):** Replace line 156 with two real lines and drop the commented `/api/health` handler (canonical health route is `GET /health` at `index.ts:167`, which is what `render.yaml:64 healthCheckPath` uses):

```ts
app.use('/api', apiLimiter);
app.use('/api/devices/heartbeat', heartbeatLimiter, heartbeatIpLimiter);
```

- [x] **Step 3 (GREEN):** `npx tsc --noEmit` â†’ exit 0, no errors.

---

### Task 2: Gate AGENT_SECRET behind enrolment + RBAC

**Files:**
- Modify: `backend-api/src/routes/devices.ts` (install routes ~1609-1688, `/enroll-token` ~541, `/download/installer` ~1469)
- Test: `backend-api/tests/installAccess.test.ts`

**Interfaces:**
- Produces: `function enrollOwnerFromRequest(req): string | null` in `devices.ts` â€” resolves a valid enrolment JWT from `?t=` query, `x-enroll-token` header, or `enroll_token`/`t` body field; returns `sub` or null (extends existing `verifyEnrollToken(raw)` at devices.ts:39-49). Task 5 consumes this.
- Produces: express middleware `requireEnrollToken(req, res, next)` â†’ 403 `{ success:false, error:{ message:'Valid enrolment token required' } }` when no owner resolves.

- [x] **Step 1 (RED):** Write `tests/installAccess.test.ts` that (a) sets env secrets, (b) dynamic-imports `../src/routes/devices`, mounts it on a bare express app with `express.json()`, and asserts:
  1. `GET /public/install.ps1` without `t` â†’ **403** (today: 200 + real secret â‡’ RED)
  2. `GET /public/install.ps1?t=<valid enroll JWT>` (sign `{sub, typ:'enroll'}` with `JWT.ACCESS_SECRET`, iss/aud from constants) â†’ **200**, body contains the env `AGENT_SECRET` value
  3. `GET /public/install.ps1?t=garbage` â†’ **403**
  4. same 403/200 pair for `/public/install-linux.sh`
  5. `GET /devices/enroll-token` with Bearer token carrying `permissions:['devices.view']` â†’ **403** (after elevation to `devices.manage`)
  6. `GET /devices/download/installer` with Bearer `permissions:['devices.view']` â†’ **403**
  Run: `npx tsx tests/installAccess.test.ts` â†’ expect FAIL (1/3/5/6 return non-403; DB-less env: `authenticate` falls back to token permissions).
- [x] **Step 2 (GREEN):** In `devices.ts`:
  - add `enrollOwnerFromRequest(req)` (query `t`, header `x-enroll-token`, body `enroll_token`) and `requireEnrollToken` middleware (403 on null);
  - mount `requireEnrollToken` on the three `/public/install*.ps1|sh` routes (keep serving `##ENROLL_TOKEN##` from the resolved owner);
  - change `/enroll-token` chain to `authenticate, requirePermission('devices.manage')`;
  - change `/download/installer` chain to `authenticate, requirePermission('devices.manage')`.
  Run test â†’ PASS (6/6), `npm run typecheck` â†’ clean.
- [x] **Step 3:** Ledger note: InstallPage links still work for admin/supervisor (they hold `devices.view`â€¦ verify: they hold `devices.manage`); free `user` role now gets 403 â€” intended fail-closed.

---

### Task 3: Authenticate Socket.IO + scope rooms + stop leaking setting values

**Files:**
- Modify: `backend-api/src/websocket/index.ts` (add middleware + room policy), `backend-api/src/index.ts:269-274` (wire them), `backend-api/src/routes/settings.ts:37`
- Test: `backend-api/tests/socketAuth.test.ts`

**Interfaces:**
- Consumes: `verifyAccessToken(token)` from `src/middleware/auth.ts:203` (Task 6 later hardens it against `mfa_temp` â€” no conflict, strictly additive).
- Produces: `export async function socketAuthMiddleware(socket, next)` â€” reads `socket.handshake.auth?.token`, calls `verifyAccessToken`; `next(new Error('unauthorized'))` on null; else sets `socket.data.user = user; next()`.
- Produces: `export function canJoinRoom(user: {permissions: string[], role_name: string, id: string}, room: string): boolean` â€” allows `user:<own id>`; `role:<own role_name>`; `device:<id>` only when `user.permissions` includes `devices.view`; everything else false.

- [x] **Step 1 (RED):** Write `tests/socketAuth.test.ts`:
  1. Unit: `canJoinRoom` cases (import error today â‡’ FAIL): own user room true; other user room false; own role room true; `device:x` with/without `devices.view`; `role:admin` for non-admin false; arbitrary room false.
  2. Integration: start `http.createServer()` + `new SocketIOServer(server)` with `io.use(socketAuthMiddleware)` + connection handler mirroring index.ts; connect with Node's global `WebSocket` to `/socket.io/?EIO=4&transport=websocket`, send `40{"auth":{}}` â†’ expect connect_error/close **without** receiving a connect reply carrying `"sid"`; then with `40{"auth":{"token":<valid JWT>}}` â†’ expect connect reply with `"sid"`, then `42["join_room","user:<id>"]` accepted (room join does not error).
  Run â†’ FAIL (no middleware exported / connection accepted without token).
- [x] **Step 2 (GREEN):** Implement `socketAuthMiddleware` + `canJoinRoom` in `websocket/index.ts`; in `index.ts`: `io.use(socketAuthMiddleware)`; connection handler gates `join_room` with `canJoinRoom(socket.data.user, room)` (ignore+log on false); in `settings.ts:37` broadcast `{ key }` only (drop `value` â€” repo grep shows no consumer of `settings:changed`).
  Run test â†’ PASS; `npm run typecheck` â†’ clean.
- [x] **Step 3:** Confirm dashboard `SocketContext.tsx` already sends `auth: { token }` (audit: yes, line 71-79) â€” no frontend change needed.

---

### Task 4: Redact credential emails + revoke `logs.view` from free role

**Files:**
- Modify: `backend-api/src/services/emailService.ts` (`logMail` ~71-86), `backend-api/src/config/database.ts` (rolePerms ~1267-1284 + idempotent cleanup after seed loop)
- Test: `backend-api/tests/emailRedaction.test.ts`

**Interfaces:**
- Produces: `export function redactEmailBody(body: string): string` in `emailService.ts`.
- Produces: `export const SEED_ROLE_PERMISSIONS: Record<string, string[]>` in `database.ts` (extract of the current inline `rolePerms` object â€” seed loop reads it unchanged).

- [x] **Step 1 (RED):** Write `tests/emailRedaction.test.ts` asserting:
  1. reset link: `href="https://x/reset-password?token=SECRET123"` â†’ `?token=[REDACTED]`, `SECRET123` absent;
  2. invite: `<strong>Temporary Password:</strong> Ab3!xyz </p>` â†’ inner value gone, tag structure intact;
  3. ordinary alert body (no token/password) â†’ byte-identical passthrough;
  4. `SEED_ROLE_PERMISSIONS.user` does **not** contain `'logs.view'` (today it does â‡’ FAIL).
  Run â†’ FAIL (import of `redactEmailBody` missing / user role includes logs.view).
- [x] **Step 2 (GREEN):**
  - Implement `redactEmailBody`: replace `([?&]token=)[^"&\s]+` â†’ `$1[REDACTED]` (case-insensitive) and `(<strong>Temporary Password:</strong>)[\s\S]*?(</p>)` â†’ `$1 [REDACTED]$2`; call it in `logMail` before the INSERT (both sent and failed paths);
  - extract `SEED_ROLE_PERMISSIONS` export, drop `'logs.view'` from `user`;
  - add idempotent statement at the end of the same seed function (runs each startup):
    `DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE name = 'user') AND permission_id = (SELECT id FROM permissions WHERE code = 'logs.view')`
  Run test â†’ PASS; `npm run typecheck` â†’ clean.
- [x] **Step 3:** Ledger: existing `notification_log` rows keep old bodies â€” note for operator (rotate reset tokens is moot: 1h expiry; invite passwords: operators should re-invite or users change password). Recorded as deferred data-migration note.

---

### Task 5: Require agent secret on heartbeat + enrolment on mobile register

**Files:**
- Modify: `backend-api/src/routes/devices.ts` (`/heartbeat` ~368, `/mobile/register` ~1894)
- Test: `backend-api/tests/agentAuth.test.ts`

**Interfaces:**
- Consumes: `enrollOwnerFromRequest` from Task 2 (same file).
- Produces: heartbeat 401 body `{ success:false, error:{ message:'Invalid agent secret' } }` â€” identical shape to `/register` (devices.ts:188-192).

- [x] **Step 1 (RED):** Write `tests/agentAuth.test.ts` mounting the devices router with `AGENT_SECRET` set in env:
  1. `POST /devices/heartbeat` `{agent_id:'x'}` **no header** â†’ expect **401** (today: proceeds to DB â‡’ 500 â‡’ FAIL);
  2. `POST /devices/heartbeat` with wrong `x-agent-secret` â†’ **401**;
  3. `POST /devices/heartbeat` with correct `x-agent-secret` â†’ status **not** 401 (will be 500/404 without DB â€” acceptable: proves auth gate passed);
  4. `POST /devices/mobile/register` `{device_name:'d'}` **no enrolment** â†’ expect **401** (today: proceeds to DB â‡’ FAIL);
  5. `POST /devices/mobile/register` with valid `enroll_token` â†’ status **not** 401.
  Run â†’ FAIL.
- [x] **Step 2 (GREEN):** Add to `/heartbeat` (immediately after the `agent_id` presence check) the same header comparison as `/register`; add `requireEnrollToken` (Task 2) to `/mobile/register` **or** an inline check via `enrollOwnerFromRequest` returning 401 (mobile page sends `enroll_token` from `?t=` â€” install-mobile.html:345-346). Keep `remote_token` in the response only after enrolment passes (attacker now needs a valid token minted by a `devices.manage` userâ€¦ note: `/mobile/register` enrolment comes from install links, which Task 2 restricted to `devices.manage` holders).
  Run test â†’ PASS; `npm run typecheck` â†’ clean.
- [x] **Step 3:** Ledger ruling (deferred): `/devices/mobile/heartbeat` stays unauthenticated â€” hardening it needs a signed per-device token issued at register and mirrored in `install-mobile.html` + `sw.js` (out of approved scope).

---

### Task 6: Reject MFA temp tokens + remove hardcoded crypto-key fallbacks

**Files:**
- Modify: `backend-api/src/middleware/auth.ts` (`authenticate` ~93-108, `verifyAccessToken` ~203-222), `backend-api/src/routes/mfa.ts:15`, `backend-api/src/routes/sso.ts:13`, `backend-api/src/utils/helpers.ts` (add helper)
- Test: `backend-api/tests/authGuard.test.ts`, `backend-api/tests/mfaKeyGuard.test.ts`

**Interfaces:**
- Produces: `export function getRequiredEncryptionKey(envName: string, ...fallbackEnvNames: string[]): string` in `helpers.ts` â€” first non-empty env var wins; throws `Error('<name> must be set to a 32-character key')` when none present or value length â‰  32.
- Produces: in `auth.ts`, private assertion `isSessionPayload(decoded): boolean` â†’ `typeof decoded.role_id === 'string' && decoded.role_id !== '' && decoded.type !== 'mfa_temp'`. Applied in `authenticate` (401 `AUTH_TOKEN_INVALID` when false) and `verifyAccessToken` (returns null).

- [x] **Step 1 (RED):** `tests/authGuard.test.ts` â€” call `authenticate` directly with mock req/res/next:
  1. `mfa_temp` token (sign `{id, type:'mfa_temp'}` via `generateToken` â€” has iss/aud) â†’ expect **401** (today: `next()` called with `req.user` set â‡’ FAIL);
  2. token without `role_id` â†’ **401**;
  3. valid session token `{id, email, role_id, role_name, permissions:['x']}` â†’ `next()` called, `req.user` set (guards against over-blocking; DB perms load fails offline â‡’ falls back to token perms);
  4. `verifyAccessToken(mfa_temp)` â†’ `null` (today: returns user â‡’ FAIL).
  `tests/mfaKeyGuard.test.ts` â€” `getRequiredEncryptionKey` missing env â†’ throws; wrong length â†’ throws; 32 chars â†’ returns (import fails today â‡’ FAIL). Also assert `mfa.ts`/`sso.ts` no longer contain the literal `'endpointx-mfa-key-change'`/`'endpointx-sso-key'` (read files, expect absence â€” pins the wiring).
  Run both â†’ FAIL.
- [x] **Step 2 (GREEN):** Implement helper + assertions; replace `MFA_KEY`/`SSO_ENCRYPTION_KEY` fallbacks (`mfa.ts:15` â†’ `getRequiredEncryptionKey('MFA_ENCRYPTION_KEY')`; `sso.ts:13` â†’ `getRequiredEncryptionKey('SSO_ENCRYPTION_KEY', 'MFA_ENCRYPTION_KEY')`).
  Run both tests â†’ PASS; `npm run typecheck` â†’ clean.
- [x] **Step 3:** Ledger ruling: `/api/mfa` + `/api/sso` stay unmounted (`routes/index.ts` never imported) â€” enabling MFA end-to-end is a product task (decode bug at `authController.ts:577` + mount + TOTP flow testing); this task only closes the bypass and the shared-key holes. Cost if wrong: MFA remains unavailable (status quo, no regression).

---

### Task 7: Infra hygiene â€” .dockerignore, test script, CI, CSP

**Files:**
- Create: `.dockerignore` (repo root â€” Dockerfiles use repo-root context), `.github/workflows/ci.yml`, `backend-api/src/config/securityHeaders.ts`, `backend-api/tests/securityHeaders.test.ts`
- Modify: `backend-api/package.json` (`scripts.test`), `backend-api/src/index.ts:65` (use helmet with options), `admin-dashboard/nginx.conf` (CSP header at server level)

**Interfaces:**
- Produces: `export const helmetOptions` + `export const securityHeadersMiddleware` from `securityHeaders.ts` (index.ts:65 switches to `app.use(securityHeadersMiddleware)`).

- [x] **Step 1 (RED):** `tests/securityHeaders.test.ts`: mount express with `securityHeadersMiddleware`, `GET /` â†’ assert header `Content-Security-Policy` exists and contains `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `script-src 'self'`, and `style-src` allows `https://fonts.googleapis.com` + `'unsafe-inline'` (static site uses inline scripts/styles). Import fails today â‡’ FAIL.
- [x] **Step 2 (GREEN):**
  - `securityHeaders.ts`: `helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } }, crossOriginEmbedderPolicy: false })` (keep other helmet defaults);
  - `index.ts:65` â†’ `app.use(securityHeadersMiddleware)`;
  - `.dockerignore`: `.env`, `**/.env`, `node_modules`, `**/node_modules`, `.git`, `.superpowers`, `*.log`, `docs`, `*.md`;
  - `backend-api/package.json`: `"test": "tsx tests/cors.test.ts && tsx tests/webhookUrl.test.ts && tsx tests/installAccess.test.ts && tsx tests/socketAuth.test.ts && tsx tests/emailRedaction.test.ts && tsx tests/agentAuth.test.ts && tsx tests/authGuard.test.ts && tsx tests/mfaKeyGuard.test.ts && tsx tests/securityHeaders.test.ts && tsx src/hermes/forensics.test.ts && tsx src/hermes/hermes.test.ts"` (drop the hermes pair if either is not self-contained â€” check first);
  - `.github/workflows/ci.yml`: on push/PR â†’ setup-node@v4 (node 20, cache npm, cache-dependency-path backend-api/package-lock.json), `npm ci`, `npm run typecheck`, `npm test` (workdir backend-api);
  - `admin-dashboard/nginx.conf`: add at server level (before any `location`):
    `add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://endpointx.onrender.com wss://endpointx.onrender.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'" always;`
    (SPA needs `connect-src` to the API origin for REST + `/socket.io` + `/remote` wss; map tiles covered by `img-src https:`. The existing `location` block for static assets has its own `add_header`, which drops inherited headers for assets â€” acceptable: CSP matters on the document, which is served by `location /`.)
  Run `npx tsc --noEmit` + test â†’ PASS; `npm test` (full gate) â†’ all green.
- [x] **Step 3:** Ledger: nginx change is config-only (no local nginx runtime) â€” verified by inspection; Docker build not run locally.

---

---

### Task 8: Agent install docs â†’ v1.2.0 enrolment flow + ship `endpoint-agent/` in the image

**Files:**
- Modify: `backend-api/Dockerfile` (add `COPY endpoint-agent/ ./endpoint-agent/`), `README.md:140-192`, `docs/INSTALL-GUIDE.md` (install commands), `SECURITY.md` supported-versions table
- Test: covered by Task 2's `installAccess.test.ts` (routes serve real files once Dockerfile ships them â€” verified by path existence, not by a Docker build)

**Interfaces:**
- Consumes: Task 2's `?t=` requirement on public install routes.

- [x] **Step 1:** Confirmed defect: `devices.ts:1644/1671` resolve `src/routes/../../endpoint-agent/*.sh` â†’ `/app/endpoint-agent/` but `backend-api/Dockerfile` never copies `endpoint-agent/` (only `backend-api/` + `database/`) â†’ linux/macos one-liners 404 in production. Add `COPY endpoint-agent/ ./endpoint-agent/` to the Dockerfile (repo-root build context, same as `COPY backend-api/ ./`).
- [x] **Step 2:** Update install commands in README + INSTALL-GUIDE to the v1.2.0 enrolment format, with a placeholder token (never a real one â€” the repo is public and enrolment JWTs are single-account credentials):

```powershell
irm https://endpointx.onrender.com/api/devices/public/install.ps1?t=<ENROLL_TOKEN> | iex
```

  plus the linux/macos equivalents, with a note: the dashboard **Install** page builds the complete command including your token (`GET /api/devices/enroll-token`); tokens are valid 30 days and are account-scoped. Replace `your-server.com` placeholders with `endpointx.onrender.com`.
- [x] **Step 3:** `SECURITY.md` supported versions: `1.1.x` â†’ `1.2.x`. Gate: `npx tsc --noEmit` unaffected; docs reviewed by grep for stale token-less commands (expect none outside historical plan docs).

---

### Task 9: Fix `/api/network/stats` 500 (placeholder `$2` with one param)

**Files:**
- Modify: `backend-api/src/routes/network.ts:29`
- Test: `backend-api/tests/networkStats.test.ts`

**Interfaces:**
- Consumes: none. Produces: stats queries whose `$N` placeholders all fit the supplied params array.

- [x] **Step 1 (RED):** Write `tests/networkStats.test.ts`: patch `config/database.query` (CJS property patch â€” capture every `{sql, params}` call, return canned rows: `{rows:[{code:'network.view'},{code:'devices.view'}]}` for the permissions lookup, `{rows:[]}` otherwise) **before** dynamically importing `../src/routes/network`; mount router; `GET /stats` with a valid session JWT (permissions `network.view`); assert **200** AND for every captured call `max($N referenced) <= params.length` (calls with no `$` must have `params.length === 0`â€¦ except legacy `[id]`-with-no-placeholder must also be caught â€” the failing rule: any supplied param that no `$N` references, or any `$N` beyond params length, fails). Expected RED: the line-29 query references `$2` with 1 param.
- [x] **Step 2 (GREEN):** Change `network.ts:29` offset from `2` to `1` (matches sibling queries at :19, :20, :40). Run test â†’ PASS; `npm run typecheck` â†’ clean.

---

## Final gate

- `npm test` (all test files: cors, webhookUrl, installAccess, socketAuth, emailRedaction, agentAuth, authGuard, mfaKeyGuard, securityHeaders, networkStats + hermes pair if self-contained) green; `npm run typecheck` clean; `admin-dashboard` `npx tsc --noEmit` clean.

# Fase C — Segurança Críticos 1-4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os quatro itens críticos da auditoria de segurança: logout que não revoga, `is_active` não verificado, `X-Agent-Secret` comparado sem timing-safety, e `/devices/mobile/heartbeat` público.

**Architecture:** Access tokens passam a carregar a claim `sid` (id da linha de `user_sessions`); `authenticate`/`verifyAccessToken` consultam sessão+utilizador por pedido (fail closed); logout apaga a linha `sid`; refresh actualiza a linha em manter `sid` estável. Comparação de segredos via `safeCompare` (SHA-256 + `timingSafeEqual`). Heartbeat mobile exige header `x-heartbeat-token` = o `remote_token` (HMAC por-dispositivo) que o registo mobile já devolve — ver emenda no spec §3.1.

**Tech Stack:** Express 4, jsonwebtoken 9 (HS256), `pg`, testes `tsx` com harness próprio (FakePool via `require.cache` ou BD real `initDatabase`), sem framework de testes.

**Spec:** `docs/superpowers/specs/2026-10-15-fase-c-security-criticos-design.md` (inclui emenda §3.1 — reutiliza `remote_token`)

**Branch:** criar `feat/fase-c-security-criticos` a partir de `main` antes do Task 1; tudo commitado nela.

## Global Constraints

- Nunca fabricar dados ou afirmar testes não executados; cada task: RED → GREEN → `npm test` completo → `npm run typecheck` → commit.
- A lista `test` de `backend-api/package.json` é explícita por ficheiro — todo o script de teste novo tem de ser acrescentado nessa task.
- Passwords de teste têm de passar o `RegisterSchema` (min 12, maiúscula, minúscula, número, especial) — usar `FaseC!Test2026`.
- `authLimiter` = 20 pedidos/15min/IP em `/login` e `/register` — o ficheiro `authSession.test.ts` tem de se manter abaixo disso.
- MFA route `/api/mfa` e SSO `/api/sso` permanecem desmontados — não tocar (`routes/mfa.ts:322`, `routes/sso.ts:473` emitem tokens sem `sid`; só entram em vigor se forem montados no futuro).
- `optionalAuth` fica inalterado (fora do spec).
- Mensagens de erro de sessão: 401 `Session revoked or inactive`, code `AUTH_SESSION_INVALID` — nunca distinguir "não existe" de "desactivada".
- Kotlin (`EndpointApi.kt`) não é compilável neste ambiente — mudança sintáctica, reportar como não testada.

## Review Focus

Condições que o spec implica mas que nenhum teste "feliz" apanha — cada linha tem teste na task dona:

1. **DB em erro durante a verificação de sessão** → falha fechada (500, `next()` não chamado) — Task 3: `session lookup DB error fails closed (500, next not called)`.
2. **Replay do refresh token antigo após rotação** → 401 — Task 2: `old refresh token rejected after rotation` (BD real: hash foi actualizado na mesma linha).
3. **Over-blocking**: token de sessão activa e válida tem de passar; `mfa_temp`/sem `role_id` continuam rejeitados — Task 3: testes existentes de `authGuard.test.ts` mantidos verdes + Task 3 `valid session token passes with sid claim`.
4. **Gate do heartbeat antes da lookup do device**: token errado num device INSCRITO → 401 (não 404/200) — Task 5: `wrong heartbeat token on enrolled device -> 401`.
5. **Tokens antigos sem `sid` (pré-deploy)** → 401 — Task 3: `token without sid -> 401`.

---

### Task 1: `safeCompare` + substituição das 9 comparações

**Files:**
- Create: `backend-api/src/utils/helpers.ts` (função nova, adicionar ao fim do bloco de crypto)
- Create: `backend-api/tests/safeCompare.test.ts`
- Modify: `backend-api/src/routes/devices.ts` (8 pontos: linhas 331-332, 546-547, 686, 1291-1292, 1377-1378, 1445-1446, 1552-1553, 1606-1607)
- Modify: `backend-api/src/remote/index.ts:100-103`
- Modify: `backend-api/package.json` (lista `test`)

**Interfaces:**
- Produces: `safeCompare(a: unknown, b: unknown): boolean` em `src/utils/helpers.ts` — verdadeiro só se ambos strings e iguais; falso para `undefined`, `string[]`, comprimentos diferentes.
- Consome: `requireAgentSecret()` (`src/config/constants.ts:144-152`, já importado em `devices.ts:10`), `remoteSecretFor(agentId)` (`src/remote/index.ts:94-98`).

- [ ] **Step 1: Criar branch** — `git checkout -b feat/fase-c-security-criticos main`
- [ ] **Step 2: Escrever teste falhador** — `tests/safeCompare.test.ts` (padrão `check`/`checkAsync` dos testes existentes, sem framework):

```ts
import './testEnv';
import assert from 'assert';
import { safeCompare } from '../src/utils/helpers';
// 6 checks:
safeCompare('abc', 'abc') === true
safeCompare('abc', 'abd') === false
safeCompare('abc', 'abcd') === false          // comprimentos diferentes
safeCompare(undefined, 'x') === false          // header ausente
safeCompare(['x'], 'x') === false              // header repetido (string[])
safeCompare(process.env.AGENT_SECRET, process.env.AGENT_SECRET) === true
// terminar com console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`) e process.exitCode
```

Acrescentar `tsx tests/safeCompare.test.ts` à lista `test` do `backend-api/package.json`.

- [ ] **Step 3: Correr para verificar falha** — `npx tsx tests/safeCompare.test.ts` → FAIL (`safeCompare is not a function` / import error).
- [ ] **Step 4: Implementar `safeCompare` em `src/utils/helpers.ts`**

```ts
export const safeCompare = (a: unknown, b: unknown): boolean => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
};
```

(`crypto` já importado em `helpers.ts:3`.)

- [ ] **Step 5: Correr para verificar passagem** — `npx tsx tests/safeCompare.test.ts` → `ALL PASS`.
- [ ] **Step 6: Substituir as 8 comparações em `devices.ts`** — cada `req.headers['x-agent-secret'] !== process.env.AGENT_SECRET` (ou forma equivalente) passa a `!safeCompare(<header>, requireAgentSecret())`; importar `safeCompare` de `'../utils/helpers'` (verificar se já há import de helpers e juntar). Não alterar mais nada nestas rotas.
- [ ] **Step 7: Substituir o handshake WS em `remote/index.ts:102`**

```ts
const allowed = safeCompare(secret, process.env.AGENT_SECRET) ||
                safeCompare(secret, remoteSecretFor(agentId));
```

(importar `safeCompare` de `'../utils/helpers'`; remover `expected` se ficar sem uso — se `!!expected` for necessário manter por clareza, `safeCompare` já trata `undefined` ⇒ falso, portanto `expected` sai.)

- [ ] **Step 8: Suite completa + typecheck** — `npm test` → ALL PASS; `npm run typecheck` → limpo. (Os testes `agentAuth.test.ts`/`installRequests.test.ts` do gate do agente ficam verdes — mesmo comportamento.)
- [ ] **Step 9: Commit** — `git add -A && git commit -m "fix(security): timing-safe agent secret comparison via safeCompare"`

---

### Task 2: Claim `sid` na emissão + refresh com `sid` estável

**Files:**
- Modify: `backend-api/src/controllers/authController.ts` — login (`:141-153`), register (`:238-251`), mfaVerify (`:627-639`), refreshToken (`:444-480`)
- Modify: `backend-api/src/middleware/auth.ts` — interface `JwtPayload` ganha `sid?: string` (só a interface nesta task)
- Create: `backend-api/tests/authSession.test.ts`
- Modify: `backend-api/package.json` (lista `test`)

**Interfaces:**
- Produces: access tokens novos com claim `sid: string` (UUID da linha `user_sessions`); sessão criada com `INSERT ... RETURNING id` **antes** de assinar; refresh faz `UPDATE user_sessions SET refresh_token_hash = $1, expires_at = $2 WHERE id = $3`.
- Consome: `generateToken(payload, secret, expiresIn)` (`helpers.ts:17-27`), `query` real (BD de teste local com schema inline — padrão de `networkDiscovery.test.ts`).

- [ ] **Step 1: Escrever o teste falhador** — `tests/authSession.test.ts` com BD **real** (sem FakePool; padrão de arranque de `networkDiscovery.test.ts`: `initDatabase()` no início do `main`):

```
estrutura: import './testEnv'; import assert; import jwt; import speakeasy;
  const { initDatabase, query } = require('../src/config/database');
  express app montando authRouter (src/routes/auth.ts) em /api/auth
  decode(token) = jwt.verify(token, JWT.ACCESS_SECRET, { issuer: 'endpointx', audience: 'endpointx-api' })
  email único por run: `fasec-${Date.now()}-${n}@t.pt`; password: FaseC!Test2026
checks (async, checkAsync):
  1. register issues sid claim:
     POST /auth/register → 201
     → decode(accessToken).sid match /^[0-9a-f]{8}-[0-9a-f-]{27}$/i (UUID)
     → const q = await query('SELECT id FROM user_sessions WHERE user_id = $1', [data.user.id])
       → q.rows[0].id === decode(accessToken).sid        // liga a claim à linha real
  2. login issues sid claim: POST /auth/login (mesmo email/password) → 200
     → decode(accessToken).sid é UUID
  3. mfa_verify issues sid claim (utilizador separado):
     → register user2 → INSERT INTO user_mfa (user_id, mfa_secret, enabled)
       VALUES ($1, Buffer.from(secret,'utf8').toString('hex'), true)   // secret = speakeasy.base32.generateSecret()
     → POST /auth/login → data.requiresMfa + data.tempToken
     → POST /auth/mfa-verify { tempToken, token: speakeasy.totp({ secret }) } → 200
     → decode(accessToken).sid é UUID
  4. refresh keeps sid stable:
     → login user1 → sid1; POST /auth/refresh { refreshToken } → 200
     → decode(novo accessToken).sid === sid1             // linha preservada (Task 2: UPDATE, não DELETE+INSERT)
  5. old refresh token rejected after rotation:
     → replay do refreshToken do passo 4 → 401
     (nota: o check 5 pode já passar com o código antigo — o RED do ficheiro vem dos checks 1-4)
```

- [ ] **Step 2: Correr para verificar falha** — `npx tsx tests/authSession.test.ts` → FAIL nos checks 1-3 (`sid` undefined) e 4 (sid muda — hoje a sessão é apagada e recriada com id novo). O check 5 pode já passar (rotação apaga a linha) — aceitável; o RED vem dos outros.
- [ ] **Step 3: Implementar emissão com `sid`**

Login (`authController.ts:141-153`) — reordenar: mover a criação da sessão **antes** do token e devolver id:

```ts
const sessionInsert = await query(
  'INSERT INTO user_sessions (user_id, refresh_token_hash, ip_address, user_agent, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
  [user.id, refreshTokenHash, req.ip, req.headers['user-agent'], expiresAt.toISOString()]
);
const accessToken = generateToken(
  { id: user.id, email: user.email, role_id: user.role_id, role_name: user.role_name,
    permissions, sid: sessionInsert.rows[0].id },
  JWT.ACCESS_SECRET, JWT.ACCESS_EXPIRES_IN
);
```

(mover `refreshTokenStr`/`refreshTokenHash`/`expiresAt` para cima; manter as queries seguintes intactas.) Aplicar o **mesmo padrão** em register (`:238-251`) e mfaVerify (`:627-639`).

- [ ] **Step 4: Refresh com `sid` estável (`:464-476`)** — substituir delete+insert por update na mesma linha:

```ts
const session = sessionResult.rows[0];
// ...permissions como hoje...
const newRefreshToken = generateRefreshToken();
const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 7);
await query('UPDATE user_sessions SET refresh_token_hash = $1, expires_at = $2 WHERE id = $3',
  [hashToken(newRefreshToken), expiresAt.toISOString(), session.id]);
const newAccessToken = generateToken(
  { id: session.user_id, email: session.email, role_id: session.role_id,
    role_name: session.role_name, permissions, sid: session.id },
  JWT.ACCESS_SECRET, JWT.ACCESS_EXPIRES_IN
);
```

Remover o `DELETE` (`:465`) e o `INSERT` (`:475-476`). A resposta mantém `{ accessToken, refreshToken }`.

- [ ] **Step 5: `JwtPayload.sid?: string`** — acrescentar o campo opcional à interface em `src/middleware/auth.ts:20-30` (só a interface; a verificação vem no Task 3).
- [ ] **Step 6: Correr para verificar passagem** — `npx tsx tests/authSession.test.ts` → ALL PASS.
- [ ] **Step 7: Suite + typecheck** — `npm test` → ALL PASS (authGuard mantém-se verde: `isSessionPayload` ainda não exige `sid`); `npm run typecheck` → limpo. Acrescentar `tsx tests/authSession.test.ts` à lista `test`.
- [ ] **Step 8: Commit** — `git commit -m "feat(auth): session-bound access tokens (sid claim) with stable refresh"`

---

### Task 3: `authenticate`/`verifyAccessToken` verificam sessão e conta activa

**Files:**
- Modify: `backend-api/src/middleware/auth.ts` (`isSessionPayload`, `authenticate`, `verifyAccessToken`, `AuthUser`)
- Modify: `backend-api/tests/authGuard.test.ts` (rework: FakePool + novos checks)
- Modify (collateral — tokens/harness para o gate, ver Step 5): `backend-api/tests/installAccess.test.ts`, `backend-api/tests/networkStats.test.ts`, `backend-api/tests/networkDiscovery.test.ts`, `backend-api/tests/socketAuth.test.ts`

**Interfaces:**
- Consumes: claim `sid` (Task 2), `query` de `src/config/database`.
- Produces: `AuthUser.sid?: string` preenchido; gate SQL exacto:

```sql
SELECT s.expires_at, u.is_active
  FROM user_sessions s
  JOIN users u ON u.id = s.user_id
 WHERE s.id = $1
```

(match de script FakePool: `JOIN users u ON u.id = s.user_id` — distingue do lookup do refresh em `authController.ts:453` que usa `s.user_id = u.id`.)

- Rejeição: 401 `{ code: 'AUTH_SESSION_INVALID', message: 'Session revoked or inactive' }` quando sem linha, `expires_at <= NOW()`, ou `!is_active`.
- `isSessionPayload` passa a exigir também `typeof payload.sid === 'string' && payload.sid !== ''`.
- Query que **lança** ⇒ cai no catch existente do `authenticate` ⇒ 500, `next()` não chamado. Em `verifyAccessToken` o catch devolve `null` (fail closed automático).

- [ ] **Step 1: Rework do teste** — `tests/authGuard.test.ts`: converter os imports de `../src/middleware/auth` para `require` **depois** de instalar FakePool (copiar o bloco FakePool de `installRequests.test.ts:37-101`, incluindo suporte a `{ match, rows?, error? }` — estender `respond` para devolver `throw` quando `s.error` existir). Mantêm-se os 4 checks actuais (1-4). Acrescentar:

```
5. token without sid -> 401: generateToken({id,email,role_id,role_name,permissions}) (sem sid)
   → nextCalls 0, status 401 (RED: hoje passa)
6. valid session token passes with sid claim: token com sid UUID;
   scripts = [gate: {expires_at: FUTURE, is_active: true}, perms: JOIN role_permissions → [{code:'x'}]]
   → next 1, req.user.permissions ['x'], req.user.sid === sid
7. revoked session -> 401: token com sid; scripts gate → rows []
   → 401, code AUTH_SESSION_INVALID
8. inactive account -> 401: gate → [{expires_at: FUTURE, is_active: false}] → 401
9. expired session -> 401: gate → [{expires_at: PAST, is_active: true}] → 401
10. session lookup DB error fails closed (500, next not called):
    scripts = [{match gate, error: new Error('db down')}]
    → status 500, nextCalls 0
11. verifyAccessToken returns null for revoked session: token com sid, gate → []
    → null
```

(Assert de existência do `code` no body: `res.body.error.code === 'AUTH_SESSION_INVALID'` — o `mockRes` já guarda `.json()`.)

- [ ] **Step 2: Correr para verificar falha** — `npx tsx tests/authGuard.test.ts` → checks 5-11 FAIL (hoje não há gate de sessão).
- [ ] **Step 3: Implementar o gate em `src/middleware/auth.ts`**

1. `isSessionPayload`: acrescentar `typeof payload.sid === 'string' && payload.sid !== ''` à condição (actualizar comentário).
2. Função privada:

```ts
async function assertSessionAlive(sid: string): Promise<boolean> {
  const r = await query(
    `SELECT s.expires_at, u.is_active
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1`,
    [sid]
  );
  const row = r.rows[0];
  if (!row) return false;
  if (new Date(row.expires_at).getTime() <= Date.now()) return false;
  return row.is_active === true;
}
```

3. Em `authenticate`, logo após `isSessionPayload`:

```ts
const alive = await assertSessionAlive(decoded.sid);
if (!alive) {
  res.status(401).json({ success: false,
    error: { message: 'Session revoked or inactive.', code: 'AUTH_SESSION_INVALID' } });
  return;
}
```

(Este `await` está dentro do try existente ⇒ erro de DB ⇒ catch ⇒ 500 ✓.) Preencher `sid: decoded.sid` no `authUser` (adicionar `sid?: string` a `AuthUser`).
4. Em `verifyAccessToken`, após `isSessionPayload`: `if (!(await assertSessionAlive(decoded.sid))) return null;` e incluir `sid` no objeto devolvido.

- [ ] **Step 4: Correr para verificação** — `npx tsx tests/authGuard.test.ts` → checks 1-4 (existentes) + 5-11 (novos) ALL PASS.

- [ ] **Step 5: Corrigir os 4 testes existentes afectados pelo gate** — todos mintam tokens de sessão SEM `sid` e/ou não têm linha de sessão no harness; a correcção é **sempre o mesmo par de padrões**, nunca afrouxar o gate:

  1. **`installAccess.test.ts`** — (a) `sessionToken` (`:36-47`): acrescentar `sid: '11111111-1111-4111-8111-111111111111'` ao payload. (b) Hoje não tem FakePool (pool `undefined` ⇒ query lança ⇒ catch ⇒ 500) — converter o `import devicesRouter from '../src/routes/devices'` (`:14`) para `require` **depois** de instalar o bloco FakePool (copiar de `installRequests.test.ts:37-109`) + `await initDatabase()` no início do `main` (padrão `networkStats.test.ts:70-80`). `respond`: `JOIN users u ON u.id = s.user_id` → `[{ expires_at: FUTURE, is_active: true }]`; default → `[]` (os 2 testes autenticados esperam **403** por `devices.manage` — com permissions `[]` do DB continuam a dar 403 ✓).
  2. **`networkStats.test.ts`** — (a) token (`:83-93`): acrescentar `sid`. (b) `respond` (`:35-38`): acrescentar ramo primeiro: gate match → `[{ expires_at: FUTURE, is_active: true }]`.
  3. **`networkDiscovery.test.ts`** — (a) `sessionToken` (`:770`): acrescentar `sid` ao payload. (b) `respond` (`:68-83`): inserir o ramo do gate **depois** do loop de `scripts` e **antes** do `return { rows: [] }` final (scripts explícitos > gate default > vazio) → `[{ expires_at: FUTURE, is_active: true }]`. Assim nenhum dos ~15 `setScripts` individuais precisa de alteração; testes de erro via `injectErrorOnce` continuam a mandar primeiro.
  4. **`socketAuth.test.ts`** — (a) `sessionToken` (`:29-40`): acrescentar `sid`. (b) `verifyAccessToken` é chamado no handshake ⇒ precisa de linha de sessão: converter `import * as websocket from '../src/websocket'` (`:12`) para `require` depois de instalar FakePool + `await initDatabase()`; `respond` com ramo de gate → linha viva (mesmo padrão do 1).

  (FUTURE = `new Date(Date.now() + 3600e3).toISOString()`. Nenhum outro teste usa `authenticate`/`Bearer` de sessão — verificado por grep: só estes 4 + `authGuard`.)

- [ ] **Step 6: Suite + typecheck** — `npm test` → ALL PASS (16 ficheiros + `safeCompare` + `authSession`); `npm run typecheck` → limpo. Se algum outro teste falhar por 401 `AUTH_SESSION_INVALID`, aplicar o mesmo par de padrões ao harness desse ficheiro.
- [ ] **Step 7: Commit** — `git commit -m "feat(auth): authenticate verifies session existence and account state"`

---

### Task 4: Logout revoga a sessão do token + dashboard chama a API

**Files:**
- Modify: `backend-api/src/controllers/authController.ts:425-442` (`logout`)
- Modify: `admin-dashboard/src/services/api.ts:180-186` (`logout()`)
- Modify: `backend-api/tests/authSession.test.ts` (novos checks)

**Interfaces:**
- Consumes: `req.user.sid` (Task 3).
- Produces: `DELETE FROM user_sessions WHERE id = $1` com o `sid` do token; dashboard `logout()` faz `POST ${API_BASE}/auth/logout` com Bearer actual (fire-and-forget, `.catch(() => {})`) **antes** de limpar localStorage.

- [ ] **Step 1: Escrever testes falhadores** — acrescentar a `authSession.test.ts`:

```
6. logout revokes session end-to-end:
   register+login user → GET /auth/profile → 200   (prova que o gate do Task 3 passa)
   → POST /auth/logout (Bearer access) → 200
   → GET /auth/profile com o MESMO access token → 401
   → POST /auth/refresh com o refreshToken → 401   // linha apagada
7. deactivated account takes effect immediately (spec test 3):
   register+login user2 → GET /auth/profile → 200
   → await query('UPDATE users SET is_active = false WHERE id = $1', [user2.id])
   → GET /auth/profile com o MESMO token → 401     // sem re-login
8. logout writes audit: após logout, SELECT action FROM audit_logs
   WHERE user_id = $1 AND action = 'logout' devolve 1 linha
```

- [ ] **Step 2: Correr para verificar falha** — `npx tsx tests/authSession.test.ts` → check 6 FAIL (hoje o DELETE em `:434` compara `refresh_token_hash` com o hash do ACCESS token ⇒ casa 0 linhas ⇒ o access continua a passar o gate do Task 3). Checks 7 e 8 podem já estar verdes (gate de `is_active` vem do Task 3; o INSERT de audit em `:437` já existe) — são guarda de regressão obrigatória (spec test 3 + auditoria), mantêm-se na mesma.
- [ ] **Step 3: Implementar logout**

```ts
export const logout = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.user?.id;
    const sid = req.user?.sid;
    if (!userId || !sid) { res.status(401).json({ success: false, error: { message: 'Not authenticated' } }); return; }
    await query('DELETE FROM user_sessions WHERE id = $1', [sid]);
    await query('INSERT INTO audit_logs ...', [...como hoje...]);
    res.json({ success: true, data: { message: 'Logged out' } });
  } catch (error) { next(error); }
};
```

(Remover o bloco do header Authorization/`hashToken` — `hashToken` continua importado para o login.)

- [ ] **Step 4: Dashboard** — em `admin-dashboard/src/services/api.ts`:

```ts
logout() {
  const token = this.accessToken;
  if (token) {
    fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => { /* best-effort; o clear local acontece sempre */ });
  }
  this.accessToken = null;
  ...resto como hoje...
}
```

- [ ] **Step 5: Correr para verificar passagem** — `npx tsx tests/authSession.test.ts` → ALL PASS (checks 1-8).
- [ ] **Step 6: Suite + typecheck + build dashboard** — `npm test` → ALL PASS; `npm run typecheck` → limpo; `npm run build` em `admin-dashboard/` → sucesso (valida a mudança TS do cliente).
- [ ] **Step 7: Commit** — `git commit -m "fix(auth): logout revokes the session bound to the token; dashboard calls API"`

---

### Task 5: Gate do heartbeat mobile (`x-heartbeat-token`)

**Files:**
- Modify: `backend-api/src/routes/devices.ts:2339-2348` (logo após o check do prefixo `mobile-`, antes do `SELECT`)
- Modify: `backend-api/tests/agentAuth.test.ts` (3 checks novos)
- Create: `backend-api/tests/mobileHeartbeat.test.ts` (FakePool — issuance + caminho feliz)
- Modify: `backend-api/package.json` (lista `test`)

**Interfaces:**
- Consumes: `remoteSecretFor(agentId)` (já importado em `devices.ts`), `safeCompare` (Task 1), `requireAgentSecret` embutido no `remoteSecretFor`.
- Produces: comportamento — sem header ⇒ 401; header ≠ `remoteSecretFor(agent_id)` ⇒ 401; correto ⇒ segue para o `SELECT` normal. Registo mobile **inalterado** (já devolve `remote_token`).

- [ ] **Step 1: Escrever testes falhadores**

Em `agentAuth.test.ts` (sem BD — o gate está antes da query):

```ts
// 6. mobile heartbeat without x-heartbeat-token -> 401
post('/mobile/heartbeat', { agent_id: 'mobile-aa' }) → 401
// 7. wrong heartbeat token -> 401
post('/mobile/heartbeat', { agent_id: 'mobile-aa' }, { 'x-heartbeat-token': 'nope' }) → 401
// 8. correct heartbeat token -> not 401
const expected = crypto.createHmac('sha256', process.env.AGENT_SECRET!)
  .update('endpointx:remote:mobile-aa').digest('hex');
post('/mobile/heartbeat', { agent_id: 'mobile-aa' }, { 'x-heartbeat-token': expected })
  → notStrictEqual 401   // sem BD segue para SELECT → 500 → ok
```

Novo `tests/mobileHeartbeat.test.ts` (FakePool, copiar harness de `installRequests.test.ts:37-109`):

```
1. mobile register returns remote_token equal to per-device HMAC:
   scripts: [FROM devices WHERE agent_id → [{id: DEV, approval_status:'pending'}],
             UPDATE devices SET → []]   // ramo "existing" — resposta já traz remote_token
   POST /mobile/register {device_name, enroll_token} → 200
   → data.remote_token === hmac('endpointx:remote:' + data.agent_id) e /^[0-9a-f]{64}$/
2. wrong heartbeat token on enrolled device -> 401 (gate antes da lookup):
   scripts: [SELECT id, status FROM devices WHERE agent_id → [{id: DEV, status:'online'}]]
   POST /mobile/heartbeat {agent_id} + header errado → 401
   // se o gate não existir, o device existe → 200 → RED
3. correct heartbeat token persists telemetry -> 200:
   scripts: [SELECT id, status FROM devices WHERE agent_id → [{id: DEV, status:'offline'}],
             UPDATE devices SET status → [], INSERT INTO device_heartbeats → []]
   header correcto → 200, body { status: 'online' }
```

Acrescentar `tsx tests/mobileHeartbeat.test.ts` à lista `test`.

- [ ] **Step 2: Correr para verificar falha** — `npx tsx tests/agentAuth.test.ts` → checks 6/7 FAIL (hoje 404/500 sem gate); `npx tsx tests/mobileHeartbeat.test.ts` → check 2 FAIL (200 em vez de 401); check 1 pode já passar (emissão existente) — aceitável.
- [ ] **Step 3: Implementar o gate em `devices.ts`** — após o `if (!agentId.startsWith('mobile-')) {...}` e antes do `const existing = await query(...)`:

```ts
if (!safeCompare(req.headers['x-heartbeat-token'], remoteSecretFor(agentId))) {
  res.status(401).json({ success: false, error: { message: 'Invalid heartbeat token' } });
  return;
}
```

(importar `safeCompare` se o Task 1 não o tiver feito já no topo do ficheiro.)

- [ ] **Step 4: Correr para verificar passagem** — `npx tsx tests/agentAuth.test.ts` → ALL PASS; `npx tsx tests/mobileHeartbeat.test.ts` → ALL PASS.
- [ ] **Step 5: Suite + typecheck** — `npm test` → ALL PASS; `npm run typecheck` → limpo.
- [ ] **Step 6: Commit** — `git commit -m "feat(security): mobile heartbeat requires per-device remote token"`

---

### Task 6: Clientes mobile enviam o token (página, SW, Android) + nota SECURITY.md

**Files:**
- Modify: `backend-api/public/install-mobile.html` (`:151`, `:205-232`, `:254-272`, `:295-298`, `:362-363`)
- Modify: `backend-api/public/sw.js` (`:3-4`, `:43-69`, migração `:27-33`)
- Modify: `endpoint-android/app/src/main/java/pt/endpointx/agent/EndpointApi.kt:86-89`
- Modify: `SECURITY.md` (checklist do operador)

**Interfaces:**
- Consumes: `data.data.remote_token` no 200/201 do registo mobile; header `x-heartbeat-token` (Task 5).
- Produces: localStorage `endpointx_remote_token`; cache SW em `/api/devices/public/__hb-token`; header em todas as chamadas de heartbeat.

- [ ] **Step 1: `install-mobile.html`**
  1. Junto de `var AGENT_KEY = ...` (`:151`): `var REMOTE_KEY = 'endpointx_remote_token';`
  2. No sucesso do registo (`:362-363`): `localStorage.setItem(REMOTE_KEY, data.data.remote_token || '');` e `storeAgentForSW(data.data.agent_id, data.data.remote_token);`
  3. `storeAgentForSW(id, token)`: guardar também `c.put('/api/devices/public/__hb-token', new Response(token || ''))`.
  4. `sendHeartbeat()` (`:205-232`): `var tok = localStorage.getItem(REMOTE_KEY); if (!id || !tok || hbInFlight) return;` e headers `{ 'Content-Type': 'application/json', 'x-heartbeat-token': tok }`. (Sem token ⇒ não envia — evita loop de retries fúteis em instalações antigas; servidor responde 401 de qualquer forma.)
  5. `sendHeartbeatKeepalive()` (`:254-265`): idem — lê `REMOTE_KEY`, inclui header, retorna se ausente.
  6. Arranque (`:295-298`): passar o token a `storeAgentForSW(localStorage.getItem(AGENT_KEY), localStorage.getItem(REMOTE_KEY));`

- [ ] **Step 2: `sw.js`**
  1. `var TOKEN_KEY_URL = '/api/devices/public/__hb-token';` junto de `AGENT_KEY_URL`.
  2. `function readToken()` — espelho de `readAgentId` para `TOKEN_KEY_URL`.
  3. `sendHeartbeat()`: `readToken()` em paralelo; sem token ⇒ `return;`; header `'x-heartbeat-token': tok`.
  4. Migração `activate` (`:27-33`): copiar também `TOKEN_KEY_URL` do cache antigo (par do agent-id).

- [ ] **Step 3: `EndpointApi.kt`** — em `heartbeat()` (`:86-89`):

```kotlin
val request = Request.Builder()
    .url("${Prefs.server(ctx)}/api/devices/mobile/heartbeat")
    .header("x-heartbeat-token", Prefs.remoteToken(ctx))
    .post(body.toString().toRequestBody(JSON))
    .build()
```

(`Prefs.remoteToken` já existe — `Prefs.kt:27-30`.)

- [ ] **Step 4: `SECURITY.md`** — no checklist do operador, item novo: "Rodar `AGENT_SECRET` invalida os tokens de heartbeat mobile (`remote_token`) — os dispositivos mobile re-registam (página/APK); o access/refresh dos utilizadores não é afectado."

- [ ] **Step 5: Verificação**
  - `node --check public/sw.js` → sem erro de sintaxe.
  - Extrair o `<script>` inline principal de `install-mobile.html` para temp e `node --check` (ou revisão manual das 6 alterações — reportar o método usado).
  - `npx tsc --noEmit` não cobre Kotlin: reportar `EndpointApi.kt` como **não compilado/não testado** neste ambiente.
  - `npm test` → ALL PASS (nenhum teste de regressão de JS inline); `npm run typecheck` → limpo.

- [ ] **Step 6: Commit** — `git commit -m "feat(security): mobile clients send per-device heartbeat token (page, SW, Android)"`

---

### Task 7: Verificação final + relatório

**Files:**
- Modify (apenas se a verificação encontrar defeitos): corrigir e commitar à parte com mensagem própria.

- [ ] **Step 1: Verificação completa**
  - `npm test` (backend) → ALL PASS, sem excepções.
  - `npm run typecheck` → limpo.
  - `npm run build` em `admin-dashboard/` → sucesso.
  - `node --check backend-api/public/sw.js` → ok.
  - `git log --oneline main..feat/fase-c-security-criticos` → commits das tasks 1-6.
  - `git status` → limpo.
- [ ] **Step 2: Relatório final em PT-PT** — ficheiros por commit, testes executados com resultado exacto (incl. contagens de checks), decisões (emenda do spec §3.1 a reutilizar `remote_token`; fail-closed com 500 em erro de DB; sem cache de sessão), mudanças não validadas (Kotlin não compilado, JS inline do HTML por extração/`node --check`), riscos (re-login/refresh pós-deploy, clientes mobile antigos 401, rotação de `AGENT_SECRET`), próximos passos (push + PR, itens de higiene da Fase C adiados).

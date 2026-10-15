# Fase C — Segurança: Críticos 1-4 (Design)

**Data:** 2026-10-15
**Estado:** aprovado em chat
**Âmbito:** os quatro itens críticos da auditoria de segurança de 2026-10-15, exclusivamente. Higiene (algoritmos JWT, rate-limit OSINT, código morto, docs, MFA/SSO, `/devices/mobile/heartbeat` com sessão) fica para fase futura.

## Objectivo

1. **Logout funcional** — hoje o logout não revoga nada (compara hash do access token com `refresh_token_hash`, nunca coincide).
2. **Conta desactivada bloqueada** — `authenticate()` nunca lê `users.is_active`; tokens continuam válidos até expirar.
3. **`X-Agent-Secret` timing-safe** — 9 comparações com `!==`.
4. **`/devices/mobile/heartbeat` autenticado** — rota pública com apenas prefixo `mobile-` + rate limits.

## Decisões aprovadas

- **Sessão no token (sem cache):** claim `sid` no access token; verificação por sessão+utilizador em cada pedido autenticado; logout mata a sessão; refresh actualiza a linha em vez de a substituir.
- **HMAC por-dispositivo para o heartbeat mobile:** token devolvido no registo, verificação stateless no servidor; clientes web/SW/Android actualizados.

---

## 1. Sessão no token (logout + is_active)

### 1.1 Claims

`generateToken` (`src/utils/helpers.ts:17-27`) recebe `sid: string` e inclui-o no payload. Passam a emitir `sid`:

- **Login** — `authController.ts:141-145`; a linha em `user_sessions` é criada antes do token (reordenar se necessário: criar sessão primeiro, depois assinar).
- **Register** — `authController.ts:238-251`.
- **MFA verify** — `authController.ts:627-639`.
- **Refresh** — `authController.ts:470` com o `sid` **estável** (ver 1.3).

O token MFA-temp (`type:'mfa_temp'`, `authController.ts:116-120`) **não** leva `sid` — continua rejeitado pelo guard actual.

### 1.2 Verificação em `authenticate()`

Após `jwt.verify` + `isSessionPayload` (`src/middleware/auth.ts:105-119`):

```sql
SELECT s.expires_at, u.is_active
  FROM user_sessions s
  JOIN users u ON u.id = s.user_id
 WHERE s.id = $1
```

- Sem linha, `expires_at <= NOW()`, ou `u.is_active = false` ⇒ **401** `Session revoked or inactive` (mensagem única, sem distinguir causas).
- Sucesso ⇒ continua como hoje (`loadRolePermissions`, etc.).
- `sid` ausente/UUID inválido ⇒ 401 (guarda de compatibilidade com tokens antigos).

Aplica-se também em **`verifyAccessToken`** (`auth.ts:225-246`, usado no handshake WS em `src/websocket/index.ts:15-28`) — mesma query, mesma rejeição.

**Custo:** 1 query indexada por pedido autenticado (PK `user_sessions.id` + FK `users.id`). Sem cache (decisão aprovada); o produto tem tráfego de dashboard, não de escala massiva.

### 1.3 Logout

`authController.ts:425-442` — passa a:

```ts
const sid = req.user?.sid;           // claim do token autenticado
if (!sid) { 401; return; }
await query('DELETE FROM user_sessions WHERE id = $1', [sid]);
// audit_logs inalterado
```

Sem leitura do header `Authorization` para hashing; sem uso de `req.body.refreshToken`.

### 1.4 Refresh com `sid` estável

`authController.ts:449-478` — hoje: procura sessão pelo hash, **apaga** e **insere nova** (id novo ⇒ `sid` do access token em uso morreria). Passa a:

1. Procurar sessão pelo `refresh_token_hash` + `expires_at > NOW()` + `users.is_active` (já verifica activo, manter).
2. `UPDATE user_sessions SET refresh_token_hash = $novo, expires_at = $nova_expiracao WHERE id = $sessao.id` — **mesma linha, mesmo `sid`**.
3. Novo access token com o mesmo `sid`.

Rotação de refresh token mantém-se (hash antigo deixa de servir); o access token em uso sobrevive à rotação.

### 1.5 Dashboard

`admin-dashboard/src/services/api.ts:180-186` — `logout()` passa a fazer `POST /api/auth/logout` (com o bearer actual) **antes** de limpar localStorage; falha de rede não impede o clear local.

### 1.6 Impacto de deploy

Todos os access tokens emitidos antes do deploy não têm `sid` ⇒ 401 ⇒ re-login automático (o cliente tratará 401 como sessão expirada). Aceite.

---

## 2. Timing-safe no `X-Agent-Secret`

### 2.1 Helper

Em `src/utils/helpers.ts`:

```ts
export function safeCompare(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}
```

Hash a ambos ⇒ comprimentos iguais (requisito de `timingSafeEqual`) e sem vazamento de comprimento pela resposta/timeing.

### 2.2 Pontos substituídos (9)

| # | Ficheiro | Contexto |
|---|---|---|
| 1 | `devices.ts:331-332` | `POST /register` |
| 2 | `devices.ts:546-547` | `POST /heartbeat` |
| 3 | `devices.ts:686` | `POST /command-poll` |
| 4 | `devices.ts:1291-1292` | `POST /inventory` |
| 5 | `devices.ts:1377-1378` | `POST /command-result` |
| 6 | `devices.ts:1445-1446` | `POST /security-scan` |
| 7 | `devices.ts:1552-1553` | `POST /alerts` |
| 8 | `devices.ts:1606-1607` | `POST /events` |
| 9 | `remote/index.ts:102` | handshake WS (`expected` **e** `remoteSecretFor`) |

`devices.ts` importa `safeCompare` (não precisa de `crypto` próprio). As 8 rotas passam de `!== process.env.AGENT_SECRET` para `safeCompare(header, requireAgentSecret())` — usar `requireAgentSecret()` em vez de `process.env.AGENT_SECRET` directo elimina a comparação contra `undefined`.

---

## 3. Heartbeat mobile com HMAC por-dispositivo

### 3.1 Emissão

**Emenda de implementação (2026-10-15):** o registo mobile (`POST /devices/mobile/register`) **já devolve** `remote_token = remoteSecretFor(agentId)` (`devices.ts:2226/2283/2328`), que é exactamente um HMAC por-dispositivo: `HMAC-SHA256(AGENT_SECRET, 'endpointx:remote:' + agent_id)` (`src/remote/index.ts:94-98`), e o app Android já o guarda (`Prefs.remoteToken`, `Prefs.kt:27-30`). Em vez de cunhar um segundo token `heartbeat_token` com outro prefixo HMAC, o heartbeat **reutiliza este `remote_token`**:

```ts
// verificação em devices.ts, após validação do prefixo mobile-
const expected = remoteSecretFor(agentId);          // já importado no ficheiro
if (!safeCompare(req.headers['x-heartbeat-token'], expected)) { 401 }
```

Nenhuma alteração de emissão é necessária — os 3 ramos de resposta do registo já incluem `remote_token`. Stateless: o servidor não guarda o token — recomputa-o para verificar.

### 3.2 Verificação

`POST /devices/mobile/heartbeat` (`devices.ts:2339-2445`):

- Sem header `x-heartbeat-token` ⇒ **401**.
- `safeCompare(header, remoteSecretFor(agentId))` com o `agent_id` do body ⇒ falha ⇒ **401**.
- Antes do `SELECT` de existência do device (o HMAC é barato; a query fica para trás da autenticação).

### 3.3 Clientes

| Cliente | Mudança |
|---|---|
| `public/install-mobile.html` | Guardar `data.data.remote_token` no localStorage no registo; enviar `x-heartbeat-token` nas duas chamadas (`:219`, `:258`); guardar na cache do SW. |
| `public/sw.js` | Ler o token da cache (entrada nova, par do `agent-id`); incluir header no heartbeat do Background Sync (`:61-67`). |
| `endpoint-android` `EndpointApi.kt` | `Prefs.remoteToken` **já existe e já é preenchido no registo** — só falta adicionar o header em `heartbeat()` (`:86-89`). **Não compilável/testável neste ambiente** — mudança sintáctica, nota no relatório. |

### 3.4 Compatibilidade

- Clientes mobile desactualizados recebem 401 até re-registarem (web/SW actualiza com o servidor; Android precisa de rebuild).
- Rotação de `AGENT_SECRET` invalida todos os tokens ⇒ re-registo dos dispositivos mobile. Documentar em SECURITY.md (checklist do operador).

---

## 4. Testes (TDD — RED primeiro)

Novos/alvos em `tests/` (ficheiro existente ou novo conforme o plano):

1. **sid ausente ⇒ 401** — token no formato antigo rejeitado.
2. **logout mata a sessão** — login → logout → access token seguinte 401; refresh token da mesma sessão 401.
3. **conta desactivada ⇒ 401** — emitir token, `UPDATE users SET is_active=false`, pedido seguinte 401 (sem cache ⇒ efeito imediato).
4. **refresh mantém `sid` estável** — refresh succeeds; access token antigo continua válido; novo access token tem mesmo `sid`.
5. **sessão expirada/inexistente ⇒ 401** — apagar linha da sessão manualmente ⇒ 401.
6. **`safeCompare`** — iguais ⇒ true; diferentes ⇒ false; comprimentos diferentes ⇒ false; não-string (undefined/array) ⇒ false.
7. **registo mobile devolve `remote_token`** — igual a `HMAC-SHA256(AGENT_SECRET, 'endpointx:remote:' + agent_id)`, hex 64.
8. **heartbeat sem token ⇒ 401**; **token errado ⇒ 401**; **token correcto ⇒ 200** e telemetria persistida.
9. **handshake WS** — token com sessão revogada ⇒ rejeitado (cobertura de `verifyAccessToken`).

Regressão obrigatória: `npm test` completa + `npm run typecheck` por task.

---

## Fora de âmbito (registo explícito)

- MFA/SSO (mount + bug decode `authController.ts:577`) — issue adiada de 2026-10-08.
- `algorithms` explícito no `jwt.verify`; rate limiter OSINT; limpeza de código morto (`rateLimiter.ts`, `constants.ts:10-98`, `requireRole`); `npm audit` tooling; divergências `docs/security.md` (15min vs 1h, cookie vs JSON).
- Cache de verificação de sessão (decisão: sem cache).
- `docker-compose.yml:43` AGENT_SECRET default de 32 chars.

## Riscos

| Risco | Mitigação |
|---|---|
| Re-login obrigatório no deploy | Esperado; clientes tratam 401 como sessão expirada. |
| 1 query/ request autenticado | Índices PK/FK; produto de baixo-médio tráfego. Se necessário, cache de sessão é adição futura cirúrgica. |
| Android sem build/teste aqui | Mudança sintáctica mínima; nota no relatório; bloqueia só o app Android. |
| Clientes mobile antigos 401 | Web/SW serve-se do mesmo deploy; Android rebuild. |
| `AGENT_SECRET` rotacionado ⇒ heartbeat mobile 401 | Documentar: após rodar o segredo, os dispositivos mobile re-registam. |

# Cyber Lab (seefast) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Subsistema Cyber Lab no EndpointX: fundação do adaptador do motor externo `seefast`, menu de 14 secções com estados reais, jobs de análise estática (JS/Electron + Go/Rust) ponta-a-ponta com evidência, e consola AI experimental — Fases 1+2+3+F4a da spec.

**Architecture:** Abordagem 1 (subsistema com costuras de reutilização): rotas/tabelas próprias (`/api/cyberlab/*`, `cyberlab_*`), reutilização de RBAC (`allPerms` + repair-loop), `audit_logs`, camada AI `opencode.ts`, scheduler in-process no padrão `jobs.ts`, FakePool tests. Motor externo via `execFile` com argv allowlist (`SEEFAST_CLI` env), nunca shell, nunca execução de amostras.

**Tech Stack:** Express 4 + TS (`tsx`), PostgreSQL 16 (DDL inline em `database.ts`), React + Vite (admin), `json2csv` (já existente) para CSV, zod (já existente).

**Spec:** `docs/superpowers/specs/2026-10-17-cyberlab-seefast-design.md` (o plano argumenta da spec; executores leem ambos)

## Global Constraints

- **Proveniência (spec §1.2):** zero termos que identifiquem o motor original em repo/UI/relatórios/docs; motor = binário externo via env `SEEFAST_CLI`; padrões de verificação de fugas ficam **no ledger da sessão** (fora do repo), nunca no repo.
- **Zero dependências npm novas** no backend e no admin (spec §1.5).
- **Só análise estática:** nenhum caminho de código executa amostras (spec §1.4); operações expostas = apenas as 3 da allowlist (ver Task 2).
- **Limites (spec §5):** artefacto ≤25MB (base64), job ≤120s, concorrência 1 (FIFO), stdout ≤5MB truncado com marca; valores env-tuneáveis com estes defaults.
- **Envelope:** `{ success, data }` / `{ success: false, error: { message, code } }`.
- **RBAC backend sempre** (nunca só UI); nova category `cyberlab` com `cyberlab.view|manage|approve|export`; seed `user` **nunca** os ganha; `cyberlab.approve` fica reservado para F5 (não usado nesta spec).
- **Audit actions:** `cyberlab.job_started`, `cyberlab.job_cancelled`, `cyberlab.artifact_uploaded`, `cyberlab.finding_acknowledged`, `cyberlab.scope_changed` (tabela global `audit_logs`).
- **i18n PT + EN completo** — toda a chave presente nos dois dicts; zero strings hardcoded no JSX novo.
- **Estados honestos** na UI: `Available | Experimental | Not Configured | Coming Soon` — nunca métricas/botões simulados.
- **Não tocar** em: `hermes_*`, `devices`, discovery, rotas de agentes, funcionalidades existentes (nenhuma remoção/desactivação).
- **Testes:** padrão FakePool (`tests/networkDiscovery.test.ts` é o exemplo documentado do harness), runner `npx tsx`, TDD RED→GREEN por task; chain `npm test` existente nunca pode ficar vermelha no fim de cada task.
- **Windows/PowerShell 5.1** no ambiente de execução; comandos de teste correm com `workdir backend-api` (ou `npm --prefix backend-api`).

## Review Focus

1. **Upload inválido (oversize / base64 malformado / name com path traversal)** → espera 4xx + **nenhum ficheiro parcial** no disco + nenhum INSERT. Dono: Task 3 (`tests/cyberlabArtifacts.test.ts`).
2. **Dois jobs a arrancar quase em simultâneo** → só 1 `running`, o 2º `queued`, e a conclusão do 1º **promove** o 2º (FIFO). Dono: Task 4 (`tests/cyberlabJobs.test.ts`).
3. **Cancelamento a meio da execução** → filho recebe SIGTERM, job `cancelled`, temporários limpos, **zero findings** criados. Dono: Task 4 (lifecycle) + Task 5 (asserção de findings).
4. **Motor ausente (`SEEFAST_CLI` vazio/inválido)** → `GET /providers` devolve `not_configured` **sem tentar spawn**; `POST /jobs` responde erro claro (não 500, não "corrido"); UI mostra `Not Configured`. Dono: Tasks 2/3/4.
5. **Output do motor malformado ou truncado >5MB** → job `failed`/`partial` com erro sanitizado; **zero findings inventados** (nunca inferir de output não-JSON). Dono: Task 5 (`tests/cyberlabFindings.test.ts`).

## File Structure

```
backend-api/src/
  config/database.ts               [MOD] +4 tabelas cyberlab_* + 4 tuples allPerms
  index.ts                         [MOD] +mount /api/cyberlab
  routes/cyberlab.ts               [CRIAR] todos os endpoints do subsistema
  services/seefast/
    limits.ts                      [CRIAR] getLimits() env+settings, cache 60s
    capabilities.ts                [CRIAR] probeCapabilities() — execFile capabilities --json
    adapter.ts                     [CRIAR] JOB_OPS allowlist + runOperation() execFile
    normalize.ts                   [CRIAR] normalizeJobResult() → findings/limitations
    jobsRunner.ts                  [CRIAR] ciclo de vida queued→running→…, Map de ChildProcess
backend-api/tests/
  cyberlabRbac.test.ts             [CRIAR] Task 1
  cyberlabSeefastCore.test.ts      [CRIAR] Task 2
  cyberlabArtifacts.test.ts        [CRIAR] Task 3
  cyberlabJobs.test.ts             [CRIAR] Task 4
  cyberlabFindings.test.ts         [CRIAR] Task 5
  cyberlabExport.test.ts           [CRIAR] Task 6
  cyberlabConsole.test.ts          [CRIAR] Task 7
  cyberlabIntegration.test.ts      [CRIAR] Task 8 (SKIP sem motor)
  fixtures/seefast/*.json          [CRIAR] capturas reais do motor (Task 8)
admin-dashboard/src/
  components/Layout.tsx            [MOD] nav group cyberlab (14 items)
  App.tsx                          [MOD] 14 rotas PermissionGate cyberlab.view
  i18n/index.tsx                   [MOD] chaves PT + EN
  pages/cyberlab/
    CyberLabOverview.tsx           [CRIAR] Task 9
    CyberLabSoon.tsx               [CRIAR] Task 9 (pentest/malware)
    CyberLabReadonly.tsx           [CRIAR] Task 9 (assets/vulns/network)
    CyberLabJobs.tsx               [CRIAR] Task 10 (upload+nova+fila)
    CyberLabJobDetail.tsx          [CRIAR] Task 10 (evidência+export+cancel)
    CyberLabFindings.tsx           [CRIAR] Task 10
    CyberLabEvidence.tsx           [CRIAR] Task 10 (artefactos+exports)
    CyberLabIntegrations.tsx       [CRIAR] Task 11
    CyberLabSettings.tsx           [CRIAR] Task 11
    CyberLabAudit.tsx              [CRIAR] Task 11
    CyberLabAnalyst.tsx            [CRIAR] Task 11 (consola)
docs/cyberlab.md                   [CRIAR] Task 12 — env, limites, estados (sem proveniência)
```

---

### Task 1: RBAC + schema `cyberlab_*`

**Files:**
- Modify: `backend-api/src/config/database.ts` (DDL junto às outras tabelas; tuples em `allPerms` ~:1275; exportar `allPerms` se ainda não exportado)
- Test: `backend-api/tests/cyberlabRbac.test.ts`

**Interfaces:**
- Produces (para todas as tasks seguintes): tabelas `cyberlab_jobs`, `cyberlab_artifacts`, `cyberlab_findings`, `cyberlab_scopes` (colunas ver spec §4 — copiar literalmente); códigos `cyberlab.view|manage|approve|export` (category `cyberlab`); repair-loop admin existe já e não se mexe.

- [ ] **Step 1: Teste falhante** — `tests/cyberlabRbac.test.ts`: (a) FakePool captura os INSERTs do boot → assert que `allPerms` contém exactamente os 4 códigos cyberlab com a categoria `cyberlab`; (b) assert que `SEED_ROLE_PERMISSIONS` **não** contém nenhum código `cyberlab.*` (incl. `user`); (c) HTTP: sessão jwt assinada com papel sem `cyberlab.view` → `GET /api/cyberlab/providers` (rota ainda inexistente, montada-de-guerra com o router vazio no teste) → 403 `PERMISSION_DENIED`.
- [ ] **Step 2: Correr e ver falhar** — `npx tsx tests/cyberlabRbac.test.ts` → FAIL (4 códigos em falta / rota 404).
- [ ] **Step 3: Implementar** — DDL 4 tabelas + índices (`IF NOT EXISTS`), 4 tuples em `allPerms` na ordem `[code, name, description, category]`.
- [ ] **Step 4: Correr e ver passar** — `npx tsx tests/cyberlabRbac.test.ts` → ALL PASS; `npm run typecheck` limpo.
- [ ] **Step 5: Commit** — `git add backend-api/src backend-api/tests/cyberlabRbac.test.ts; git commit -m "feat(cyberlab): schema cyberlab_* e permissões cyberlab.view/manage/approve/export"`

---

### Task 2: núcleo seefast — `limits` + `capabilities` + `adapter`

**Files:**
- Create: `backend-api/src/services/seefast/limits.ts`, `capabilities.ts`, `adapter.ts`
- Test: `backend-api/tests/cyberlabSeefastCore.test.ts`

**Interfaces:**
- Produces:
  - `limits.ts`: `export interface SeefastLimits { maxArtifactBytes: number; jobTimeoutMs: number; maxStdoutBytes: number; maxConcurrentJobs: number }` + `export async function getLimits(): Promise<SeefastLimits>` — defaults `25*1024*1024 | 120_000 | 5*1024*1024 | 1`; override via env (`CYBERLAB_*`) e depois settings (`cyberlab_*` chaves), cache em memória 60s.
  - `capabilities.ts`: `export type ProviderStatus = { available: boolean; reason: 'not_configured' | 'probe_failed' | null; version: string | null; detail: string | null }` + `export async function probeCapabilities(): Promise<ProviderStatus>` — sem `SEEFAST_CLI` → `not_configured` **sem spawn**; com env → `execFile(SEEFAST_CLI, ['capabilities', '--json'], {timeout: 15000})`; exit 0 → `available:true` (versão do output se existir, senão `null`); erro → `probe_failed` com `detail` sanitizado (≤200 chars).
  - `adapter.ts`: `export type JobType = 'js_analysis' | 'go_binary' | 'rust_binary'` + `export const JOB_OPS: Record<JobType, (path: string) => string[]>` com **exactamente** (comandos documentados do motor):
    - `js_analysis` → `['analyze-javascript-application', path, '--json']`
    - `go_binary` → `['inspect-go-binary', path, '--json']`
    - `rust_binary` → `['inspect-rust-binary', path, '--json']`
    + `export type RawRun = { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderrTail: string; truncated: boolean; timedOut: boolean; durationMs: number }`
    + `export async function runOperation(type: JobType, artifactPath: string, limits: SeefastLimits): Promise<RawRun>` — `execFile` (argv array, **jamais** shell), `timeout: limits.jobTimeoutMs`, `killSignal: 'SIGTERM'`, `maxBuffer: limits.maxStdoutBytes`; `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` → `truncated: true` com stdout parcial; timeout → `timedOut:true`; stderr guardado só nos últimos 4096 chars.

- [ ] **Step 1: Teste falhante** — `tests/cyberlabSeefastCore.test.ts`: (a) `getLimits()` sem env → 4 defaults exactos; (b) probe sem `SEEFAST_CLI` → `{available:false, reason:'not_configured'}` e **spawn não chamado** (spy no `child_process.execFile` via require-cache, padrão FakePool); (c) `JOB_OPS` para os 3 tipos devolve os argv exactos acima; tipo fora da allowlist → `JOB_OPS[type]` undefined → `runOperation` lança `Error('UNSUPPORTED_OPERATION')`; (d) probe com env mas exit 1 → `probe_failed` + detail ≤200 chars; (e) `runOperation` mapeia: exit 0 → ok; exit 1 → `{exitCode:1}`; sinal SIGTERM/exit 143 → `{signal:'SIGTERM'}`; stdout > maxBuffer → `truncated:true`.
- [ ] **Step 2: Correr e ver falhar** — `npx tsx tests/cyberlabSeefastCore.test.ts` → FAIL (módulos inexistentes).
- [ ] **Step 3: Implementar** os 3 módulos.
- [ ] **Step 4: Correr e ver passar** + `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(cyberlab): adaptador seefast com allowlist de operações, sonda de capacidades e limites"`

---

### Task 3: rotas — `providers` + `artifacts` (+ mount)

**Files:**
- Create: `backend-api/src/routes/cyberlab.ts`
- Modify: `backend-api/src/index.ts` (mount `/api/cyberlab` junto dos outros)
- Test: `backend-api/tests/cyberlabArtifacts.test.ts`

**Interfaces:**
- Consumes: `probeCapabilities()` (Task 2), `getLimits()` (Task 2).
- Produces:
  - `GET /api/cyberlab/providers` — `authenticate + requirePermission('cyberlab.view')` → `{ success:true, data: ProviderStatus }`
  - `POST /api/cyberlab/artifacts` — `cyberlab.manage`; body zod `{ name: z.string().min(1).max(200), contentBase64: z.string() }`; valida tamanho **antes** de decodificar (`(len*3)/4 ≤ maxArtifactBytes` → senão **413** `PAYLOAD_TOO_LARGE`); base64 inválido → 400; grava em `path.join(storageRoot, uuid + ext)` com `storageRoot = process.env.CYBERLAB_STORAGE_DIR || path.join(__dirname,'..','..','storage','cyberlab')` (fora de `public/`), `mkdir recursive`, `sha256` do buffer; INSERT com `original_name` **apenas na BD** (nunca em caminho); audit `cyberlab.artifact_uploaded`; → 201 `{ data: { artifact: { id, sha256, size_bytes, original_name, created_at } } }`
  - `GET /api/cyberlab/artifacts?limit&offset` — `cyberlab.view` → `{ artifacts, total }` (sem `storage_path` no payload)
- Teste: 403 sem permissão; oversize → 413 e **0 ficheiros** no storage root (assert com readdir); base64 inválido → 400 e 0 ficheiros; name `../../etc/passwd` → 201 e o ficheiro criado contém só `[uuid]+ext` (assert no caminho); sucesso → INSERT com sha256 correcto + audit row; probe com `SEEFAST_CLI` vazio → `not_configured`.

- [ ] **Step 1: Teste falhante** (asserções acima) → correr → FAIL
- [ ] **Step 2: Implementar** router + mount
- [ ] **Step 3: Correr → ALL PASS** + `npm run typecheck` + correr também `cyberlabRbac.test.ts` (o 403 da Task 1 passa a exercitar a rota real)
- [ ] **Step 4: Commit** — `feat(cyberlab): endpoints providers e upload de artefactos com limites duros"`

---

### Task 4: jobs runner + rotas de jobs (ciclo de vida)

**Files:**
- Create: `backend-api/src/services/seefast/jobsRunner.ts`
- Modify: `backend-api/src/routes/cyberlab.ts`
- Test: `backend-api/tests/cyberlabJobs.test.ts`

**Interfaces:**
- Consumes: `runOperation`, `JOB_OPS`, `getLimits` (Task 2); tabelas (Task 1).
- Produces (`jobsRunner.ts`):
  - `export async function createJob(input: { type: JobType; artifactId: string }, actorId: number): Promise<{ job: JobRow; started: boolean }>` — valida tipo na allowlist (400 `UNSUPPORTED_OPERATION`), artefacto existe (404), conta `status='running'` < `maxConcurrentJobs` → arranca (INSERT `running`, `started_at=NOW()`, audit `cyberlab.job_started`, `setImmediate` execução) senão INSERT `queued`.
  - `export async function cancelJob(id: string, actorId: number): Promise<'cancelled' | 'not_found' | 'already_finished'>` — se `running`: `cancel_requested=true` + SIGTERM ao `ChildProcess` do Map; se `queued`: directo `cancelled`; audit `cyberlab.job_cancelled` (só quando transiciona).
  - `export async function promoteQueued(): Promise<void>` — chama-se no fim de cada job: promoção FIFO do `queued` mais antigo.
  - Execução: `runOperation` → exit 0 → `completed` + `result={raw}` (JSON parse do stdout guardado como `result`); exit 1/erro → `failed` + `error` sanitizado (≤500 chars, sem paths internos); `truncated` → `partial` com `result.truncated=true`; `timedOut` → `failed` error `TIMEOUT`; sinal de cancel → `cancelled`. **Sem findings nesta task** (hook: chamar `normalizeJobResult` só existe na Task 5 — nesta task, `finalize` guarda `result` e chama `promoteQueued`). finally: apagar temporários do adapter, remover do Map.
  - Consumo de `cancelJob` para jobs que terminam durante o kill → o watcher de `close` do processo decide o estado final (cancel_requested vence).
- Rotas: `POST /jobs` (`cyberlab.manage`) `{type, artifactId}` → 201 job; `GET /jobs?status=&limit=&offset=` (`view`) → `{jobs, total}`; `GET /jobs/:id` (`view`); `POST /jobs/:id/cancel` (`manage`) → 200 `{status}` | 404 | 409 `already_finished`.
- Teste (mock de `runOperation` via require-cache): ciclo `queued→running→completed`; concorrência: 2º job `queued` e promoção ao fim do 1º; cancel de `running` → filho `SIGTERM` (spy) → `cancelled` + sem temporários; cancel de `queued` → `cancelled`; timeout (`timedOut:true`) → `failed`/`TIMEOUT`; tipo inválido → 400; artefacto inexistente → 404; permissões 403 em todas.

- [ ] **Step 1: Teste falhante** → FAIL
- [ ] **Step 2: Implementar** runner + rotas
- [ ] **Step 3: Correr → ALL PASS** + typecheck + re-correr testes anteriores cyberlab
- [ ] **Step 4: Commit** — `feat(cyberlab): jobs com estados reais, concorrência 1, cancelamento e timeout"`

---

### Task 5: `normalize` + findings (persistência e rotas)

**Files:**
- Create: `backend-api/src/services/seefast/normalize.ts`
- Modify: `backend-api/src/services/seefast/jobsRunner.ts` (hook de finalização), `backend-api/src/routes/cyberlab.ts`
- Test: `backend-api/tests/cyberlabFindings.test.ts`

**Interfaces:**
- Produces: `export type NewFinding = { kind: 'fact'|'indicator'|'hypothesis'|'validated_vuln'|'inconclusive'|'false_positive'|'recommendation'; title: string; severity: 'info'|'low'|'medium'|'high'|'critical'; confidence: 'high'|'medium'|'low'; evidence: { source: string; method: string; observed_at: string; limitations: string[]; details: Record<string, unknown> } }`
  + `export function normalizeJobResult(type: JobType, rawStdout: string, truncated: boolean): { ok: true; summary: string; findings: NewFinding[]; limitations: string[] } | { ok: false; reason: 'unparsable' | 'truncated' }`
  - Regras: stdout não-JSON ou `truncated` → `{ok:false}` (**nunca** inventar findings); JSON válido → extrair só campos presentes de verdade (ex.: go: compiler version/modules count; rust: package count; js: module/IPC/native-addon counts) — campo ausente ⇒ sem finding correspondente; `limitations` sempre inclui `"análise estática; sem execução"` + as do output.
  - Runner: em `completed` → `normalizeJobResult`; `ok:false` → rebaixa para `partial` com nota; `ok:true` → INSERT findings (evidence preenchida: `source:'seefast:'+type`, `method:'static:'+type`, data = NOW) e `summary` em `result.summary`.
- Rotas: `GET /findings?kind=&severity=&status=&limit=&offset=` (`view`) → `{findings, total}`; `POST /findings/:id/acknowledge` (`manage`) → 200/404 + audit `cyberlab.finding_acknowledged`.
- Teste com fixtures: (a) fixture `js_evidence.json` → ≥1 finding com kind/confidence/evidence.limitations contendo a frase estática; (b) stdout `'{invalid'` → job `partial`, **0 findings**; (c) `truncated:true` → `partial`, 0 findings; (d) JSON sem campos extraíveis → `completed` com `summary` mas 0 findings (não-crash); (e) endpoints: 403, listagem filtra por kind, acknowledge 200→404 duplo.

- [ ] **Step 1: Teste falhante** → FAIL
- [ ] **Step 2: Implementar** normalize + hook + rotas
- [ ] **Step 3: Correr → ALL PASS** + typecheck + suite cyberlab completa
- [ ] **Step 4: Commit** — `feat(cyberlab): normalização de resultados e findings com evidência e limitações"`

---

### Task 6: export (JSON/CSV) + audit + config

**Files:**
- Modify: `backend-api/src/routes/cyberlab.ts`
- Test: `backend-api/tests/cyberlabExport.test.ts`

**Interfaces:**
- Consumes: `json2csv` (já usado em `routes/reports.ts`), `getLimits`/settings (Task 2).
- Produces:
  - `GET /jobs/:id/export?format=json|csv` — `requirePermission('cyberlab.export')` → job + findings; JSON = objecto completo; CSV = findings (mesmas colunas do padrão `reports.ts`); 400 formato inválido; 404 job.
  - `GET /audit?limit=&offset=` — `cyberlab.view` → `audit_logs WHERE action LIKE 'cyberlab.%' ORDER BY created_at DESC` → `{entries, total}`.
  - `GET /config` (`view`) + `PUT /config` (`manage`) — limites actuais e override via **settings existentes** (chaves `cyberlab_max_artifact_mb`, `cyberlab_job_timeout_s`, `cyberlab_max_concurrent`); PUT valida bounds (≤50MB, 5–600s, 1–4) → 400 fora de bounds; invalida o cache do `getLimits()`.
- Teste: export sem `cyberlab.export` → 403; JSON contém findings reais; CSV tem header correcto; audit só devolve actions `cyberlab.*` (assert com action `hermes_scan` no FakePool a ser excluída); PUT bounds ok → GET reflecte; bounds inválidos → 400.

- [ ] **Step 1: Teste falhante** → FAIL → **Step 2:** Implementar → **Step 3:** ALL PASS + typecheck → **Step 4:** Commit `feat(cyberlab): export JSON/CSV, audit filtrada e configuração de limites"`

---

### Task 7: consola AI (endpoint)

**Files:**
- Modify: `backend-api/src/routes/cyberlab.ts`
- Test: `backend-api/tests/cyberlabConsole.test.ts`

**Interfaces:**
- Consumes: camada AI existente (`src/services/opencode.ts` — reutilizar a mesma função de chamada usada por `routes/hermes.ts` /ai; **não** duplicar nem alterar `opencode.ts`).
- Produces: `POST /ai/plan` — `cyberlab.view`; body zod `{ question: z.string().min(3).max(2000) }`; chama AI com system prompt fixo no route (só propõe, nunca executa; output JSON estrito `{ steps: [{ op: JobType, risk: 'low'|'medium'|'high', needsApproval: boolean }] }`, validado com zod — invalido ou sem fornecedor → `200 { data: { state: 'not_configured' } }` / `state:'invalid_plan'` conforme; **nunca cria jobs** (o client submete cada step via `POST /jobs` normal).
- Teste (mock do serviço AI via require-cache): sem fornecedor → `not_configured`; resposta AI plan válida → `state:'ok'` + steps normalizados; resposta AI não-JSON → `invalid_plan`; permissão 403; **asserção de segurança**: a resposta do plan não contém job criado (FakePool sem INSERT em `cyberlab_jobs`).

- [ ] Steps TDD idênticos; **Commit:** `feat(cyberlab): consola AI experimental — plano estruturado sem auto-execução"`

---

### Task 8: motor local + fixtures reais + teste de integração

**Files:**
- Create: `backend-api/tests/cyberlabIntegration.test.ts`, `backend-api/tests/fixtures/seefast/*.json`, mini-app JS fixture em `backend-api/tests/fixtures/seefast/jsapp/`
- Modify: `.gitignore` (entrada `backend-api/storage/`)

**Interfaces:**
- Consumes: pontos dos Tasks 2-5.
- Regras: **instalação do motor é operação fora do repo** — comandos e fonte verificados com o utilizador e registados **no ledger da sessão** (spec §1.2; nunca escrito no repo). Env `SEEFAST_CLI` colocada no `.env` local (gitignored) ou ambiente da shell.

- [ ] **Step 1: Com o utilizador, instalar o motor** (origem verificada; registo no ledger). `SEEFAST_CLI` definido. Se o utilizador recusar/indisponível → saltar para Step 5 (teste fica SKIP documentado) e reportar `DONE_WITH_CONCERNS`.
- [ ] **Step 2: Capturar fixtures reais** — com o motor instalado: `capabilities --json` → `fixtures/seefast/capabilities.json`; `analyze-javascript-application` sobre a mini-app JS autoral (2-3 ficheiros, incl. referência a módulo nativo) → `fixtures/seefast/js_evidence.json`; se existir binário Go/Rust construído localmente pelo utilizador → capturar `go_evidence.json` / `rust_evidence.json`; caso contrário registar ausência (não inventar).
- [ ] **Step 3: Escrever `cyberlabIntegration.test.ts`** — no topo: `if (!process.env.SEEFAST_CLI) { console.log('SKIP: SEEFAST_CLI não definido — integração real não executada'); process.exit(0); }` (SKIP **explícito**, nunca asserção verde fantasma). Com motor: (a) `probeCapabilities()` → `available:true`; (b) `runOperation('js_analysis', fixtureJsApp)` → exit 0 + stdout JSON parseable; (c) `normalizeJobResult` → ≥1 finding + limitations non-empty; (d) fluxo HTTP completo: upload mini-app → job → poll até `completed` → findings >0.
- [ ] **Step 4: Correr** — sem motor: SKIP visível; com motor: ALL PASS.
- [ ] **Step 5: `.gitignore`** — `backend-api/storage/`; commit `test(cyberlab): teste de integração real com SKIP honesto e fixtures do motor"`

---

### Task 9: frontend — nav, shell, Overview, placeholders, i18n

**Files:**
- Modify: `admin-dashboard/src/components/Layout.tsx` (nav group `cyberlab`, 14 items, todos `permission: 'cyberlab.view'`), `App.tsx` (14 rotas com `PermissionGate`), `i18n/index.tsx` (chaves PT+EN)
- Create: `pages/cyberlab/CyberLabOverview.tsx`, `CyberLabSoon.tsx`, `CyberLabReadonly.tsx`

**Interfaces:**
- Consumes: endpoints Tasks 3-6 (`/providers`, `/jobs`, `/findings`, `/artifacts`, `/config`, `/audit`).
- Produces: rotas `/cyberlab` (Overview), `/cyberlab/analyst`, `/cyberlab/assets`, `/cyberlab/vulns`, `/cyberlab/pentest`, `/cyberlab/re`, `/cyberlab/malware`, `/cyberlab/network`, `/cyberlab/findings`, `/cyberlab/evidence`, `/cyberlab/jobs`, `/cyberlab/integrations`, `/cyberlab/audit`, `/cyberlab/settings`.
  - Overview: cards **reais** de `/providers` + `/jobs?limit=100` (contagens por estado) + `/findings` (por severity) + `/artifacts` recentes; job activo com polling 5s (`useApi` `refreshInterval`).
  - `CyberLabSoon`: recebe `{titleKey, explanationKey}` → badge `Coming Soon` + texto (pentest: fluxo de autorização resumido; malware: sandbox futuro).
  - `CyberLabReadonly`: props `{state: 'available'|'not_configured', stats?…, link?}` — assets/vulns/network mostram contagens read-only vindas dos endpoints existentes (hermes/discovery **só leitura**) ou `Not Configured`.
  - Seção state badge componente `CyberLabStateBadge` (Available/Experimental/Not Configured/Coming Soon).
- i18n: `nav.cyberlab.*` (14) + `cyberlab.*` de todas as páginas — **todos os keys nos dois dicts** (asserção do teste de build = grep `t('` vs dicionários; manual na revisão).

- [ ] **Step 1:** Layout + App + i18n + 3 páginas → `npm --prefix admin-dashboard run build` → OK
- [ ] **Step 2:** PASS de sanidade: nenhum texto hardcoded no JSX novo; 14 rotas respondem (grep de paths no App.tsx)
- [ ] **Step 3:** Commit `feat(admin): menu Cyber Lab com 14 secções, Overview real e estados honestos"`

---

### Task 10: frontend — jobs/upload, job detail, findings, evidence

**Files:**
- Create: `pages/cyberlab/CyberLabJobs.tsx`, `CyberLabJobDetail.tsx`, `CyberLabFindings.tsx`, `CyberLabEvidence.tsx`

**Interfaces:**
- Consumes: `POST/GET /jobs`, `POST /jobs/:id/cancel`, `GET /jobs/:id`, `POST /artifacts`, `GET /findings`, `POST /findings/:id/acknowledge`, `GET /artifacts`, `GET /jobs/:id/export`.
- Jobs: formulário novo job (upload base64 via `FileReader` + name + type select só com os 3 tipos) → cria artefacto → cria job; fila com `DataTable`/`StatusBadge` (estados do backend) e polling 3s enquanto existir `running`; cancel real.
- JobDetail: `result` (JSON formatado), summary, findings do job, botões Export JSON/CSV (`cyberlab.export` → mostrar botão só se `hasPermission`), Cancel, badge `truncated`.
- Findings: filtros kind/severity/status + acknowledge; `line-clamp` + `title` no evidence.details.
- Evidence: lista de artefactos (sha256, size, data) + acesso a exports.
- [ ] Steps TDD? Frontend sem testes unitários no repo (padrão: build + revisão) → `npm --prefix admin-dashboard run build` OK + i18n paridade.
- [ ] Commit `feat(admin): páginas de jobs, findings e evidência do Cyber Lab"`

---

### Task 11: frontend — integrations, settings, audit, consola AI

**Files:**
- Create: `pages/cyberlab/CyberLabIntegrations.tsx`, `CyberLabSettings.tsx`, `CyberLabAudit.tsx`, `CyberLabAnalyst.tsx`
**Interfaces:**
- Integrations: `GET /providers` → estado + detail; `Not Configured` mostra instruções genéricas ("definir `SEEFAST_CLI`" — sem proveniência).
- Settings: `GET/PUT /config` (PUT só com `cyberlab.manage`; bounds do backend mostrados como ajuda).
- Audit: `GET /audit` paginado.
- Analyst: textarea + `POST /ai/plan` → states `ok|not_configured|invalid_plan`; `ok` mostra passos com badges de risco + botão "Executar passo" por step → `POST /jobs` (upload prévio obrigatório: o form de artefacto vive no topo da consola ou redireciona a /cyberlab/jobs) — nota de que risco `medium|high` marca `needsApproval` e nesta spec F5 ainda `Coming Soon` (botão disabled com tooltip).
- [ ] Build OK + i18n → Commit `feat(admin): integrations, settings, audit e consola AI do Cyber Lab"`

---

### Task 12: docs + proveniência + regressão total (Fase F)

**Files:**
- Create: `docs/cyberlab.md` (instalação/configuração/operação: `SEEFAST_CLI`, `CYBERLAB_*` limites, 4 estados, 3 operações suportadas, fluxo de jobs — **sem qualquer identificação do motor original**)
- Verify-only: repo inteiro

- [ ] **Step 1: Suite backend completa** — `npm --prefix backend-api test` (21+7 novas) + `npm --prefix backend-api run typecheck` → verdes
- [ ] **Step 2: Builds** — `npm --prefix site run build` + `npm --prefix admin-dashboard run build` → OK
- [ ] **Step 3: Proveniência** — grep dos padrões registados **no ledger da sessão** (fora do repo) sobre `git ls-files` → **0 ocorrências** (incl. `package.json`, docs, UI, planos? — planos/spec em `docs/superpowers/**` incluídos; os padrões ficam no ledger justamente para não entrarem no repo)
- [ ] **Step 4: Regressão funcional** — smoke: arranque local da API (`npx tsx src/index.ts`), `GET /health` 200, `/api/cyberlab/providers` 401 anónimo, landing `/` 200, docs 200 (nada do site partido)
- [ ] **Step 5: `docs/cyberlab.md`** + commit `docs(cyberlab): instalação, configuração e operação do Cyber Lab"`
- [ ] **Step 6: Relatório final** ao utilizador (spec §14: 10 pontos) — sem criar ficheiros de docs extra

---

### Task 13: provisionamento em produção (opcional — só com aprovação do utilizador)

**Files:**
- Modify: `backend-api/Dockerfile` (hook genérico) — **só** se o utilizador aprovar deploy
- [ ] **Step 1:** Hook de arranque genérico e não-identificável: variável `SEEFAST_ENGINE_PKG` (valor definido **no painel Render**, nunca no repo) + script de entrypoint que a instala silenciosamente ao arrancar se `SEEFAST_CLI` apontar para o resultado; sem o env → nada instalado (comportamento actual preservado).
- [ ] **Step 2:** Deploy + verificação: `/health` 200, `/api/cyberlab/providers` com motor `available:true`, 1 job real do mini-app a `completed`.
- [ ] **Step 3:** Se a verificação falhar → rollback (re-deploy do commit anterior) e reportar como pendente. Commit `feat(cyberlab): hook de instalação genérico do motor externo em produção`

**Nota do plano:** sem aprovação do utilizador, a Task 13 fica fora — o produto funciona em `Not Configured` no servidor e a validação real da integração faz-se localmente (Task 8).

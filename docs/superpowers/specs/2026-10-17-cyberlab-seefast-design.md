# Design Spec — Cyber Lab (motor "seefast") — Spec 1 de F1+F2+F3+F4a

- **Data:** 2026-10-17
- **Estado:** Aprovado pelo utilizador (design por secções, 6/6 "ok")
- **Âmbito desta spec:** Fase 1 (auditoria, concluída neste ciclo) + Fase 2 (fundação) + Fase 3 (menu Cyber Lab) + Fase 4a (primeira capacidade real de análise estática)
- **Specs seguintes (fora do âmbito):** F5 (testes activos autorizados), F6 (correlação profunda + Asset Intelligence), F4b+ (APK/Android, sandbox, malware), lab node

## 1. Intenção e regras de produto

O EndpointX ganha um subsistema **Cyber Lab**: investigação técnica, análise de artefactos e avaliação de segurança com evidência verificável, no dashboard administrativo, sobre um motor de análise externo designado internamente **`seefast`**.

Regras vinculativas (pedido do utilizador):

1. **Preservar o projecto existente.** Nada de substituir/remover/desactivar funcionalidades actuais; reutilizar auth, RBAC, audit, AI, scheduler, testes e padrões de UI existentes. Nenhuma segunda implementação do que já existe.
2. **Invisibilidade da proveniência.** O nome/tecnologia original do motor **não aparece em nenhum artefacto público**: nem UI, nem docs do repo, nem relatórios, nem mensagens de erro, nem `package.json`. O motor é tratado como **binário externo fornecido pelo operador** (padrão "caller-supplied"), configurado por env var `SEEFAST_CLI`. Licença MIT: o motor é executado em serviço (SaaS), **não é distribuído** — não há publicação de atribuição; **se no futuro houver distribuição** da imagem ou dos binários, criar então `THIRD_PARTY_NOTICES` com a atribuição MIT como pré-requisito de distribuição (registado como risco residual na secção 9).
3. **Estados honestos.** Secções não implementadas mostram `Coming Soon`/`Not Configured`/`Experimental` com explicação; zero métricas inventadas, zero botões que não executam, zero resultados simulados.
4. **Só análise estática nesta spec.** Nenhum caminho de código executa amostras. O conjunto de operações expostas é estático por construção.
5. **Zero dependências npm novas** no backend.

## 2. Decisões de âmbito (questões de brainstorming)

| # | Decisão |
|---|---------|
| P1 | Começar pela **fundação** (adapter + provedores + modelos + controlos + menu), antes de capacidades avançadas |
| P2 | Motor corre **estático-leve no servidor API** (Docker Render) com limites duros; interface de "lab node" externo desenhado desde já (Coming Soon), sem código morto |
| P3 | Primeira capacidade real: **análise estática de JavaScript/Electron + inspecção de binários Go/Rust (ELF/PE built-in)** — sem motores nativos pesados |
| P4 | Spec 1 cobre F1+F2+F3+F4a; F5/F6/F4b+ em specs seguintes |
| Arquitectura | **Abordagem 1 — subsistema com costuras de reutilização**: menu/tabelas próprios onde os modelos diferem; reutilização total de RBAC, audit, AI, scheduler, testes |

## 3. Arquitectura e componentes

```
admin-dashboard                     backend-api
┌─────────────────┐   /api/cyberlab/*  ┌──────────────────────────────────────┐
│ CyberLabPage     │ ─────────────────► │ routes/cyberlab.ts                  │
│  (nav group      │                    │  authenticate + requirePermission   │
│   próprio,       │   polling jobs     │  ├─ providers.ts  (sonda capacidades)│
│   14 secções)    │ ◄───────────────── │  ├─ jobsRunner.ts (exec/cancel/limit)│
│  + Consola AI    │                    │  └─ seefast/adapter.ts              │
└─────────────────┘                    │       └─ execFile($SEEFAST_CLI, argv)│
                                       │          stdout JSON → NormalizedResult│
                                       └──────────────────────────────────────┘
```

- **`backend-api/src/services/seefast/`** — 4 módulos:
  - `adapter.ts` — invoca o CLI externo com `execFile` (argv array, nunca shell), argv validado por allowlist por `job.type`, timeout + kill, parsing de stdout JSON.
  - `capabilities.ts` — sonda do host (versão + alvos suportados), cacheada; ausência de `SEEFAST_CLI` → estado `Not Configured`.
  - `normalize.ts` — JSON do motor → `NormalizedResult { status, summary, evidence[], limitations[], rawRef }`.
  - `limits.ts` — limites via env com defaults: artefacto ≤25MB, job ≤120s, concorrência 1 (FIFO), stdout ≤5MB truncado com marca.
- **Runner de jobs** — `jobsRunner.ts` no padrão in-process do repo (`jobs.ts`/`setImmediate(runScan)` do HERMES): estados reais `queued → running → completed | failed | cancelled | partial`; cancelamento = flag em BD + SIGTERM ao processo filho + limpeza de temporários. Sem Redis/queues externas (infra não existe; não inventar).
- **Montagem** — `index.ts` com `app.use('/api/cyberlab', cyberlabRoutes)`, estilo/envelope `{ success, data }` iguais aos routes existentes.
- **Lab node (futuro)** — `capabilities.ts` expõe já o conceito de "executor local" (host remoto configurável) sem implementação; UI marca Coming Soon.

## 4. Modelo de dados

Tabelas novas (DDL inline idempotente em `database.ts`):

```sql
cyberlab_jobs        -- id UUID, type, status (queued|running|completed|failed|cancelled|partial),
                     -- target_ref, params JSONB, plan JSONB, result JSONB, error,
                     -- progress INT, cancel_requested BOOL,
                     -- started_by, approval_ref (NULL nesta spec; exigência activa na F5),
                     -- created_at, started_at, finished_at
cyberlab_artifacts   -- id UUID, sha256, original_name, size_bytes, content_type,
                     -- storage_path (directório fora do web root, path gerado pelo servidor),
                     -- uploaded_by, created_at, retained_until
cyberlab_findings    -- id UUID, job_id FK, kind (fact|indicator|hypothesis|validated_vuln|
                     --   inconclusive|false_positive|recommendation),
                     -- title, severity, confidence (high|medium|low),
                     -- evidence JSONB (fonte, método, data, activo, limitações),
                     -- asset_ref (NULL nesta spec; ligação a devices/hermes_assets = F6),
                     -- status (open|acknowledged|remediated)
cyberlab_scopes      -- id UUID, name, targets (lista), exclusions, allowed_methods JSONB,
                     -- active BOOL  -- criada já, populada mínima; base do fluxo de autorização (F5)
```

Reutilização (sem duplicar):

- **Audit** — tabela global `audit_logs` com actions `cyberlab.job_started|job_cancelled|artifact_uploaded|finding_acknowledged|scope_changed` (não criar um terceiro canal de audit).
- **Permissões** — nova category `cyberlab` no `allPerms`: `cyberlab.view`, `cyberlab.manage` (iniciar/cancelar), `cyberlab.approve` (F5, admin-only), `cyberlab.export` (relatórios). Repair-loop admin distribui a BDs existentes; **não** entra em `SEED_ROLE_PERMISSIONS`.
- **Settings** — configuração/limites do seefast no sistema `settings` existente.
- **Upload** — sem dependência nova: `POST` com corpo base64 ≤25MB, validado, escrito com `fs.writeFile` em directório fora do web root.

Proibido tocar em: `hermes_*`, `devices`, discovery, rotas de agentes — zero regressão nesses domínios.

## 5. Segurança e controlo de acesso

- Todo o `/api/cyberlab/*` com `authenticate` + `requirePermission`; `PermissionGate` só esconde UI. Tentativas negadas ficam no audit (middleware existente).
- **Runner em jaula**: `execFile` com argv array (nunca shell/interpolação); path do CLI só de env var; cada `job.type` tem schema zod próprio e allowlist de argumentos.
- **Sem SSRF**: nenhuma operação desta spec faz fetch de URLs; jobs referenciam artefactos por FK, nunca por caminho do cliente.
- **Path traversal impossível**: caminhos de armazenamento gerados pelo servidor (UUID+sha), input de caminho nunca aceite.
- **Limites**: 25MB, 120s (env-tuneável), concorrência 1, stdout 5MB truncado, kill real no cancel.
- **Segredos**: `SEEFAST_CLI` lido uma vez no boot; output do motor sanitizado antes de persistir; nada de credenciais nos logs.
- **Tenant/visibilidade**: jobs e artefactos com `started_by`; visibilidade por papel (padrão forensics).
- A IA nunca executa por si: propostas da consola submetem-se pelos **mesmos endpoints e validação** que um Start manual.

## 6. Interface — menu Cyber Lab (14 secções)

Nav group `"cyberlab"` no `Layout.tsx`, route base `/cyberlab`, `PermissionGate` por `cyberlab.view`. Página-mãe `CyberLabPage.tsx` com Overview + navegação (padrão de tabs do HermesPage); sub-rotas para listas paginadas.

| Secção | Estado nesta spec |
|---|---|
| Overview | **Available** — cards reais: estado do motor, jobs por estado, findings por severidade, artefactos recentes |
| AI Security Analyst | **Experimental** — consola: pergunta → plano estruturado → sumários; sem auto-execução |
| Asset Intelligence | **Not Configured (F6/F4b)** — se houver, contagem read-only de `hermes_assets`/`network_nodes` com link; sem duplicar |
| Vulnerability Assessment | **Available (limitado)** — só findings de vulns dos jobs do Cyber Lab + link ao motor CVE do HERMES |
| Authorized Penetration Testing | **Coming Soon (F5)** — explica o fluxo de autorização; botões desactivados |
| Reverse Engineering | **Available** — fila e detalhe de jobs de análise estática (JS/Electron, Go/Rust) |
| Malware Analysis | **Coming Soon (F4b/sandbox)** — honesto, sem botão inoperante |
| Network Security | **Available (read-only)** — dados reais de discovery/HERMES com link; nenhum scanner novo |
| Security Findings | **Available** — tabela `cyberlab_findings`, filtros kind/severity, acknowledge |
| Evidence & Reports | **Available** — evidência crua + limitations por job; export JSON/CSV (padrão `reports.ts`) |
| Scan Jobs | **Available** — fila `cyberlab_jobs`, polling 3-5s, cancel real |
| Integrations & Providers | **Available** — sonda: motor detectado? versão? alvos suportados? + instruções `Not Configured` |
| Audit Trail | **Available** — `audit_logs` filtrada a `cyberlab.*` |
| Settings | **Available** — limites via `settings`, admin |

Cada secção: badge de estado + explicação do porquê. i18n PT **e** EN completo desde o início (todas as chaves nos dois dicts).

## 7. Fluxo operacional e Consola AI

Fluxo desta spec (subconjunto honesto do fluxo de 12 passos do vision):

1. Admin abre Cyber Lab → Overview com estado real
2. Sobe artefacto (base64 ≤25MB) ou escolhe job type
3. Validação: `cyberlab.manage`, artefacto existe, tipo allowlistado, concorrência respeitada
4. Plano: determinístico para jobs estáticos simples (op, alvo, limites, impacto "estático, ≤120s"); consola AI compõe planos multi-step
5. Aprovação: jobs estáticos de baixo risco iniciados por Start humano (`approval_ref` NULL); exigência de aprovação explícita activa-se em F5
6. Execução `running` com progresso real do adapter
7. Validação do resultado (exit code + JSON parseable) → `completed|failed|partial`
8. Normalização → `cyberlab_findings` + evidência crua preservada
9. UI apresenta findings com kind, confidence, limitações, fonte, data
10. Export de relatório + audit em `audit_logs`

**Consola AI (Experimental):** `POST /cyberlab/ai/plan` → camada AI existente (`services/opencode.ts`, providers já configuráveis) com system prompt restrito: só propõe, nunca executa; saída estruturada `{steps:[{op, target, risk, needsApproval}]}`; "Executar plano" submete cada step como job normal (mesmo code path de validação). Sem fornecedor → `Not Configured`.

Classificação obrigatória nas conclusões: `fact | indicator | hypothesis | validated_vuln | inconclusive | false_positive | recommendation | action_executed` (o campo `kind` de findings cobre o subconjunto persistido; `action_executed` corresponde aos jobs/audit).

## 8. Testes (TDD, padrão FakePool do repo)

- `tests/cyberlabRbac.test.ts` — 403 sem permissões; repair-loop concede novos códigos; seed `user` não os ganha
- `tests/cyberlabJobs.test.ts` — ciclo de vida completo; falha do motor → `failed` + erro sanitizado; cancelamento (flag→kill→`cancelled`+limpeza); concorrência (2º job `queued`); timeout; oversize → 4xx; tipo não-allowlistado → 400
- `tests/cyberlabProviders.test.ts` — `SEEFAST_CLI` ausente → `Not Configured` sem spawn; sonda inválida → estado de erro honesto
- `tests/cyberlabFindings.test.ts` — fixture JSON → findings correctos; JSON malformado → `partial`, zero findings inventados
- `tests/cyberlabConsole.test.ts` — plano AI sem fornecedor → `Not Configured`; plano só cria jobs pelo caminho normal
- **Fixtures próprias** no repo (mini app JS, binário Go mínimo) — zero ataques a sistemas reais; adapter mockado na fronteira
- **1 teste de integração real** corre só com `SEEFAST_CLI` presente; caso contrário **SKIP explícito com aviso** — nunca afirmar integração sem ela
- Regressão: chain `npm test` existente verde + `typecheck` + `admin build`

## 9. Deployment

- Env var `SEEFAST_CLI` (path absoluto do binário do motor) no Render; sem ela o serviço sobe normalmente e o Cyber Lab mostra `Not Configured`.
- Motor instalado **fora do repo** (imagem Docker interna ou host); o repo público não contém o nome do motor, scripts de instalação nem dependência npm.
- **Risco residual de licença:** como o motor corre em serviço próprio (sem distribuição de cópias), não há obrigação activa de atribuição pública; **antes de qualquer distribuição futura** da imagem/binários, gerar `THIRD_PARTY_NOTICES` com a atribuição MIT (pré-requisito de distribuição, fora do repo até lá).
- Docs de operação: secção de configuração na documentação interna (`SEEFAST_CLI`, limites, estados) — sem proveniência pública.

## 10. Fora do âmbito (specs seguintes)

- F5 — testes activos autorizados (scopes efectivamente populados, aprovação obrigatória, janelas de manutenção, interrupção)
- F6 — correlação profunda HERMES (asset_ref populado, dedup com `hermes_findings`, Asset Intelligence completo)
- F4b+ — APK/JADX, análise dinâmica em sandbox isolada, malware, lab node (executor remoto)
- Remediação com verificação pós-correcção

## 11. Critérios de aceitação (spec 1)

- Menu Cyber Lab integrado no dashboard existente (nav group + i18n PT/EN)
- Permissões `cyberlab.*` verificadas no backend em todos os endpoints
- Integração do seefast validada com ≥1 ferramenta realmente operacional (JS/Electron + Go/Rust), com teste de integração real ou SKIP honesto
- Secções indisponíveis identificadas com estados claros
- Operações reais de análise estática (não componentes visuais)
- Jobs com estados, logs, erros e cancelamento real
- Findings com evidência e limitações
- Testes de regressão executados e verdes
- Docs de instalação/configuração (sem proveniência do motor)
- Nenhuma funcionalidade existente removida ou desactivada

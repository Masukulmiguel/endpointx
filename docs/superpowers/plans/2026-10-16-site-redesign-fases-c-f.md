# Site Redesign — Fases C–F Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completar o redesign do site EndpointX: documentação própria gerada (12 páginas PT/EN via `build-docs.mjs`), backend público (stats + contactos + protecção de downloads + redirects), admin (página Contactos + links de download com token) e verificação final.

**Architecture:** O site novo (Fase B, já no repo em `site/`) é um MPA Vite+Tailwind que builda para `backend-api/public/site` — o directório que a imagem Docker da API serve estáticamente em `endpointx.onrender.com` (mesma origem do `/api`). A Fase C gera páginas de docs estáticas a partir de markdown (`site/content/docs/{pt,en}/<slug>.md` → `site/docs/<slug>.html` + `site/en/docs/<slug>.html` + `public/search-index.json`). A Fase D adiciona `routes/public.ts` (`/api/public/stats`, `/api/public/contact`), tabelas `contacts` + `download_events`, o gate `requireDownloadAccess` nos binários públicos, e redirects 301 de URLs `.html` para canónicas.

**Tech Stack:** Node 20, Express 4 + zod + express-rate-limit, pg, TS (tsx runner, testes `assert` estilo `tests/installAccess.test.ts`), Vite 5 MPA, Tailwind 3, `marked` ^14 (já em devDependencies — **zero dependências novas**), React 19 admin (padrões existentes: `useApi`, `DataTable`, `Pagination`, `useI18n`).

**Spec:** Contratos firmados pelo repo em árvore — `site/package.json` (scripts chamam `scripts/build-docs.mjs`), `site/public/sitemap.xml` (12 URLs exactas), `site/src/css/main.css:1260-1549` (classes de docs), `site/.gitignore` (saídas geradas), `site/src/js/main.js:120-158` (payload esperado de `/api/public/stats`), `site/src/js/contact.js:36` (`POST /api/public/contact`), decisões do utilizador (2026-10-16): `requireDownloadAccess` = **gate + contador**; permissão de Contactos = **`contacts.view` nova**.

## Global Constraints

- Idioma: conteúdo do site em **PT-PT** com tradução **EN completa** (paridade 1:1 de slugs e secções).
- **Zero links `github.com` em `site/` e nos 12 markdowns** — a landing promete «Sem saltos para repositórios externos» (i18n `docs.lead`). Excepción única e intencional: `admin-dashboard/src/pages/InstallPage.tsx` (método Git), reportada no Fase F, não alterada.
- Stats públicas **nunca inventam valores**: campos não calculáveis → omitir; front-end mostra «Dados indisponíveis».
- Não adicionar dependências npm em nenhum dos três packages.
- Commits incrementais conventional commits na branch `feat/site-redesign`; o **output de build do site (`backend-api/public/site/**`) é commitado** (a imagem Docker copia `backend-api/` tal como está no repo — `backend-api/Dockerfile:13`).
- Testes backend: runner `tsx` + `assert` + FakePool (copiar estrutura de `tests/installAccess.test.ts`); sempre com `closeAllConnections` no finally.
- Backend: manter shape `{ success, data }` / `{ success: false, error: { message, code } }`.

## Review Focus

1. **Ordem de build:** `build-docs.mjs` tem de correr antes do `vite build` (já garantido por `site/package.json`) — se falhar, Tailwind purga classes de docs e o Vite não inclui as HTML como entries. Verificar sempre com `npm run build` completo, nunca só `node scripts/build-docs.mjs`.
2. **`emptyOutDir` em `backend-api/public/site`:** o Vite apaga só esse subdirectório; `install.ps1`, `apk/`, `exe/` vivem em `backend-api/public/` (raiz) e estão seguros — qualquer refactor de paths que os mova para dentro de `site/` partiria os endpoints públicos. Teste `downloadAccess.test.ts` porta isso.
3. **`requireDownloadAccess` não pode partir fluxos vivos:** `install.ps1`/`install-linux.sh` mantêm o seu `requireEnrollToken` actual; mobile page/APK usamfluxos do InstallPage que passam a carregar `?t=`. Só `endpointx.exe` e `endpointx-agent.apk` mudam de anónimos para gated.
4. **Redirects sem loop e antes do static:** middleware `.html → 301 strip` corre antes de `express.static`; `/index.html → /`; paths já limpos não re-encaminham. `extensions: ['html']` continua a resolver `/docs/<slug>`.
5. **Paridade sitemap ↔ ficheiros gerados:** os 12 `<loc>` do sitemap têm de corresponder 1:1 a ficheiros gerados (verificação scriptada no Task 6); hreflang bidireccional em cada página (PT↔EN).

---

### Task 0: Limpeza + baseline commit (Fase A/B por commitar)

**Files:**
- Delete: `True` (ficheiro lixo, output binário de um redirect de stderr git)
- Stage: todo o working tree actual (`site/` untracked, deleções em `backend-api/public/site/`)

**Interfaces:**
- Consumes: estado actual do repo (branch `feat/site-redesign`, HEAD `4f240a0`).
- Produces: baseline commit; working tree limpo para as fases seguintes.

- [ ] **Step 1: Remover o ficheiro `True`**

```powershell
Remove-Item -LiteralPath 'True'
```

- [ ] **Step 2: Stage e commit do baseline**

```powershell
git add -A
git commit -m "feat(site): redesign baseline — fonte Vite+Tailwind em site/, retira site estático legado de backend-api/public/site"
```

Expected: commit único; `git status` limpo (excepto `node_modules` ignored).

- [ ] **Step 3: Verificar**

Run: `git status --short; git log --oneline -2`
Expected: limpo; topo = mensagem acima.

---

### Task 1: Fase C — pipeline `build-docs.mjs` + fatia vertical «visao-geral» PT/EN

**Files:**
- Create: `site/scripts/build-docs.mjs`
- Create: `site/scripts/docs-template.html`
- Create: `site/src/js/docs.js`
- Create: `site/content/docs/pt/visao-geral.md`
- Create: `site/content/docs/en/visao-geral.md`

**Interfaces:**
- Consumes: classes CSS em `site/src/css/main.css:1260-1549` (`.docs-layout`, `.docs-side`, `.docs-search`, `.docs-nav-title`, `.docs-main`, `.docs-lang`, `.docs-lead`, `.docs-body`, `.code-block`, `.copy-btn`, `.docs-callout`, `.docs-toc`, `.docs-footer-nav`, `.docs-empty`); shell do site em `site/index.html:36-61` (header) e footer do mesmo ficheiro; `window.EndpointXSite` de `src/js/i18n.js`.
- Produces (contrato exacto):
  - `site/docs/<slug>.html` e `site/en/docs/<slug>.html` para cada slug da lista fixa `['visao-geral','instalacao','agentes','discovery','seguranca','faq']` (mesma ordem do sitemap e da footer-nav).
  - `site/public/search-index.json`: array `[{ lang: 'pt'|'en', slug, title, lead, url: '/docs/<slug>'|'/en/docs/<slug>', headings: [{ id, text }], text: string }]` (texto corrido sem markdown, truncado a 2000 chars/página).
  - Markdown com frontmatter: `---\ntitle:\nlead:\ndescription:\n---` (parser manual de linhas, sem YAML dep).
  - HTML de docs inclui: canonical `https://endpointx.onrender.com/docs/<slug>` (EN: `/en/docs/<slug>`), `hreflang` alternates PT+EN, og tags, meta description (do frontmatter), `<html lang="pt-PT"|"en" data-theme="dark">`, scripts `/src/js/i18n.js` e `/src/js/docs.js`.
  - Sidebar: input `.docs-search` (+ placeholder localizado), título `.docs-nav-title`, nav com 6 links e `class="active"` na página corrente, `div.docs-empty` escondida.
  - TOC `.docs-toc` a partir dos `##` do markdown; footer-nav prev/next pela ordem de slugs; lang-switch `.docs-lang` liga à página homóloga do outro idioma.
  - Fenced code → `<div class="code-block"><button class="copy-btn" type="button">Copiar</button><pre><code>…` ; blockquote `> **Nota:** …` → `<div class="docs-callout"><strong>Nota:</strong> …</div>`; heading ids slugificados injectados por pós-processo do HTML renderizado.
  - `docs.js`: nav-toggle do header, delegate de click em `.copy-btn` (clipboard + feedback «Copiado»), search client-side — fetch `/search-index.json` (caminho **absoluto**), filtra links da sidebar por `lang` actual + título/lead; zero resultados com query não vazia → mostra `.docs-empty`.

- [ ] **Step 1: Escrever os 2 markdowns de «visao-geral» (PT e EN)**

Outline idêntico em ambos (paridade de secções): `## O que é o EndpointX` · `## Arquitectura em 4 camadas` (agentes → API Express → PostgreSQL → dashboard React) · `## Conceitos-chave` (utilizador/sessão, dispositivo/agente, enrolamento, heartbeat) · `## Áreas do painel` (Dashboard, Dispositivos, Rede/Descoberta, HERMES, Segurança, Definições) · `## Estado do desenvolvimento` (1.3.0 early access; marcador honesto do que está em construção). Factos: colher de `docs/architecture.md`, `README.md`, landing actual (`site/src/js/i18n.js`). Sem números de clientes/certificações.

- [ ] **Step 2: Escrever `scripts/docs-template.html`**

Template com placeholders `{{…}}` (exactos): `lang`, `title`, `description`, `canonical`, `hreflang_pt`, `hreflang_en`, `nav_docs_label`, `search_placeholder`, `side_title`, `sidebar`, `lang_switch_href`, `lang_switch_label`, `lead`, `toc`, `body`, `prev_href`, `prev_label`, `next_href`, `next_label`, `copy_label`, `year`. Header/footer replicam o shell de `site/index.html` (brand, nav, lang-switch PT/EN como **links** para as páginas homólogas, theme-btn, Entrar/Registar, nav-toggle). Cabeçalho da main: h1 = `{{title}}`, `p.docs-lead` = `{{lead}}`, `{{toc}}`, `div.docs-body` = `{{body}}`.

- [ ] **Step 3: Escrever `scripts/build-docs.mjs`**

Semântica: lê os slugs da lista fixa; para cada idioma parseia frontmatter + `marked.parse(md, { gfm: true })`; pós-processa headings com ids; extrai h2 para TOC; envolve code/callout; preenche template; escreve outputs (mkdir -p); escreve `public/search-index.json`. Falha com `process.exitCode = 1` + mensagem se faltar um md de um slug (paridade obrigatória). Idiomas e paths como no bloco Interfaces.

- [ ] **Step 4: Escrever `src/js/docs.js`**

IIFE no estilo dos outros JS do site (sem bundler). Como especificado no bloco Interfaces (toggle, copy, search).

- [ ] **Step 5: Correr o gerador e verificar a fatia**

```powershell
node site/scripts/build-docs.mjs
Get-ChildItem site/docs, site/en/docs, site/public/search-index.json
```
Expected: `visao-geral.html` em ambos + JSON válido com 2 entradas.

- [ ] **Step 6: Build Vite completo e smoke-check**

```powershell
npm --prefix site run build
Test-Path backend-api/public/site/docs/visao-geral.html, backend-api/public/site/en/docs/visao-geral.html, backend-api/public/site/search-index.json
```
Expected: os 3 paths truthy; HTML final referencia `assets/*` hashed.

- [ ] **Step 7: Commit**

```powershell
git add site/scripts site/src/js/docs.js site/content backend-api/public/site
git commit -m "feat(docs): build-docs.mjs + template + docs.js, fatia visao-geral PT/EN"
```

---

### Task 2: Fase C — restantes 10 markdowns (5 tópicos × PT/EN)

**Files:**
- Create: `site/content/docs/pt/{instalacao,agentes,discovery,seguranca,faq}.md`
- Create: `site/content/docs/en/{instalacao,agentes,discovery,seguranca,faq}.md`
- Regenerate: `backend-api/public/site/**` (output commitado)

**Interfaces:**
- Consumes: pipeline do Task 1 (falha se paridade PT/EN incompleta); dossier factual: `docs/INSTALL-GUIDE.md`, `docs/deployment.md`, `docs/security.md`, `docs/api.md`, código de `backend-api/src/routes/devices.ts` (enrolamento, heartbeat), `src/services/installRequests.ts`, `src/routes/network.ts` (descoberta), `src/middleware/auth.ts` + `mfa` (sessões/MFA/auditoria), gate novo do Task 4 («protecção de downloads» — descrever como: downloads de binários exigem token de enrolamento ou sessão autorizada).
- Produces: 10 ficheiros; 12 páginas geradas; search-index com 12 entradas.

Outlines (h2, idênticos PT/EN):
- **instalacao**: `## Requisitos` · `## Criar conta e obter o token` · `## Windows (PowerShell)` · `## Linux e macOS` · `## Telemóvel (Android/iOS)` · `## Verificar que o dispositivo entrou` · `## Actualizações`
- **agentes**: `## O que é o agent` · `## Enrolamento e estado PENDING` · `## Heartbeat e limiares` · `## Tokens (enrolamento vs sessão)` · `## Comandos remotos` · `## Desinstalar/actualizar`
- **discovery**: `## O que é a Network Discovery` · `## Intervalos CIDR autorizados` · `## Correr uma descoberta` · `## Fila de revisão (aprovar/ignorar)` · `## Do nó ao pedido de instalação` · `## NetSentinel/NAC (em desenvolvimento)`
- **seguranca**: `## Sessões e tokens` · `## MFA` · `## Funções e permissões` · `## Registos de auditoria` · `## Protecção de downloads` · `## O que o EndpointX não recolhe`
- **faq**: 10–14 perguntas curtas (preço/early access, requisitos, SO suportados, mobile, offline, dados recolhidos, HERMES ofensivo?, como parar um scan, multi-admin, backup BD, português/inglês, suporte via /contacto)

Regras de conteúdo: comandos copiáveis exactos aos do InstallPage/backend (ex. `irm …/api/devices/public/install.ps1?t=… | iex`); **sem URLs github.com**; marcar honestamente o que está em desenvolvimento.

- [ ] **Step 1: Escrever os 10 markdowns** (paridade de secções PT/EN verificada visualmente)
- [ ] **Step 2: Gerar + build**

```powershell
node site/scripts/build-docs.mjs
(Get-ChildItem site/docs/*.html).Count; (Get-ChildItem site/en/docs/*.html).Count
npm --prefix site run build
```
Expected: `6` e `6`; build OK.

- [ ] **Step 3: Paridade sitemap**

Run: comparar os 12 `<loc>` de `site/public/sitemap.xml` com os 12 ficheiros gerados (paths sem `.html`).
Expected: correspondência exacta.

- [ ] **Step 4: Commit**

```powershell
git add site/content backend-api/public/site
git commit -m "feat(docs): 12 guias PT/EN gerados a partir do dossier factual do sistema"
```

---

### Task 3: Fase D — tabelas `contacts`/`download_events` + `routes/public.ts`

**Files:**
- Modify: `backend-api/src/config/database.ts` (schema inline, junto às outras tabelas; e índices)
- Create: `backend-api/src/routes/public.ts`
- Modify: `backend-api/src/index.ts` (mount `/api/public` + limiter próprio para contact)
- Create: `backend-api/tests/publicApi.test.ts`
- Modify: `backend-api/package.json` (acrescentar `&& tsx tests/publicApi.test.ts` ao fim da chain `test`)

**Interfaces:**
- Consumes: `query` de `src/config/database`; `JWT`/constantes; padrão de rotas (ex. `src/routes/settings.ts`).
- Produces:
  - Tabelas (DDL idempotente no schema existente; `uuid-ossp`/`pgcrypto` já criados em `database.ts:77-78`):
    ```sql
    CREATE TABLE IF NOT EXISTS contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      ip_address VARCHAR(45),
      user_agent TEXT,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(created_at DESC);
    CREATE TABLE IF NOT EXISTS download_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kind VARCHAR(30) NOT NULL,
      ip_address VARCHAR(45),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_download_events_created_at ON download_events(created_at);
    ```
  - `GET /api/public/stats` (sem auth) → `200 { success: true, data: { version, devices, online, users, downloads, updated_at } }`
    - `version`: `JSON.parse(readFileSync(join(__dirname,'..','..','package.json'),'utf8')).version` (carga única no topo do módulo).
    - `devices` = `COUNT(*) FROM devices`; `online` = `COUNT(*) FROM devices WHERE last_heartbeat > NOW() - INTERVAL '24 hours'`; `users` = `COUNT(*) FROM users`; `downloads` = `COUNT(*) FROM download_events`; `updated_at` = `new Date().toISOString()`. Todos os counts `parseInt`.
    - Rate limiter próprio: `windowMs: 60_000, max: 30`.
  - `POST /api/public/contact` (sem auth) — zod: `name` string trim 2..100, `email` `.email()`, `message` 10..5000. Sucesso → `INSERT INTO contacts (name,email,message,ip_address,user_agent) VALUES (…) RETURNING id` → `201 { success:true, data:{ id } }` + audit log (`action:'contact_message_received'`, `target_type:'contact'`, `target_id:id`, description com email). Falha zod → `400` via formato `error.details` do errorHandler. Rate limiter próprio: `windowMs: 15*60_000, max: 5`.
  - Mount: `app.use('/api/public', publicRoutes)` em `index.ts` junto dos outros mounts.

- [ ] **Step 1: Escrever o teste falhante `tests/publicApi.test.ts`** (FakePool por conteúdo SQL, como `installAccess.test.ts`): stats → 200 + `data.version === package.json.version` + campos numéricos; contact válido → 201 + `id`; email inválido → 400; campos em falta → 400.
- [ ] **Step 2: Correr e ver falhar**

```powershell
npx tsx tests/publicApi.test.ts
```
Expected: FAIL (rota inexistente → 404).

- [ ] **Step 3: Implementar DDL + `routes/public.ts` + mounts**

- [ ] **Step 4: Correr e ver passar**

Run: `npx tsx tests/publicApi.test.ts` → `ALL PASS`; depois `npm run typecheck`.
- [ ] **Step 5: Acrescentar à chain `test` do package.json e commit**

```powershell
git add backend-api/src backend-api/tests/publicApi.test.ts backend-api/package.json
git commit -m "feat(api): rotas públicas /public/stats e /public/contact com tabelas contacts e download_events"
```

---

### Task 4: Fase D — `requireDownloadAccess` (gate + contador) + redirects `.html`

**Files:**
- Modify: `backend-api/src/routes/devices.ts` (middleware + aplicar em `/public/endpointx.exe` e `/public/endpointx-agent.apk`)
- Create: `backend-api/src/middleware/canonicalRedirects.ts`
- Create: `backend-api/tests/downloadAccess.test.ts`
- Modify: `backend-api/tests/installAccess.test.ts` (teste 7 passa a esperar 403 anónimo)
- Modify: `backend-api/package.json` (chain `test`)
- Modify: `backend-api/src/index.ts` (usar `canonicalHtmlRedirect` antes do static)

**Interfaces:**
- Consumes: `verifyEnrollToken` (`devices.ts:74`), `authenticate` + `requirePermission` já importados em `devices.ts`, tabelas do Task 3.
- Produces:
  - `function requireDownloadAccess(kind: 'windows-exe' | 'android-apk')` em `devices.ts` (junto a `requireEnrollToken`):
    1. `verifyEnrollToken(req.query?.t)` válido → `recordDownload` → `next()`.
    2. Senão correr `authenticate` e, se OK, `requirePermission('devices.manage')` → `recordDownload` → `next()`.
    3. Qualquer falha → `403 { success:false, error:{ message:'Download requires an enrolment token or an authorised session', code:'DOWNLOAD_FORBIDDEN' } }`.
  - `recordDownload`: `INSERT INTO download_events (kind, ip_address) VALUES ($1,$2)` fire-and-forget (`.catch(() => undefined)`), nunca bloqueia a resposta.
  - Rotas `/public/endpointx.exe` e `/public/endpointx-agent.apk` passam a usar `requireDownloadAccess('windows-exe'|'android-apk')` como primeiro middleware; resto do handler igual (incl. 404 de ficheiro em falta).
  - Redirects: novo middleware `canonicalHtmlRedirect` em `src/middleware/canonicalRedirects.ts` (named export), montado em `index.ts` **antes** de `express.static`:
    ```ts
    export const canonicalHtmlRedirect: RequestHandler = (req, res, next) => {
      if (!req.path.toLowerCase().endsWith('.html')) return next();
      const target = req.path.replace(/\.html$/i, '');
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      res.redirect(301, (target || '/') + qs);
    };
    ```
    (cobre `/index.html → /`, `/login.html → /login`, `/docs/<slug>.html → /docs/<slug>`, `/en/docs/<slug>.html → …`).
  - Teste `downloadAccess.test.ts` (espelha `installAccess.test.ts`): exe sem `?t=` → 403 e **sem** bytes do binário; exe com enroll token válido → 200 + `content-disposition` + `download_events` INSERT registado (flag no FakePool); apk + sessão `devices.view` → 403; apk + sessão `devices.manage` → 200.
  - No **mesmo** `downloadAccess.test.ts`, montar o `canonicalHtmlRedirect` numa app de teste e afirmar: `GET /index.html` → 301 `Location: /`; `GET /docs/faq.html?x=1` → 301 `/docs/faq?x=1`; `GET /docs/faq` (sem `.html`) → passa ao `next` sem redirect.
  - `tests/installAccess.test.ts` **actualizado**: o teste 7 (anonymous `GET /public/endpointx.exe` → 200) passa a esperar `403` com `code: 'DOWNLOAD_FORBIDDEN'` — o gate novo torna o download anónimo ilegal (o caminho 200 + headers é coberto por `downloadAccess.test.ts` com token).

- [ ] **Step 1: Escrever `tests/downloadAccess.test.ts`** (downloads + redirects) e `tests/installAccess.test.ts` actualizado (teste 7 → 403) — correr para ver falhar.
- [ ] **Step 2: Implementar `requireDownloadAccess` + aplicar às 2 rotas de binários**
- [ ] **Step 3: Extrair `canonicalHtmlRedirect` para `src/middleware/canonicalRedirects.ts` e montá-lo em `index.ts` antes do static**
- [ ] **Step 4: Correr `downloadAccess.test.ts` → ALL PASS; correr `installAccess.test.ts` → ALL PASS (com teste 7 actualizado)**

```powershell
npx tsx tests/downloadAccess.test.ts; npx tsx tests/installAccess.test.ts
```
- [ ] **Step 5: Chain `test` + commit**

```powershell
git add backend-api/src backend-api/tests/downloadAccess.test.ts backend-api/tests/installAccess.test.ts backend-api/package.json
git commit -m "feat(api): requireDownloadAccess gate+contador em exe/apk e redirects 301 .html→canónico"
```

---

### Task 5: Admin — permissão `contacts.view`, rota `/api/contacts`, página Contactos, InstallPage com tokens

**Files:**
- Modify: `backend-api/src/config/database.ts` (catálogo `allPerms`, linha ~1288)
- Create: `backend-api/src/routes/contacts.ts`
- Modify: `backend-api/src/index.ts` (mount `/api/contacts`)
- Create: `admin-dashboard/src/pages/ContactosPage.tsx`
- Modify: `admin-dashboard/src/App.tsx` (rota `/contacts`)
- Modify: `admin-dashboard/src/components/Layout.tsx` (nav item + navGroup)
- Modify: `admin-dashboard/src/i18n/index.tsx` (chaves PT e EN)
- Modify: `admin-dashboard/src/pages/InstallPage.tsx` (tokens nos downloads)

**Interfaces:**
- Consumes: padrões admin (`useApi`, `Pagination`, `StatusBadge`, `useI18n`); `authenticate`/`requirePermission`; permissão nova decidida pelo utilizador: **`contacts.view`**.
- Produces:
  - `allPerms` ganha `['contacts.view', 'View Contact Messages', 'Read messages submitted from the public site contact form', 'contacts']` — o repair-loop admin (`database.ts:1304-1313`) concede-a automaticamente a todas as BDs existentes; **não** acrescentar a `SEED_ROLE_PERMISSIONS` (admin-only).
  - `routes/contacts.ts`:
    - `GET /api/contacts?limit=50&offset=0&unreadOnly=true|false` — `authenticate` + `requirePermission('contacts.view')` → `SELECT id,name,email,message,is_read,created_at FROM contacts [WHERE is_read = FALSE] ORDER BY created_at DESC LIMIT $ OFFSET $` + count total → `200 { success:true, data:{ contacts, total } }`.
    - `PATCH /api/contacts/:id/read` — mesma gate → `UPDATE contacts SET is_read = TRUE WHERE id = $1 RETURNING *` (404 se 0 linhas).
  - `ContactosPage.tsx`: título + contagem; toggle «só não lidas»; lista/tabela (nome, email, mensagem com `line-clamp` + `title` completo, data, badge lida/não lida); botão «Marcar como lida»; `Pagination` (limite 25); `Refresh`; estados loading/erro com componentes existentes; todos os textos via `t('contacts.*')`.
  - Layout: nav item `{ key: 'nav.contacts', path: '/contacts', icon: Mail, permission: 'contacts.view' }` no grupo `Sistema`; título de página i18n.
  - i18n chaves (PT+EN): `nav.contacts`, `page.contacts.title`, `contacts.unreadOnly`, `contacts.markRead`, `contacts.empty`, `contacts.from`, `contacts.total` (+ as que faltarem na página).
  - `InstallPage.tsx`: `apkUrl` passa a `…endpointx-agent.apk${tokenQS}`; novo botão/bloco de download do Windows PC: `const exeUrl = ${API_URL}/api/devices/public/endpointx.exe${tokenQS}` com botão Download (o `tokenQS` já existe no topo do componente).

- [ ] **Step 1: Backend — permissão + `routes/contacts.ts` + mount; commit**

```powershell
git add backend-api/src
git commit -m "feat(api): rota admin /api/contacts com permissão contacts.view"
```

- [ ] **Step 2: Admin — ContactosPage + rota + nav + i18n**
- [ ] **Step 3: Admin — InstallPage com `?t=` em apk e novo botão exe**
- [ ] **Step 4: Verificar**

```powershell
npm --prefix admin-dashboard run build
```
Expected: build TS OK (tsc dentro do build script).

- [ ] **Step 5: Commit**

```powershell
git add admin-dashboard/src
git commit -m "feat(admin): página Contactos e links de download do InstallPage com token de enrolamento"
```

---

### Task 6: Fase F — verificação completa, ajustes e relatório final

**Files:**
- Modify: apenas o que a verificação revelar defeituoso
- Report: relatório final em PT-PT na resposta ao utilizador (sem criar ficheiro de docs não pedido)

- [ ] **Step 1: Suite backend**

```powershell
npm --prefix backend-api test
npm --prefix backend-api run typecheck
```
Expected: todos os testes ALL PASS; tsc sem erros.

- [ ] **Step 2: Build do site + paridade sitemap**

```powershell
npm --prefix site run build
```
Expected: 12 HTML (`docs/` + `en/docs/`), `search-index.json` com 12 entradas, robots/sitemap nos sites finais; script PowerShell de paridade sitemap↔ficheiros (Task 2 Step 3) verde.

- [ ] **Step 3: Build do admin**

```powershell
npm --prefix admin-dashboard run build
```
Expected: OK.

- [ ] **Step 4: Grep de fugas github.com**

```powershell
git grep -n "github.com" -- site
```
Expected: **zero ocorrências** (se aparecerem em conteúdo gerado/md, corrigir o conteúdo; a exceção InstallPage vive em `admin-dashboard` e é só reportada).

- [ ] **Step 5: Spot-check a11y/SEO em 2 páginas geradas** (PT e EN): um único `h1`; `alt` em todas as `img`; `aria-label` em botões icon-only; canonical + hreflang; `lang` correcto; `meta description` presente; callout/code-styles aplicados; search filtra; copy-btn funciona (inspecção manual do HTML).

- [ ] **Step 6: Commit final do output regenerado, se houver diffs**

```powershell
git add backend-api/public/site
git commit -m "chore(build): output de produção do site com as 12 páginas de documentação"
```

- [ ] **Step 7: Relatório final PT-PT** ao utilizador: o que ficou feito por fase, estado dos greps/verificações, links de ficheiros-chave, e nota de deploy (Render: API re-deploy serve o novo `public/site` incluído na imagem; sem mudança de blueprints).

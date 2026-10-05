# Plan: EndpointX Dashboard — app Electron com instalador Windows

**Spec / autoridade:** pedido do utilizador — "criar o app Electron do dashboard que gera um
`setup.exe` para instalar no PC do admin". A topologia foi verificada por HTTP e aprovada
pelo utilizador.

## Context

O EndpointX já tem:

- `admin-dashboard/` — SPA React/Vite que builda para `admin-dashboard/dist` (commit `0c9a935`,
  typecheck verde).
- `endpoint-desktop/` — app Electron de bandeja do HERMES (commit `d9a9dcf`), com
  `EndpointX HERMES Setup 1.0.0.exe` já gerado e cache NSIS em
  `%LOCALAPPDATA%\electron-builder\Cache`. É o **modelo de configuração**, não é para alterar.
- `endpointx-api` no Render com CORS `origin: process.env.FRONTEND_URL || '*'`
  (`backend-api/src/index.ts:39` e `:54`) e `render.yaml` a definir
  `FRONTEND_URL=https://endpointx-dashboard.onrender.com`.

Quatro pontos do dashboard resolvem a API pela origem do `window.location`:

| Ficheiro | Comportamento |
|---|---|
| `src/services/api.ts:1-3` | `localhost` → relativo, senão `https://endpointx.onrender.com/api` |
| `src/services/ssoService.ts:1-3` | idem |
| `src/contexts/SocketContext.tsx:74` | `localhost` → `window.location.origin`, senão `https://endpointx.onrender.com` |
| `src/components/RemoteViewer.tsx:26-28` | `localhost` → relativo, senão `wss://endpointx.onrender.com` |

## Decisão de design (aprovada)

Servir a UI empacotada em `http://127.0.0.1:<porta>` faz os quatro pontos acima caírem na
origem absoluta correcta **sem tocar em uma linha do dashboard**. A API continua fixa em
`https://endpointx.onrender.com`. Pasta nova: `endpoint-desktop-dashboard/`.

`BrowserRouter` exige fallback SPA para `index.html` — espelhar `admin-dashboard/nginx.conf`
(`try_files $uri $uri/ /index.html`).

## Global Constraints

1. **Não alterar** `admin-dashboard/src/**` nem `endpoint-desktop/**`.
2. API fixa em `https://endpointx.onrender.com`; nunca servir a API localmente.
3. `admin-dashboard/dist` é rebuildado **antes** de qualquer packaging.
4. Verificação obrigatória antes de qualquer "está pronto": correr o comando e ler o exit code.
   Backend → `npm run typecheck`; servidor estático → `node tests/server.test.mjs`; agente →
   `python -m py_compile`.
5. Commit por tarefa, convenção `tipo: frase minúscula` + corpo.
6. O repo trabalha em `main` (ver `git log`); sem worktree/branch sem pedido do utilizador.

## Interfaces partilhadas entre tarefas

| Consome | Produz | Estado |
|---|---|---|
| Task 2/3 consomem `admin-dashboard/dist` | Task 5 rebuilda | sem conflito — ordem fixa |
| Task 4 (`server.js`) é consumido por `main.js` (Task 5) | Task 3 exporta `createStaticServer` | pre-flight: verificar no início da Task 5 |
| Task 1 altera `backend-api/src/index.ts` (linhas 39 e 54) | nenhuma outra tarefa lê | pre-flight: nenhuma sobreposição |
| Task 6 consome o `dist/` da Task 5 | `scripts/copy-ui.mjs` da Task 2 | pre-flight: Task 6 depende de 2 e 5 |

**Pre-flight: 3 linhas de interfaces partilhadas; nenhum conflito.**

---

## Task 1: CORS endurecido no backend

**Files:**
- Criar: `backend-api/src/utils/cors.ts`
- Criar: `backend-api/tests/cors.test.ts`
- Modificar: `backend-api/src/index.ts:37-59`

**Steps (RED → GREEN):**

1. Escrever `backend-api/tests/cors.test.ts` com asserções para `isAllowedOrigin`:
   - `undefined` → `true` (agents/curl sem Origin)
   - `https://endpointx.onrender.com` → `true` (FRONTEND_URL default do processo)
   - `http://localhost:5173` → `true`
   - `http://127.0.0.1:5199` → `true`
   - `http://localhost` (sem porta) → `true`
   - `http://evil.com` → `false`
   - `null` string literal → `false`
   - `https://endpointx.onrender.com.evil.com` → `false`
   - origem de lista `FRONTEND_URL="a,b"` → `true` só para `a` e `b`
2. **Esperado:** `npx tsx tests/cors.test.ts` → FALHA com `isAllowedOrigin` não exportado (RED).
3. Implementar `isAllowedOrigin(origin?: string)` em `src/utils/cors.ts`.
   - `FRONTEND_URL` partido por `,`, trim, comparação exacta.
   - Qualquer origem `http://localhost` / `http://127.0.0.1` com porta opcional via regex
     `^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$`.
   - Sem Origin → `true`.
4. **Esperado:** `npx tsx tests/cors.test.ts` → `PASS` todas (GREEN).
5. Substituir as duas ocorrências de `origin: process.env.FRONTEND_URL || '*'` por
   `origin: isAllowedOrigin`.
   - express: `origin: (o, cb) => cb(null, isAllowedOrigin(o))`
   - socket.io: `origin: isAllowedOrigin`
6. **Esperado:** `npm run typecheck` → exit 0.
7. Commit: `fix: restrict api cors to the dashboard origin and local electron app`.

**Test command:** `cd backend-api && npx tsx tests/cors.test.ts`

---

## Task 2: scaffold `endpoint-desktop-dashboard/`

**Files:**
- Criar: `endpoint-desktop-dashboard/package.json`
- Criar: `endpoint-desktop-dashboard/scripts/copy-ui.mjs`
- Criar: `endpoint-desktop-dashboard/.gitignore` (`node_modules/`, `dist/`, `ui/`)
- Criar: `endpoint-desktop-dashboard/assets/logo.png` (cópia de `logotipo.png`)

**Steps:**

1. `package.json` com:
   - `name: endpointx-dashboard`, `productName: EndpointX Dashboard`, `version: 1.2.0`
   - `main: main.js`, `private: true`, `license: UNLICENSED`
   - scripts: `copy-ui`, `start`, `dist` (`electron-builder --win nsis`)
   - devDependencies: `electron ^31.7.7`, `electron-builder ^24.13.3` (mesmas versões do
     `endpoint-desktop/package.json`, para reutilizar o cache já descarregado)
   - `build`: `appId: pt.endpointx.dashboard`, `files: ["main.js","server.js","ui/**","assets/**"]`,
     `win.icon: assets/logo.png`, `win.target: ["nsis"]`, `win.requestedExecutionLevel: "asInvoker"`,
     `nsis.oneClick:false`, `perMachine:false`, `allowToChangeInstallationDirectory:true`,
     `createDesktopShortcut:true`, `createStartMenuShortcut:true`,
     `shortcutName:"EndpointX Dashboard"`, `installerLanguages:["pt-PT"]`
2. `scripts/copy-ui.mjs`: apaga `ui/`, copia `../admin-dashboard/dist` → `ui/`, falha com
   exit 1 se `dist/index.html` não existir.
3. `assets/logo.png` copiado de `../logotipo.png`.
4. **Esperado:** `node scripts/copy-ui.mjs` → exit 0 e `ui/index.html` existe.
5. Commit: `feat: scaffold electron shell for the admin dashboard`.

**Test command:** `node endpoint-desktop-dashboard/scripts/copy-ui.mjs`

---

## Task 3: servidor estático com fallback SPA

**Files:**
- Criar: `endpoint-desktop-dashboard/server.js`
- Criar: `endpoint-desktop-dashboard/tests/server.test.mjs`

**Contract de `server.js`:** `export function createStaticServer({ root, port = 0 })` devolve
`{ server, url, port }`.

**Steps (RED → GREEN):**

1. Escrever `tests/server.test.mjs` com:
   - `GET /` → 200, `content-type: text/html`
   - `GET /devices/123` (rota inexistente) → 200, body = `index.html` (fallback SPA)
   - `GET /assets/<ficheiro real>` → 200, `content-type` correcto para `.js`/`.css`
   - `GET /../../package.json` e `GET /%2e%2e/package.json` → 404 (traversal bloqueado)
   - `GET /api/qualquer` → 404 (não servir API localmente)
   - porta `0` → servidor devolve URL efémera
2. **Esperado:** `node tests/server.test.mjs` → FALHA (`server.js` não existe) (RED).
3. Implementar `server.js` com `http` + `fs.promises`, MIME mínimo
   (html/js/css/png/svg/ico/woff2/json), path resolvido com `path.resolve` e verificação
   `startsWith(root + path.sep)`, fallback SPA para `index.html`, headers
   `X-Content-Type-Options: nosniff`, `Cache-Control: no-cache` no HTML e
   `public, max-age=31536000, immutable` nos assets.
4. **Esperado:** `node tests/server.test.mjs` → todas PASS (GREEN).
5. Commit: `feat: local static server with spa fallback for the packaged dashboard`.

**Test command:** `cd endpoint-desktop-dashboard && node tests/server.test.mjs`

---

## Task 4: `main.js` do Electron

**Files:**
- Criar: `endpoint-desktop-dashboard/main.js`

**Steps:**

1. `main.js` que:
   - importa `createStaticServer` de `./server.js` com `root = ui/`
   - `app.requestSingleInstanceLock()` — segundo foco reabre a janela
   - `new BrowserWindow({ width: 1440, height: 900, backgroundColor: '#0f172a', show: false,
     webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })`
   - `ready-to-show` → `show()`
   - `setWindowOpenHandler` → `shell.openExternal` para `http(s)`, `deny` para o resto
   - navegação externa (hostname ≠ `127.0.0.1`) → `shell.openExternal` + `preventDefault`
   - `app.setAppUserModelId('pt.endpointx.dashboard')`
   - `session.defaultSession.on('will-download')` → permite os exports CSV/PDF do dashboard
   - servidor fechado em `window-all-closed`/`before-quit` (Windows fecha a app)
2. **Esperado:** `npm run typecheck` não existe aqui; verificação = `node --check main.js` → exit 0
   e `node tests/server.test.mjs` continua verde.
3. Commit: `feat: electron main window serving the packaged dashboard on 127.0.0.1`.

**Test command:** `node --check endpoint-desktop-dashboard/main.js`

---

## Task 5: gerar o `setup.exe`

**Files:**
- Modificar: `package.json` (raiz) — adicionar `"dist:dashboard"`

**Steps:**

1. Verificação pré-condição: `test -f endpoint-desktop-dashboard/server.js` e export de
   `createStaticServer` (Task 3) — consumido por `main.js`.
2. Adicionar ao `package.json` da raiz:
   `"dist:dashboard": "cd admin-dashboard && npm run build && cd ../endpoint-desktop-dashboard && npm run copy-ui && npm run dist"`.
3. **Esperado:** `npm run dist:dashboard` → exit 0, sem erro de electron-builder.
4. **Esperado:** `endpoint-desktop-dashboard/dist/EndpointX Dashboard Setup 1.2.0.exe` existe
   e tem tamanho > 50 MB.
5. Commit: `feat: windows installer for the endpointx dashboard`.

**Test command:** `npm run dist:dashboard`

---

## Task 6: workflow GitHub Actions

**Files:**
- Criar: `.github/workflows/dashboard-installer.yml`

**Steps:**

1. Espelhar `.github/workflows/desktop.yml`: `workflow_dispatch` + `push` com paths
   `admin-dashboard/**`, `endpoint-desktop-dashboard/**`, o próprio workflow; `windows-latest`,
   Node 20, `npm install` em `admin-dashboard` e `endpoint-desktop-dashboard`, build, `npm run dist`,
   upload de `endpoint-desktop-dashboard/dist/*.exe`.
2. **Esperado:** YAML válido (validar com um parse Node de `js-yaml` se disponível, senão
   revisão visual das indentações).
3. Commit: `ci: build the dashboard windows installer on github actions`.

**Test command:** validação de YAML da Task 6.

---

## Review Focus

- Origens CORS: garantir que `*` desapareceu e que nenhum caminho do socket.io ficou sem
  origem.
- Fallback SPA: `/` e rotas deep-link devolvem `index.html`; traversal bloqueado.
- O dashboard não foi alterado — confirmar `git status` limpo em `admin-dashboard/src`.

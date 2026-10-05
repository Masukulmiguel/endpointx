# Plan: Dashboard no estilo do modelo Figma "Criar novo modelo de dashboard"

**Spec:** modelo Figma `N5XE2AKH8swIc3TOr9GjQT` (miniatura lida via oEmbed, 533x450) +
pedido do utilizador: "tudo funciona, só muda o novo designer", para a v1.2.0.

## O que o modelo mostra

- Corpo em **fundo claro** (cinza muito claro `#F6F8FB`), cartões brancos, bordas `slate-200`.
- **Sidebar escura navy** (`#0B1220`) com item activo a ciano vivo, etiquetas de grupo em
  maiúsculas esbatidas, cartão de progresso no fundo.
- **Topbar clara** com pesquisa centrada e pílula arredondada, sino + avatar à direita.
- Saudação grande no topo + toggle segmentado + botão.
- **4 cartões KPI**: rótulo pequeno cinza, número grande, chip de ícone colorido
  (verde/violeta/laranja) e badge de variação.
- **Linha 2**: gráfico de área teal ~2/3 + anel com valor ao centro ~1/3 e legenda de 3.
- **Linha 3**: tabela com badges de estado + feed de alertas com ícones.

## Descoberta que define o plano

`admin-dashboard/src/**` (47 ficheiros) já está escrito em pares
`bg-white dark:bg-gray-800` / `text-gray-900 dark:text-white` com `darkMode: 'class'`.
O `class="dark"` no `index.html` é o que força o tema escuro. **Tirar essa classe revela o
tema claro sem editar 24 páginas.** As ~1423 classes `dark:` ficam intactas e inertes.

Só a camada partilhada é que está escrita à mão para escuro: `src/index.css`
(`.card`, `.btn-*`, `.input`, `.badge-*`, `.table-row`, `.sidebar-link`) e `Layout.tsx`.

## Global Constraints

1. **Nenhuma mudança de comportamento**: nada de tocar em `hooks/`, `services/`,
   `contexts/`, `i18n/`, lógica de `pages/` ou rotas. Só classNames, tokens e markup
   visual.
2. Verificação obrigatória por tarefa: `cd admin-dashboard && npx tsc --noEmit` → exit 0
   e `npx vite build` → exit 0.
3. As classes `dark:` nunca são apagadas — mantêm o caminho de reactivar o tema escuro.
4. Commit por tarefa, convenção `tipo: frase minúscula`.
5. Trabalho em `main` (convenção do repo).

## Interfaces partilhadas entre tarefas

| Consome | Produz | Nota |
|---|---|---|
| Task 2 (Layout) e Task 3 (Dashboard) consomem tokens da Task 1 | Task 1 redefine `tailwind.config.js` + `index.css` | ordem fixa |
| Task 3 usa `StatCard` restilado na Task 4 | Task 4 Componentes | **conflito** — ver ruling |
| Task 5 consome o build das Tasks 1-4 | `npm run dist:dashboard` | só no fim |

**Pre-flight:** 1 conflito.
**Ruling:** `StatCard`/`DataTable`/`StatusBadge` passam para a **Task 2** (componentes
partilhados antes das páginas), para a Task 3 do dashboard já os consumir restilizados —
custo se errado: um refactor de imports.

---

## Task 1: tema claro + paleta Figma

**Files:** `admin-dashboard/index.html`, `admin-dashboard/tailwind.config.js`,
`admin-dashboard/src/index.css`

**Steps:**
1. `index.html`: remover `class="dark"` do `<html>`; `body` → `bg-[#F6F8FB] text-slate-900`.
2. `tailwind.config.js`: `primary` → escala ciano (`50 #ecfeff` … `500 #06b6d4`,
   `600 #0891b2` … `950 #164e63`) alinhada com o ciano do sidebar; acrescentar `navy`
   (sidebar) `950 #060B18`, `900 #0B1220`, `800 #111A2E`, `700 #1B2740`. Manter `dark`.
3. `src/index.css`: base clara (scrollbar `slate-200`/`slate-400`) e camada de componentes:
   `.card` = `bg-white border-slate-200 rounded-xl shadow-sm`; `.card-hover`; `.btn-primary`
   ciano; `.btn-secondary` slate; `.input`/`.select` branco com borda slate-300;
   `.badge-*` variantes claras; `.table-row` hover `slate-50`; `.sidebar-link` esbatido;
   `.page-container` sem alterações de layout.
4. **Expected:** `npx tsc --noEmit` → exit 0; `npx vite build` → exit 0.
5. Commit: `feat: light theme and cyan palette for the 1.2 dashboard`.

**Test command:** `cd admin-dashboard && npx tsc --noEmit && npx vite build`

## Task 2: componentes partilhados no estilo do modelo

**Files:** `src/components/{StatCard,DataTable,SearchInput,Pagination,Modal,StatusBadge,AlertBanner,ErrorState,LoadingSpinner}.tsx`

**Steps:**
1. `StatCard`: cartão branco, chip de ícone 44px com fundo colorido claro + `ring-1`,
   rótulo `text-xs uppercase tracking-wide text-slate-500`, número `text-3xl font-bold`,
   badge de variação com seta (`text-emerald-600`/`text-red-600`) — igual ao modelo.
2. `DataTable`: cabeçalho `bg-slate-50 text-slate-500 uppercase text-xs`, linhas
   `border-slate-100 hover:bg-slate-50`, cantos arredondados no cartão envolvente.
3. `SearchInput`: pílula `rounded-full bg-slate-100 border-slate-200` (topbar do modelo).
4. `Pagination`, `Modal`, `StatusBadge`, `AlertBanner`, `ErrorState`, `LoadingSpinner`
   para superfícies claras.
5. **Expected:** `npx tsc --noEmit` → exit 0; `npx vite build` → exit 0.
6. Commit: `feat: restyle shared dashboard components for the light theme`.

**Test command:** `cd admin-dashboard && npx tsc --noEmit && npx vite build`

## Task 3: sidebar e topbar

**Files:** `src/components/Layout.tsx`

**Steps:**
1. Sidebar: fundo `navy-900`, largura fixa 264px no desktop; etiquetas de grupo
   `text-[11px] uppercase tracking-wider text-slate-500`; item activo
   `bg-cyan-500 text-white shadow-lg shadow-cyan-500/30`; inactivo `text-slate-400 hover:text-white hover:bg-white/5`;
   rodapé com cartão navy-800 e barra de progresso.
2. Topbar: `bg-white/80 backdrop-blur border-b border-slate-200`, pesquisa centrada
   (pílula), sino com contador, avatar + dropdown sobre fundo claro.
3. Drawer mobile mantém a sidebar escura.
4. **Expected:** `npx tsc --noEmit` → exit 0; `npx vite build` → exit 0.
5. Commit: `feat: navy sidebar and light topbar matching the figma model`.

**Test command:** `cd admin-dashboard && npx tsc --noEmit && npx vite build`

## Task 4: página Dashboard no layout do modelo

**Files:** `src/pages/DashboardPage.tsx`

**Steps:**
1. Cabeçalho: saudação `text-2xl font-bold` + sublinha; à direita toggle segmentado
   (período) em cartão branco `rounded-full`.
2. Grelha de 4 `StatCard` (`grid-cols-2 xl:grid-cols-4 gap-4`).
3. Linha 2 `grid-cols-3 gap-4`: cartão de gráfico de área (2 cols) com
   `type="area"` fill teal degradado; cartão de anel (1 col) com `PieChart` inner/outer
   radius, valor ao centro via `absolute`, legenda de 3 estados por baixo.
4. Linha 3 `grid-cols-3 gap-4`: tabela de dispositivos (2 cols) + feed de alertas (1 col).
5. Chart colors alinhados com a paleta teal `#14b9d6`.
6. **Expected:** `npx tsc --noEmit` → exit 0; `npx vite build` → exit 0.
7. Commit: `feat: dashboard home layout from the figma model`.

**Test command:** `cd admin-dashboard && npx tsc --noEmit && npx vite build`

## Task 5: rebuild do instalador

**Files:** nenhuma (usa `package.json` da raiz)

**Steps:**
1. **Expected:** `npm run dist:dashboard` → exit 0.
2. **Expected:** `dist/win-unpacked/.../EndpointX Dashboard.exe --smoke` → exit 0.
3. Commit se houver artefactos rastreáveis (nenhum esperado — `dist/` e `ui/` ignorados).

**Test command:** `npm run dist:dashboard`

## Review Focus

- Nenhuma classe `dark:` apagada; nenhum ficheiro de lógica tocado.
- Contraste de texto: `slate-900` sobre `#F6F8FB`, nunca `text-white` sobre fundo claro.
- Sidebar escura não pode herdar as regras claras de `.sidebar-link`.
- Login/`LoginPage`, que têm styling próprio, continuam legíveis.

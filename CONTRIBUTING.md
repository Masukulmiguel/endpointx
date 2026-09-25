# Contributing to EndpointX

Thanks for helping build EndpointX — an open-source IAM + Endpoint Management
platform with defensive security tooling (HERMES).

Read the [Roadmap](ROADMAP.md) first: **v1.2.0** defines what we are building
next. Tasks not on the roadmap are much harder to get merged.

## Ways to contribute

- **Code**: pick an issue labelled `roadmap`, `help wanted` or `good first issue`
- **Docs**: fix gaps in `docs/`, translate UI strings (PT/EN), improve examples
- **Testing**: run the agent/dashboard locally and file reproducible bug reports
- **Design/UX**: dashboard polish, accessibility, i18n coverage

## Before you start

1. Search existing issues and PRs to avoid duplicates
2. For anything non-trivial, open an issue first and agree on the approach
3. Never commit secrets (`.env`, tokens, `AGENT_SECRET`, API keys) — they are
   rotated when leaked and will be rejected in review

## Development setup

Prerequisites: **Node.js 20 LTS**, **PostgreSQL 16**, **Python 3.9+** (agent), Docker optional.

```bash
git clone https://github.com/Masukulmiguel/endpointx.git
cd endpointx
```

### Backend API

```bash
cd backend-api
npm install
cp .env.example .env   # fill DB credentials, JWT secrets, AGENT_SECRET
npm run dev
```

### Dashboard

```bash
cd admin-dashboard
npm install
npm run dev            # http://localhost:5173
```

### Agent

```bash
cd endpoint-agent
pip install -r requirements.txt
python agent.py --register
python agent.py
```

Default admin: `admin@endpointx.local`, password from `SEED_ADMIN_PASSWORD` in your local `.env`.

## Branching & commits

- Branch from `main`: `feat/1.2.0-<slug>`, `fix/1.2.0-<slug>`, `docs/<slug>`
- Keep PRs focused — one concern per PR
- Conventional commit style (matches repo history):

```
feat: threshold engine for CPU/disk alerts
fix: webhook payload for Slack-compatible alerts
docs: document notification settings in api.md
chore: bump agent version to 1.2.0
```

## Project conventions

### Language

- Product UI is bilingual **PT (default) + EN**
- Every new user-facing string needs both entries:
  - Dashboard: `admin-dashboard/src/i18n/index.tsx`
  - Landing site: `backend-api/public/site/js/i18n.js`
- Code, commits and docs are written in **English**

### Backend (TypeScript / Express)

- Additive, migration-safe schema changes in `backend-api/src/config/database.ts`
  (seeds must work on existing databases — use `ON CONFLICT ... DO NOTHING`)
- New permissions go in `rolePerms` and are enforced with RBAC middleware;
  free-tier roles get `.view` only unless agreed otherwise
- Surface API errors through the existing friendly-message layer in
  `admin-dashboard/src/services/api.ts`

### Dashboard (React / TypeScript / Tailwind)

- Gate pages with `PermissionGate` and hide actions the role cannot perform
  (`useAuth().hasPermission`)
- Tailwind `darkMode: 'class'` — the app defaults to dark; test both themes

### Agent (Python)

- Must stay cross-platform (Windows / Linux / macOS) with graceful fallbacks
- Agent→API calls authenticate with the `X-Agent-Secret` header
- Never block the heartbeat loop — collectors must time out safely

### Security (non-negotiable)

- HERMES stays **defensive**: no exploit, no credential attacks, no DoS tooling
- No new outbound calls that exfiltrate data; scans only against authorized assets
- Audit-relevant actions must write `audit_logs`

## Checks before you push

```bash
# Backend
cd backend-api && npm run typecheck

# Dashboard (typecheck + production build)
cd admin-dashboard && npm run build
```

Both must pass. Do not commit `dist/` (gitignored).

## Pull requests

1. Use the PR template and fill in **what / why / how tested**
2. Link the issue: `Closes #123`
3. Screenshots for UI changes (dark **and** light where relevant)
4. Mark breaking changes and required migrations explicitly
5. Review may ask you to split large PRs — that is normal

## Reporting security vulnerabilities

**Do not open a public issue.** Email `security@endpointx.example.com` with
reproduction steps. See [SECURITY.md](SECURITY.md).

## Release process (maintainers)

1. Update [ROADMAP.md](ROADMAP.md) checkboxes as milestones land
2. Bump version in root `package.json`, agent and login footer
3. Tag `v1.2.0`, deploy `endpointx-api` **before** `endpointx-dashboard` on Render
   (schema seed runs on API start)

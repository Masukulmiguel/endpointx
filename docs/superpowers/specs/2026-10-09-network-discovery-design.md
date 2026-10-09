# Design Spec — Network Discovery (EndpointX v1.2.3)

**Date:** 2026-10-09
**Status:** Approved (design gate) — pending implementation plan
**Version target:** 1.2.3 (current: 1.2.0)

## 1. Goal

Add **Network Discovery** to the existing EndpointX platform: an enrolled agent scans its own LAN (ARP + ICMP sweep + reverse DNS), reports real hosts to the server, and the admin dashboard lists them with honest status. The admin can then mark nodes as known/ignored, identify them, and request enrollment (generate an install link) so discovered devices flow into the **existing** endpoint inventory.

Positioning (product): "Descubra todos os dispositivos da sua rede. Identifique-os. Inscreva-os. Monitorize-os. Proteja-os." — the discovery layer feeding the existing Device Management → Monitoring → HERMES pipeline.

**Hard constraints (from product owner):**
- Do NOT create a new project, parallel architecture, second inventory, or second auth system.
- Reuse existing architecture, components, styles, APIs, auth, RBAC, audit logs, database.
- Never invent data: anything not obtainable is shown as **Unknown**.
- Never install software covertly on unknown devices. "Request Enrollment" = authorized, transparent process only.
- All previously working functionality must keep working.

## 2. Current State (explored 2026-10-09)

- **Server is on Render (public cloud)** — it can never see customer private LANs. Any server-side sweep (the current NetSentinel stub) is useless for real LAN discovery. Discovery MUST run on an enrolled agent.
- **Command channel exists:** `agent_commands` table (`database.ts:259`), `POST /api/commands` (`commands.ts:39`, allowlist at `:10-23`), agent polls `POST /devices/command-poll` every ~3s (`devices.ts:529`, `agent.py:709-745`), results via `POST /devices/command-result` (`devices.ts:1218`). Agent auth = `X-Agent-Secret`.
- **Discovery tables exist (stub):** `network_discovery_runs` (`database.ts:752+`) and `network_nodes` (`node_type, name, hostname, ip_address, mac_address, vendor, parent_id, vlan, site, metadata JSONB, source, device_id→devices, first_seen, last_seen`).
- **NetSentinel routes exist** (`src/routes/netsentinel.ts`, mounted `/api/netsentinel`): `POST /discovery/run :537` (currently a server-side TCP sweep `sweepRange` — must be repurposed), `GET /discovery :638`, `GET /topology :648`, `GET /unknown :285`, NAC routes (stub, untouched). Feature flag `netsentinel_enabled` default 'false'.
- **HERMES unknown-asset hook exists:** `discoverUnknownAsset()` (`hermes.ts:205`) creates `hermes_assets` + `hermes_alerts` "UNKNOWN ASSET DETECTED". Recommendations concept exists (`hermes_recommendations` table, `hermes.view/manage/approve` perms).
- **Agent has zero scan code** (no ARP/ICMP/subnet logic; requirements.txt has no scapy/nmap). Interfaces via `psutil.net_if_addrs` (`system_info.py:189-227`) — netmask available in objects but not surfaced.
- **Dashboard:** flat nav (`Layout.tsx:35-54`), `network.view` gates `/network` (`NetworkPage.tsx` — stats/bandwidth/interfaces of registered agents only). DevicesPage pattern: `useApi` hook, server-side pagination, `DataTable` + `StatusBadge` + `Pagination` + `SearchInput`, mutations via `api.request`.
- **RBAC/tenant:** `requirePermission` (`rbac.ts`); 32 permission codes incl. `network.view`, `devices.manage`; tenant scoping via `devices.created_by` + `src/utils/tenant.ts` (`visibleDevicesSql`, `canViewUnownedDevices`); audit = raw `INSERT INTO audit_logs` at call sites (netsentinel has local `audit()` helper at `netsentinel.ts:54`).
- **Sockets:** dashboard-only (`broadcastEvent`); agents never use sockets (HTTP polling only).

## 3. Scope (MVP — approved)

**In:**
1. Real agent-side LAN discovery (ARP/neigh + ICMP ping sweep + reverse DNS) on the agent's own private subnets.
2. Ingest into `network_nodes` (existing table) with real `network_discovery_runs` bookkeeping.
3. Auto-link to `devices` by MAC → **Enrolled**.
4. Dashboard page **Network → Discovered Devices** (`/network/discovery`) with View / Identify / Mark as Known / Ignore / Request Enrollment, individual + multi-select with honest per-item results.
5. Request Enrollment = mint enroll token + return ready-to-copy install command (Windows/Linux/macOS); mark node `enrollment_requested`. No covert install, no fake notification on target.
6. HERMES integration: new nodes → `discoverUnknownAsset()` + a `hermes_recommendations` entry ("Identify this device before granting full network trust").
7. Audit logs + tenant scoping + permission gates on everything.
8. Version bumps to 1.2.3; site NetSentinel card → "Disponível".

**Out of scope (explicit):**
- Interactive [Permitir]/[Cancelar] dialog on the discovered device (impossible without an agent there).
- SNMP, DHCP snooping, full IPv6 ND (basic `ip neigh` IPv6 entries accepted if present).
- MDM/GPO/Intune integration.
- NAC blocking decisions (existing `nac_*` stubs untouched).
- OUI vendor database (vendor = Unknown in v1.2.3; future work).
- Topology UI (`/topology` stays unconsumed).
- Pushing discovery results over sockets (polling is sufficient).

## 4. Architecture

```
Dashboard [Discover Network]
  → POST /api/netsentinel/discovery/run        (network.view)
  → INSERT agent_commands (command_type='network_discovery')   [existing channel]
  → agent polls command-poll (~3s) → discovery.py scans its own LAN
  → POST /api/devices/command-result           [existing, X-Agent-Secret]
  → discoveryService.ingest():
      upsert network_nodes · link devices by MAC · HERMES hook · audit
Dashboard [Discovered Devices]
  → GET /api/netsentinel/discovery/nodes       (paginated, tenant-scoped)
  → POST .../nodes/:id/{mark-known,ignore,identify,enroll-request}
```

Single new backend module (`services/discoveryService.ts`), single new agent module (`discovery.py`), single new page (`DiscoveredDevicesPage.tsx`). Everything else is extension of existing files.

## 5. Agent Design (`endpoint-agent/`)

### 5.1 `discovery.py` (new module, stdlib + psutil only)

- `get_local_subnets()` — from `psutil.net_if_addrs()`: IPv4 + netmask per interface; filter to private ranges (RFC1918: 10/8, 172.16/12, 192.168/16, plus link-local excluded); return list of (interface, network_cidr). Cap: at most 4 subnets, each at most /22 (1024 hosts) — larger requested ranges are truncated, never expanded.
- `read_neighbors()` — platform-dispatched:
  - Linux: parse `/proc/net/arp` (IP, MAC, state); fallback `ip neigh show`.
  - macOS: `arp -an` parse.
  - Windows: `arp -a` parse (locale-independent: match MAC regex + IP regex pairs).
- `ping_sweep(subnet, budget=60s)` — `subprocess` per platform (`ping -c 1 -W 1` / `-w 1000` / `-n 1 -w 1000`), concurrent with a small thread pool (max 64 in flight), total wall-clock budget 60s, abort cleanly and report partial results with `truncated: true` in stats. Merge live IPs not already in neighbor table.
- `reverse_dns(ip)` — `socket.gethostbyaddr` wrapped in a 0.5s timeout (thread-based since gethostbyaddr has no timeout arg); failures → hostname Unknown.
- `os_estimate(mac, hostname, open_hint)` — **no guessing games**: hostname pattern heuristics only (e.g. `DESKTOP-*`/`WIN-*` → Windows-ish, `Android` in name → Android); otherwise `Unknown`. Stored in `metadata.os_estimate`.
- `scan()` orchestration returns a JSON-safe report:
  ```json
  { "subnets": ["192.168.1.0/24"], "truncated": false,
    "hosts": [ { "ip": "...", "mac": "...|null", "hostname": "...|null",
                 "os_estimate": "...|Unknown", "rtt_ms": 12.3|null } ] }
  ```
  No vendor field (Unknown at presentation layer).

### 5.2 `agent.py` changes

- Import + register handler in the dispatch map (`agent.py:827-841`): `"network_discovery": handle_network_discovery`.
- Handler: validates every configured/requested CIDR is contained in the agent's own private subnets (public or foreign ranges → `failed` with clear error, **no scan**); runs `discovery.scan()`; returns the report via the existing `report_command_result()` (`agent.py:795`). Result size guard: cap hosts at 1024 in the payload.

### 5.3 `system_info.py` changes

- `get_network_interfaces()` (`:189-227`): include `netmask` (and keep existing fields) so inventory also benefits. No other changes.

## 6. Backend Design (`backend-api/`)

### 6.1 Command channel

- `commands.ts:10-23`: `ALLOWED_COMMAND_TYPES += 'network_discovery'`.
- `devices.ts` `POST /command-result` (`:1218`): when `command_type === 'network_discovery'` and `status === 'completed'`, call `discoveryService.ingestRun(command, report)` after the existing `agent_commands` update (same transactional spirit; ingest errors must not flip the command result — log + audit error).

### 6.2 `services/discoveryService.ts` (new)

- `startDiscovery(runnerDeviceId, requestedBy, cidr?)`:
  - Runner must be an enrolled device with a live agent (status online) — else 409.
  - Reject if another `running` run exists for that agent (`network_discovery_runs`).
  - Insert `network_discovery_runs` (`source='agent'`, `status='running'`, `started_by=requestedBy`), queue the command (`agent_commands.issued_by=requestedBy`, parameters `{cidr?}`), audit.
- `ingestRun(command, report)`:
  - Finalize the run row: `status='completed'|'failed'`, `stats = {hosts_alive, new_nodes, updated_nodes, linked_devices, truncated}` — real counts only; on malformed report → `failed` + `error_message`.
  - For each host: upsert `network_nodes` keyed by (ip_address, mac_address) with `source='agent'`, `device_id` resolved by MAC against `devices.mac_address` (case-insensitive), `metadata` merging `{os_estimate, dns_name, rtt_ms, subnet}`, `created_by` = the runner device's `created_by` on insert (tenant owner), `first_seen` preserved, `last_seen = now()`.
  - For each **newly inserted** node: call HERMES `discoverUnknownAsset()` equivalent path (reuse the function — export from `hermes.ts` or move to a shared service; do not duplicate) + insert one `hermes_recommendations` row (`action_type='identify_device'`, `action_payload={node_id}`, status pending, `requires_approval=false`).
  - Audit: `network.discovery.completed` with run id + stats.
- `listNodes({page,limit,search,review_status,enrollment}, user)` — pagination shape identical to devices list (`pagination: {page,limit,total,totalPages}`); tenant filter: `created_by = user.id` OR user has `devices.view_all` OR node linked to a device the user can see (`canSeeDevice` semantics). Search over ip/mac/hostname.
- `setNodeReview(id, review, user)` — `mark-known` → `review_status='known'`; `ignore` → `'ignored'`; `identify` → merge admin-supplied `{display_name?, node_type?}` into `name`/`node_type`. All audited. 404 if node not visible to user.
- `requestEnrollment(nodeId, user)` — requires `devices.manage`; mints the same enroll JWT used by `GET /devices/enroll-token` (`devices.ts:571`, `{sub:userId, typ:'enroll', expiresIn:'30d'}`); returns `{ token, commands: { windows, linux, macos } }` with ready-to-copy one-liners (same URL shapes as `InstallPage.tsx:21-26`); sets `review_status='enrollment_requested'`, `enrollment_requested_at=now()`; audit with admin user id (satisfies "administrador que iniciou o enrollment" history requirement).

### 6.3 `netsentinel.ts` changes (repurpose, keep mount)

- `POST /discovery/run` (`:537`): replace server-side sweep with `discoveryService.startDiscovery()`. Query/body: optional `device_id` (runner agent); default = first online device with agent. Permission stays `network.view`. Keep writing `network_discovery_runs` (same table).
- `GET /discovery` (`:638`): unchanged shape; frontend polls this for run status.
- **New routes** (all `authenticate`):
  - `GET /discovery/nodes` — `network.view`, service `listNodes`.
  - `GET /discovery/nodes/:id` — `network.view` (View action detail).
  - `POST /discovery/nodes/:id/mark-known|ignore` — `network.view` + moderation semantics.
  - `POST /discovery/nodes/:id/identify` — `network.view`, body `{name?, node_type?}`.
  - `POST /discovery/nodes/:id/enroll-request` — `devices.manage`.
- Remove/stop calling `sweepRange`/`discoverUnknownAsset` server-side TCP sweep path in `/discovery/run` (the function bodies may remain for HERMES scans; the route no longer uses them). `netsentinel_enabled` flag: keep, but the new routes stay behind it OR default flips to 'true' — **decision: default 'true' in 1.2.3** so the feature is actually reachable (documented in changelog).

### 6.4 Database (`config/database.ts` inline schema)

```sql
ALTER TABLE network_nodes
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS review_status VARCHAR(20) NOT NULL DEFAULT 'new',
  ADD COLUMN IF NOT EXISTS enrollment_requested_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_network_nodes_created_by ON network_nodes(created_by);
CREATE INDEX IF NOT EXISTS idx_network_nodes_review_status ON network_nodes(review_status);
```
(Placed in `runMigrations`-style idempotent ALTER section like the existing `:716+` blocks.)

### 6.5 Version bumps

`backend-api/package.json` + `admin-dashboard/package.json` → `1.2.3`; agent banner strings `v1.2.0` → `v1.2.3` (`install-macos.sh:55` etc.); InstallPage visible version label; site feature card 06 badge `Em desenvolvimento` → `Disponível` (final commit).

## 7. Dashboard Design (`admin-dashboard/`)

- **`pages/DiscoveredDevicesPage.tsx` (new)** — route `/network/discovery`, gated `network.view` (`App.tsx`), nav item in Monitoring group next to Network (`Layout.tsx:51` pattern, `Radar` icon from lucide, i18n key `nav.discovery`).
- Header: **Discover Network** button → modal to pick runner agent (default pre-selected online device; fetched from `/devices?status=online&limit=50`) → `POST /netsentinel/discovery/run` → button becomes disabled with live run state from polling `GET /netsentinel/discovery` (status running + stats when done: `hosts_alive / new / updated / linked`). Errors surfaced with the existing error-banner pattern; failed runs shown honestly.
- **Table** (`DataTable` pattern from DevicesPage:338-466): checkbox column + IP · MAC · Hostname · Vendor (Unknown) · Type · Online (from last_seen ≤ 15min) · Enrollment (Enrolled badge if `device_id` else Not Enrolled) · Review (New/Known/Ignored/Enrollment requested badges reusing `StatusBadge` color conventions) · First seen · Last seen. Server-side pagination + `SearchInput` + review-status filter select.
- **Selection toolbar** (mirrors DevicesPage moderation affordances): "N seleccionados" + **Request Enrollment** (bulk), **Mark as Known**, **Ignore**. Bulk enrollment runs sequentially with real per-item progress (`3/12 …`), final summary from actual responses (`X ok · Y failed` with first error messages). No fabricated success.
- **Row actions:** View (detail modal via `GET /discovery/nodes/:id`), Identify (small form modal), per-row Enroll.
- i18n keys added to the existing dashboard translation system (PT default, EN mirror).
- Styling: existing Tailwind conventions only; no new CSS framework, no design-system changes.

## 8. Security Invariants

1. Discovery scans **only the agent's own RFC1918 subnets** — enforced agent-side (authoritative) and documented server-side; public ranges rejected.
2. `network.view` for discovery read/run; `devices.manage` for enrollment requests; RBAC untouched otherwise.
3. Tenant isolation: `network_nodes.created_by` set from the runner's owner; list/get/actions filtered with the same semantics as `visibleDevicesSql` (admins with `devices.view_all` see all).
4. Every state-changing action writes `audit_logs` (run started/completed, review changes, enrollment requests with admin id).
5. Agent ingest endpoint remains `X-Agent-Secret`-guarded (existing `command-result`).
6. No covert installation; enrollment is always an explicit admin action producing a link the admin sends through an authorized channel.
7. No invented data anywhere (Unknown for obtainable-missing fields; real counts only).

## 9. Testing Plan

- **`backend-api/tests/networkDiscovery.test.ts` (new, follows networkStats/installAccess suite style):**
  - enqueue requires `network.view` (403 otherwise); public CIDR rejected; run conflict 409; offline runner 409.
  - ingest: upsert by IP+MAC preserves `first_seen`; MAC link sets `device_id`; new node creates HERMES asset/alert + recommendation; stats match real counts; malformed report → run failed.
  - nodes list pagination + tenant filter (non-admin sees only own nodes).
  - mark-known/ignore/identify change state + audit rows; enroll-request returns 3 commands + token, sets `enrollment_requested`, requires `devices.manage`.
  - regression: existing 12 suites still pass.
- **`endpoint-agent/test_discovery.py` (new):** parsers for `arp -a` / `/proc/net/arp` fixtures; private-range validation; subnet cap; report schema. Runnable with stdlib `unittest` (no pytest dependency assumed).
- **Manual/visual:** dashboard page smoke (list, discover modal, bulk action progress), Site card badge check.
- **Full gate:** `npm test` (backend), `npx tsc --noEmit` (backend + dashboard), i18n key counts, `bash -n`/PSParser on touched installers if any.

## 10. Delivery

- Branch work in-session; commits follow repo style (`feature:` / scoped subjects). Suggested split: (1) backend + agent + tests, (2) dashboard UI + i18n + version bumps + site badge.
- Deploy note: Render redeploy needed to expose new routes; agent update flow (existing `update.ps1` / `update_agent` command) carries `discovery.py` to fleets.

# Network Discovery (v1.2.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An enrolled agent scans its own private LAN (ARP/neigh + ICMP sweep + reverse DNS), reports real hosts into the existing `network_nodes` table, and the dashboard gains a Discovered Devices page with View/Identify/Mark-as-Known/Ignore/Request-Enrollment wired to the existing RBAC, audit, and HERMES layers.

**Architecture:** Discovery runs agent-side (the Render server can never see private LANs). A new `network_discovery` command rides the existing `agent_commands` + 3s-poll channel; the result comes back through the existing `POST /devices/command-result` and is ingested by a new `discoveryService.ts` that upserts `network_nodes`, links `devices` by MAC, and calls the existing HERMES `discoverUnknownAsset()`. NetSentinel's stub `/discovery/run` is repurposed from server-side TCP sweep to agent dispatch. One new dashboard page mirrors the DevicesPage pattern.

**Tech Stack:** TypeScript/Express/pg (backend), Python 3.8+ stdlib+psutil (agent), React 18 + Tailwind + existing `useApi`/`DataTable` (dashboard). No new runtime dependencies anywhere.

**Spec:** `docs/superpowers/specs/2026-10-09-network-discovery-design.md`

## Global Constraints

- Version target: **1.2.3** (package.json x2, agent banner strings, InstallPage label).
- No new npm/pip dependencies; agent stays stdlib + existing requirements.txt (psutil already present).
- Never invent data: unobtainable fields render/write as `Unknown`/`null` — never fabricated values.
- Discovery only on the agent's own RFC1918 subnets; public ranges rejected agent-side (authoritative) and at `/discovery/run`.
- Permissions: `network.view` = read/run discovery; `devices.manage` = enroll-request. Nothing else changes.
- Tenant scoping: `network_nodes.created_by` (owner of the runner device); non-`view_all` users see only their own nodes.
- Every state-changing action writes `audit_logs` (existing table + netsentinel `audit()` helper pattern).
- Honest counts only: run stats and bulk-enrollment summaries reflect real per-item API results.
- Reuse, don't duplicate: HERMES hook = existing `discoverUnknownAsset()`; enroll token = existing enroll JWT (`typ:'enroll'`, 30d); install commands = existing `InstallPage` URL shapes.
- Existing 12 backend test suites must stay green; `npx tsc --noEmit` = 0 for backend and dashboard.

## Review Focus

1. **Agent scans a public/foreign CIDR** — the agent must refuse (failed result, no packets sent) even if a crafted command asks for `8.8.8.0/24`. *Pinned by Task 1 `test_validate_requested_cidr_rejects_public_and_foreign`.*
2. **Ingest must not flip the agent's command result** — a discoveryService crash after `command-result` responds must not fail the command or 500 the agent. *Pinned by Task 5 `test_ingest_error_does_not_fail_command_result`.*
3. **MAC link case-insensitivity + IP-only hosts** — Windows reports uppercase MACs, devices table may store lowercase; hosts with no ARP entry (MAC null) must still upsert. *Pinned by Task 4 `test_ingest_links_device_by_mac_case_insensitive` and `test_ingest_upserts_host_without_mac`.*
4. **Tenant leak on nodes list** — user without `devices.view_all` must never see nodes created by another user's agent. *Pinned by Task 4 `test_list_nodes_scopes_by_created_by`.*
5. **First-seen regression on re-scan** — a second scan of the same host must UPDATE `last_seen` and never overwrite `first_seen` or clobber an admin's `identify` values. *Pinned by Task 4 `test_ingest_preserves_first_seen_and_identify_fields`.*
6. **`netsentinel_enabled` reachability** — feature-flag default flip ('false'→'true') must be idempotent for existing installs (setting already present must be updated, not duplicated). *Pinned by Task 3 `test_flag_default_flip_is_idempotent`.*

---

### Task 1: Agent discovery module (`discovery.py`)

**Files:**
- Create: `endpoint-agent/discovery.py`
- Test: `endpoint-agent/test_discovery.py`

**Interfaces:**
- Consumes: nothing (pure stdlib + psutil).
- Produces (imported by Task 2):
  - `get_local_subnets() -> list[dict]` — `[{ "interface": str, "cidr": str, "network": IPv4Address, "prefixlen": int }]`, RFC1918 only, max 4 entries, prefixlen clamped to ≤ /22.
  - `read_neighbors() -> dict[str, str | None]` — `{ip: mac|None}` merged from platform source (`/proc/net/arp` or `ip neigh` on Linux, `arp -an` on macOS, `arp -a` on Windows); MACs lowercased.
  - `ping_sweep(cidrs: list[str], budget_seconds: int = 60, max_inflight: int = 64) -> tuple[set[str], bool]` — returns (live_ips, truncated); per-host `ping -c 1 -W 1` / `-n 1 -w 1000`; stops cleanly at budget.
  - `reverse_dns(ip: str, timeout: float = 0.5) -> str | None`.
  - `os_estimate(hostname: str | None) -> str` — heuristics only (`DESKTOP-*`/`WIN-*`/`NT `→ Windows-ish, `Android`→Android, `Mac`/`MBP`/`iMac`→macOS-ish), else `'Unknown'`.
  - `validate_requested_cidr(cidr: str, local_subnets: list[dict]) -> str | None` — returns an error string if cidr is public, non-RFC1918, > /22, or not contained in a local subnet; `None` if acceptable (empty cidr = accept).
  - `scan(requested_cidr: str | None = None) -> dict` — full report: `{ "subnets": [...], "truncated": bool, "hosts": [{ "ip", "mac"|null, "hostname"|null, "os_estimate", "rtt_ms"|null }] }`.

- [ ] **Step 1: Write the failing parser/validation tests**

`endpoint-agent/test_discovery.py` (stdlib `unittest`, no pytest):
- `test_parse_proc_net_arp` — fixture text `192.168.1.1 0x1 0x2 aa:bb:cc:dd:ee:ff 0x0 0x0` etc. → `{ '192.168.1.1': 'aa:bb:cc:dd:ee:ff' }` (parser factored as `parse_arp_output(text: str, flavor: str) -> dict` so tests never touch the network).
- `test_parse_arp_a_windows` — fixture of `arp -a` lines → IPs+MACs extracted.
- `test_get_local_subnets_rfc1918_only_and_slash22_cap` — with `psutil.net_if_addrs` monkeypatched to return 10.0.0.5/8, 192.168.1.10/24, 8.8.8.8/32 → only the two private, prefixlen ≥ 23 clamped to 22.
- `test_validate_requested_cidr_rejects_public_and_foreign` — `8.8.8.0/24` → error; `192.168.5.0/24` when local is `192.168.1.0/24` → error (not contained); `192.168.1.0/23` → error (> /22 cap); `192.168.1.0/24` local → `None`; `''` → `None`.
- `test_os_estimate_never_invents` — `'DESKTOP-ABC1'`→`'Windows'`; `'Android-123'`→`'Android'`; `'printer-01'`→`'Unknown'`; `None`→`'Unknown'`.
- `test_scan_report_schema` — with `read_neighbors`/`ping_sweep`/`reverse_dns` stubbed: report has exactly the keys listed in Produces; host entries never contain a `vendor` key.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd endpoint-agent && python -m unittest test_discovery -v`
Expected: FAIL (`ModuleNotFoundError: discovery` / import error).

- [ ] **Step 3: Implement `discovery.py`**

Implement the functions in Produces. Notes where tests leave a choice:
- `parse_arp_output(text, flavor)` — one regex pair per flavor: MAC `([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}` + IPv4; pair them per line.
- `ping_sweep` — `concurrent.futures.ThreadPoolExecutor(max_workers=max_inflight)`; deadline via `time.monotonic()`; on Windows use `-n 1 -w 1000`, else `-c 1 -W 1`; return partial results with `truncated=True` when deadline hit.
- `reverse_dns` — run `socket.gethostbyaddr` inside a 1-thread executor with `timeout`; catch all exceptions → `None`.
- `scan()` — union of neighbor IPs and sweep IPs; skip the agent's own IPs (from `get_local_subnets` interface addresses via `psutil.net_if_addrs`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd endpoint-agent && python -m unittest test_discovery -v`
Expected: PASS, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add endpoint-agent/discovery.py endpoint-agent/test_discovery.py
git commit -m "feat(agent): LAN discovery module (ARP/neigh, ping sweep, reverse DNS)"
```

---

### Task 2: Agent command handler + interface netmasks

**Files:**
- Modify: `endpoint-agent/agent.py:827-841` (dispatch map) + new `handle_network_discovery`
- Modify: `endpoint-agent/system_info.py:189-227` (`get_network_interfaces`)
- Test: extend `endpoint-agent/test_discovery.py`

**Interfaces:**
- Consumes: Task 1 `scan()`, `validate_requested_cidr()`, `get_local_subnets()`.
- Produces:
  - Command type string `'network_discovery'` handled in `execute_command()`; parameters `{ cidr?: string }`; success → `report_command_result(status='completed', result=scan_report)`; refusal/scan error → `status='failed'` with `error_message`.
  - `get_network_interfaces()` entries gain `netmask: str | None`.

- [ ] **Step 1: Write the failing handler test**

In `test_discovery.py` add `TestHandleNetworkDiscovery` importing the handler after stubbing `discovery.scan`/`agent.report_command_result` (handler must be import-safe without network):
- `test_handler_public_cidr_fails_without_scanning` — command `{cidr: '8.8.8.0/24'}` → `report_command_result` called once with `status='failed'`, error mentions private/local range; `scan` not called.
- `test_handler_valid_cidr_returns_report` — `{cidr: ''}` (or omitted) → `scan` called; result passed through unchanged; `status='completed'`.
- `test_system_info_interfaces_include_netmask` — monkeypatched `psutil.net_if_addrs` → each iface dict has `netmask`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd endpoint-agent && python -m unittest test_discovery -v`
Expected: FAIL (handler not registered / netmask key missing).

- [ ] **Step 3: Implement handler + netmask**

- `agent.py`: `from discovery import scan, validate_requested_cidr, get_local_subnets`; add
  ```python
  def handle_network_discovery(params):
      cidr = (params or {}).get('cidr') or None
      err = validate_requested_cidr(cidr, get_local_subnets())
      if err: raise RuntimeError(err)   # execute_command maps exceptions to failed result
      return scan(cidr)
  ```
  and register `'network_discovery': handle_network_discovery` in the dispatch map.
- `system_info.py`: in `get_network_interfaces()`, include `netmask = snet.netmask` (string) per address entry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd endpoint-agent && python -m unittest test_discovery -v` (all tests, incl. Task 1)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add endpoint-agent/agent.py endpoint-agent/system_info.py endpoint-agent/test_discovery.py
git commit -m "feat(agent): network_discovery command handler + iface netmasks"
```

---

### Task 3: Backend schema + command type + flag default

**Files:**
- Modify: `backend-api/src/config/database.ts` (ALTER block after the existing `network_nodes` CREATE, near `:780`; settings seed near `:1243`)
- Modify: `backend-api/src/routes/commands.ts:10-23` (`ALLOWED_COMMAND_TYPES`)
- Test: `backend-api/tests/networkDiscovery.test.ts` (new; registered in `package.json` test script)

**Interfaces:**
- Consumes: existing tables `network_nodes`, `network_discovery_runs`, settings table.
- Produces:
  - `network_nodes` new columns: `created_by UUID REFERENCES users(id)`, `review_status VARCHAR(20) NOT NULL DEFAULT 'new'`, `enrollment_requested_at TIMESTAMPTZ`; indexes `idx_network_nodes_created_by`, `idx_network_nodes_review_status`.
  - `ALLOWED_COMMAND_TYPES` contains `'network_discovery'`.
  - Setting `netsentinel_enabled` defaults to `'true'` for new installs; existing `'false'` rows flipped to `'true'` idempotently.

- [ ] **Step 1: Write the failing schema/flag test**

`tests/networkDiscovery.test.ts` — copy the FakePool harness pattern from `tests/networkStats.test.ts:31-77` (pg stub in `require.cache`, `initDatabase()`, `check()` helper, `testEnv` first import). Checks:
- `test_inline_schema_adds_network_nodes_columns` — capture SQL during `initDatabase()` and assert one statement matches `/ALTER TABLE network_nodes[\s\S]*ADD COLUMN IF NOT EXISTS created_by/` and the `review_status` + `enrollment_requested_at` ALTERs exist.
- `test_flag_default_flip_is_idempotent` — captured SQL contains `INSERT INTO app_settings ... ON CONFLICT (key) DO UPDATE` (or equivalent upsert) setting `netsentinel_enabled` to `'true'`; assert only ONE such statement (no duplicate seed row insert).
- `test_commands_allowlist_contains_network_discovery` — import `../src/routes/commands` with FakePool installed; read the exported allowlist via a `GET /` smoke? No — simpler: export `ALLOWED_COMMAND_TYPES` from commands.ts and assert `includes('network_discovery')` (named export added in this task).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-api && npx tsx tests/networkDiscovery.test.ts`
Expected: exit 1, the three checks FAIL.

- [ ] **Step 3: Implement schema + allowlist + flag**

- `database.ts`: append after `network_nodes` CREATE (both duplicated copies exist — add the ALTER once, in the migrations-style ALTER section used by the other post-CREATE changes, idempotent `ADD COLUMN IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`).
- `database.ts` settings seed: locate the `netsentinel_enabled` insert (`'false'`) and change to an upsert that also flips existing `'false'` → `'true'` (match the file's existing app_settings upsert style; if none exists, use `INSERT ... ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE app_settings.value = 'false'` — but only flip when currently 'false', never downgrade 'true').
- `commands.ts`: add `'network_discovery'` to the array; add `export` to `ALLOWED_COMMAND_TYPES`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend-api && npx tsx tests/networkDiscovery.test.ts`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend-api/src/config/database.ts backend-api/src/routes/commands.ts backend-api/tests/networkDiscovery.test.ts backend-api/package.json
git commit -m "feat(api): network_nodes discovery columns, network_discovery command type, flag default"
```

---

### Task 4: `discoveryService.ts` (ingest + list + review + enroll)

**Files:**
- Create: `backend-api/src/services/discoveryService.ts`
- Modify: `backend-api/tests/networkDiscovery.test.ts` (append service tests, same FakePool harness — extend `respond()` with substring-keyed scripted rows)

**Interfaces:**
- Consumes: Task 3 schema; existing `query()` from `config/database`; `newId()` (same generator style as `commands.ts:68`); `discoverUnknownAsset(ip)` exported from `../routes/hermes` (`hermes.ts:205` — already exported); `canViewUnownedDevices`/`canSeeDevice` from `../utils/tenant`; enroll JWT recipe from `devices.ts:571` (`jwt.sign({sub,typ:'enroll'}, JWT.ACCESS_SECRET, {expiresIn:'30d'})`); `JWT` from `config/constants`.
- Produces (exact signatures — Tasks 5 depend on these):
  ```ts
  export interface DiscoveryHost { ip: string; mac: string | null; hostname: string | null; os_estimate: string; rtt_ms: number | null }
  export interface DiscoveryReport { subnets: string[]; truncated: boolean; hosts: DiscoveryHost[] }
  export async function ingestReport(opts: {
    commandId: string; deviceId: string; status: 'completed' | 'failed';
    report: unknown; issuedBy: string | null;
  }): Promise<{ hosts_alive: number; new_nodes: number; updated_nodes: number; linked_devices: number; truncated: boolean }>
  export async function listNodes(opts: {
    page: number; limit: number; search?: string; review_status?: string;
    user: { id: string; permissions: string[] };
  }): Promise<{ nodes: Record<string, unknown>[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>
  export async function getNode(id: string, user: {...}): Promise<Record<string, unknown> | null>
  export async function setNodeReview(id: string, review: 'known' | 'ignored', user: {...}): Promise<boolean>
  export async function identifyNode(id: string, body: { name?: string; node_type?: string }, user: {...}): Promise<boolean>
  export async function requestEnrollment(id: string, user: { id: string; email: string }): Promise<{ token: string; commands: { windows: string; linux: string; macos: string } } | null>
  ```
  - `ingestReport` behaviors: finalize the run row found by `command_id` (`network_discovery_runs` matched via the `agent_commands` id — the run is created in Task 5 with `id = commandId`; **decision: run id == command id**, one less join); upsert per host keyed by `(ip_address, mac_address)` with mac compared case-insensitively (`LOWER(mac_address) = LOWER($n)`); MAC→`device_id` link via `LOWER(mac_address)` on `devices`; on INSERT set `created_by = <runner device's created_by>`; on UPDATE only `last_seen`, `hostname` (if currently null), `metadata` merge, `device_id` (if now resolvable and currently null) — never `first_seen`, never admin `name`/`node_type` once non-null; new unlinked nodes → `await discoverUnknownAsset(ip)` + one `INSERT INTO hermes_recommendations (action_type='identify_device', action_payload={'node_id':...}, status='pending', requires_approval=false)`; malformed report (status failed or non-object) → finalize run `failed` with `error_message`, return zero stats; **never throws** (wrap per-host work in try/catch, count failures into `error_message` tail).
  - `listNodes` tenant filter: `(n.created_by = $u OR $hasViewAll OR EXISTS(SELECT 1 FROM devices d WHERE d.id = n.device_id AND d.created_by = $u))`.
  - `requestEnrollment` builds commands exactly:
    - windows: `` `irm ${API}/api/devices/public/install.ps1?t=${token} | iex` ``
    - linux: `` `curl -fsSL ${API}/api/devices/public/install-linux.sh?t=${token} | sudo bash` ``
    - macos: `` `curl -fsSL ${API}/api/devices/public/install-macos.sh?t=${token} | bash` ``
    where `API = https://${process.env.API_HOST || 'endpointx.onrender.com'}` (match how `devices.ts` install routes derive host — prefer reusing the same env-derived base; if `API_ORIGIN`-style constant exists server-side use it, else the env form above).
  - Side effects of `setNodeReview`/`identifyNode`: `UPDATE network_nodes SET review_status/name/node_type` + `audit_logs` row (`action: 'network_node_review'` / `'network_node_identify'`, `target_type: 'network_node'`).

- [ ] **Step 1: Write the failing service tests (append to networkDiscovery.test.ts)**

Script FakePool `respond(sql, params)` rows for: runner device lookup, existing-node select (hit/miss), device-by-MAC link (hit/miss), hermes_assets existing (miss), plus capture INSERT/UPDATE params. Checks:
- `test_ingest_links_device_by_mac_case_insensitive` — host mac `AA:BB:CC:DD:EE:FF`, devices row mac `aa:bb:cc:dd:ee:ff` → UPDATE/INSERT params carry the device uuid; `linked_devices === 1`.
- `test_ingest_upserts_host_without_mac` — mac null → node upsert keyed by IP only; no crash; `new_nodes === 1`.
- `test_ingest_preserves_first_seen_and_identify_fields` — existing-node select returns a row with `name='Printer-HP', node_type='PRINTER', first_seen=...` → captured UPDATE sql does NOT contain `first_seen` and does NOT contain `name =`.
- `test_ingest_creates_hermes_recommendation_for_new_unlinked_node` — captured SQL includes `INSERT INTO hermes_assets`, `INSERT INTO hermes_alerts`, `INSERT INTO hermes_recommendations` with `identify_device`.
- `test_ingest_failed_status_finalizes_run_failed` — `status:'failed'` → run UPDATE sets `'failed'`; stats zeros; no node writes.
- `test_ingest_never_throws_on_malformed_report` — `report: 'garbage'` with `status:'completed'` → resolves; run finalized `'failed'`.
- `test_list_nodes_scopes_by_created_by` — user without `view_all`: captured list SQL contains `n.created_by = $1` param = user id; with `view_all` in permissions → no `created_by` restriction (branch).
- `test_list_nodes_pagination_shape` — returns `{nodes, pagination:{page,limit,total,totalPages}}` with `totalPages = Math.ceil(total/limit)`.
- `test_request_enrollment_returns_three_commands_and_token` — result has `token` decodable by `jwt.verify(..., JWT.ACCESS_SECRET)` with `typ==='enroll'`, `sub===user.id`; `commands.windows` contains `install.ps1?t=`; macos contains `install-macos.sh?t=`; captured SQL updates `review_status='enrollment_requested'` and sets `enrollment_requested_at`.
- `test_set_node_review_writes_audit` — captured SQL includes `INSERT INTO audit_logs` with `network_node_review`.
- `test_identify_node_overwrites_only_provided_fields` — body `{name:'X'}` → UPDATE contains `name` but not `node_type`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend-api && npx tsx tests/networkDiscovery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `discoveryService.ts`**

Follow the exact signatures and behaviors in Interfaces. Use parameterized SQL everywhere (match repo style). Per-host loop sequential (a /22 = 1024 max; fine).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend-api && npx tsx tests/networkDiscovery.test.ts`
Expected: all checks PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend-api/src/services/discoveryService.ts backend-api/tests/networkDiscovery.test.ts
git commit -m "feat(api): discoveryService — ingest, tenant-scoped list, review, enrollment"
```

---

### Task 5: Route wiring (netsentinel repurpose + command-result hook)

**Files:**
- Modify: `backend-api/src/routes/netsentinel.ts:537-636` (`POST /discovery/run` body replaced) + add node routes after `GET /discovery` (`:638`)
- Modify: `backend-api/src/routes/devices.ts:1254-1263` (add `network_discovery` branch beside the forensic branch)
- Modify: `backend-api/tests/networkDiscovery.test.ts` (append HTTP-level tests with both routers mounted)

**Interfaces:**
- Consumes: Task 4 signatures; existing `authenticate`, `requirePermission`, `audit()` (`netsentinel.ts:54`), `query()`.
- Produces (HTTP contract — Task 6 depends on these):
  - `POST /api/netsentinel/discovery/run` (`network.view`) body `{ device_id?: string, cidr?: string }` → `201 { success, data: { run_id, command_id, device_id } }`; `409` if that device already has a `running` run; `409` if device offline/not-an-agent; `404` device not visible; `400` invalid cidr shape. Implementation: pick runner (`device_id` or first device with `status='online'` ordered by `registered_at`), insert `network_discovery_runs (id = commandId, source='agent', status='running', started_by=user.id)`, insert `agent_commands (command_type='network_discovery', parameters={cidr}, issued_by=user.id)`, audit `'network_discovery_run'`.
  - `GET /api/netsentinel/discovery` — unchanged response shape (`{ runs }`).
  - `GET /api/netsentinel/discovery/nodes` (`network.view`) → `listNodes` (query: `page,limit,search,review_status`).
  - `GET /api/netsentinel/discovery/nodes/:id` (`network.view`) → node or 404.
  - `POST /api/netsentinel/discovery/nodes/:id/mark-known|ignore` (`network.view`) → 204/404.
  - `POST /api/netsentinel/discovery/nodes/:id/identify` (`network.view`) body `{name?, node_type?}` → 204/404.
  - `POST /api/netsentinel/discovery/nodes/:id/enroll-request` (`devices.manage`) → `{ success, data: { token, commands } }` or 404.
  - `POST /devices/command-result` (`devices.ts`): after the existing UPDATE, when `cmdType.command_type === 'network_discovery'` call `ingestReport({commandId, deviceId, status, report: result, issuedBy: null})` fire-and-forget with `.catch(logger.error)` — same shape as the forensic branch (`:1254`). The HTTP response to the agent is sent BEFORE ingest (never block the agent).

- [ ] **Step 1: Write the failing HTTP tests (append)**

Mount `netsentinelRouter` at `/api/netsentinel` + `devicesRouter` at `/api/devices` in the test app. Tokens: `network.view`-only user, `devices.manage` user, admin with `view_all`. FakePool scripted for runner-device selects + command inserts + node lists. Checks:
- `test_run_requires_network_view` — user with `[]` perms → 403.
- `test_run_with_public_cidr_rejected` — body `{cidr:'8.8.8.0/24'}` → 400.
- `test_run_no_online_agent_conflict_409` — runner select returns offline device → 409.
- `test_run_duplicate_running_409` — `SELECT ... status='running'` for device returns a row → 409.
- `test_run_enqueues_command_and_returns_ids` — online runner → 201; captured SQL has `INSERT INTO agent_commands` with `network_discovery` and `INSERT INTO network_discovery_runs` with matching id; response `data.command_id === data.run_id`.
- `test_nodes_list_and_detail_and_review_and_identify` — 200 list (shape), 200 detail, 204 mark-known (captured UPDATE `review_status='known'`), 204 identify, 404 for invisible node.
- `test_enroll_request_requires_devices_manage` — `network.view`-only → 403; with perm → 200 + `data.commands.macos` contains `install-macos.sh?t=`.
- `test_command_result_dispatches_ingest_for_network_discovery` — POST `/devices/command-result` with valid `X-Agent-Secret`, a command row of type `network_discovery` (scripted select after UPDATE) → response 200 immediately; captured SQL includes the `UPDATE agent_commands` AND (async) `INSERT INTO network_nodes`/run finalize — allow a `setImmediate`/short `await new Promise(r=>setTimeout(r,50))` tick before asserting the capture list.
- `test_ingest_error_does_not_fail_command_result` — make `respond()` throw for `INSERT INTO network_nodes` once → POST still returns 200 `{ success:true }`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend-api && npx tsx tests/networkDiscovery.test.ts`
Expected: new HTTP checks FAIL (404s on new routes).

- [ ] **Step 3: Implement route changes**

- Replace the body of `POST /discovery/run` (`netsentinel.ts:537+`) with the contract above (delete the `expandCidr`/devices-sync/sweep/VLAN block from that handler; leave `sweepRange`/helpers in the file untouched for HERMES reuse).
- Add the five node routes after `GET /discovery`, each with `authenticate` + `requirePermission(...)` + service call + `audit()` where the service doesn't already audit (single audit layer only — prefer service-side for review/identify; route-side for run start).
- `devices.ts`: add the `network_discovery` branch after `:1263` mirroring the forensic fire-and-forget pattern.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend-api && npx tsx tests/networkDiscovery.test.ts`
Expected: PASS, exit 0.

- [ ] **Step 5: Run the full backend gate**

Run: `cd backend-api && npm test && npx tsc --noEmit`
Expected: all suites green (now 13), tsc 0.

- [ ] **Step 6: Commit**

```bash
git add backend-api/src/routes/netsentinel.ts backend-api/src/routes/devices.ts backend-api/tests/networkDiscovery.test.ts
git commit -m "feat(api): agent-dispatch discovery run + node routes + command-result ingest hook"
```

---

### Task 6: Dashboard — Discovered Devices page

**Files:**
- Create: `admin-dashboard/src/pages/DiscoveredDevicesPage.tsx`
- Modify: `admin-dashboard/src/App.tsx` (route)
- Modify: `admin-dashboard/src/components/Layout.tsx:35-55,57-78` (nav item + title map)
- Modify: `admin-dashboard/src/i18n/index.tsx` (PT block ~`:23`, EN block ~`:286`)

**Interfaces:**
- Consumes: Task 5 HTTP contract; existing `useApi`, `api.request` (`services/api.ts`), `DataTable`, `Pagination`, `SearchInput`, `StatusBadge`, `Modal` components (import paths per `DevicesPage.tsx`).
- Produces: route `/network/discovery` (perm `network.view`); nav label key `nav.discovery` = PT `Dispositivos Descobertos` / EN `Discovered Devices`.

- [ ] **Step 1: Implement the page**

`DiscoveredDevicesPage.tsx` structure (mirror `DevicesPage.tsx` patterns — study it first):
- State: `page`, `search`, `reviewFilter`, `selected: Set<string>`, `running` (bool), `runState` (from polling), `bulk: { active, done, total, results }`, modals: `viewNode`, `identifyNode`, `enrollNode`, `discoverModal` (agent picker).
- Data: `useApi('/netsentinel/discovery/nodes', { params: { page, limit: 20, search, review_status } , refreshInterval: 15000 })`; `useApi('/netsentinel/discovery', { refreshInterval: running ? 3000 : 0 })`; agents for picker: `useApi('/devices', { params: { status: 'online', limit: 50 } })`.
- **Discover Network** header button → modal: `<select>` of online devices (hostname/IP) + optional CIDR text input (placeholder `192.168.1.0/24 (opcional)`) → `api.request('/netsentinel/discovery/run', { method:'POST', body })` → close modal, `running=true`, poll runs: latest run `status==='running'` keeps spinner; on `completed` show stat strip `{hosts_alive, new_nodes, updated_nodes, linked_devices}` + refetch nodes; on `failed` show `error_message` via the existing error-banner style. Button disabled while running.
- DataTable columns: checkbox · IP (`row.ip_address`) · MAC · Hostname (or `Unknown`) · Type (`node_type`) · Enrollment (badge `Enrolled` if `device_id` else `Not Enrolled`) · Review (badges: New=default-info, Known=success, Ignored=muted, Enrollment requested=warning — reuse `StatusBadge` variants or small inline spans matching its classes) · Last seen (`new Date(...).toLocaleString()`).
- Selection toolbar (renders when `selected.size > 0`): `N seleccionados` + buttons **Request Enrollment**, **Mark as Known**, **Ignore**.
  - Mark/Known/Ignore: loop `selected` ids sequentially with `await api.request(...)`; count real successes/failures; toast/banner summary `X ok · Y failed`.
  - Request Enrollment: same loop but per-id POST `enroll-request`; collect `{ip, ok, error}`; final modal lists results with the copyable `commands.windows` for the first success and per-IP status — **no fabricated successes**.
- Row actions: **View** → detail modal (all node fields + metadata JSON pretty-printed); **Identify** → form `{name, node_type}` → POST identify → refetch; **Enroll** (single) → enroll modal as above.
- Pagination + `SearchInput` under the table (server-side, same as DevicesPage).
- i18n: add keys used by the page to both PT and EN blocks (`nav.discovery`, `discovery.*` — keep the key set small: title, discover, run stats labels, review badges, bulk labels, modal titles). Use `t('...')` via `useI18n`.

- [ ] **Step 2: Wire route + nav + titles**

- `App.tsx`: `<Route path="/network/discovery" element={<PermissionGate permission="network.view"><DiscoveredDevicesPage /></PermissionGate>} />` beside the existing `/network` route (`App.tsx:168-175`).
- `Layout.tsx`: insert `{ key: 'nav.discovery', path: '/network/discovery', icon: Radar, permission: 'network.view' }` directly after the `nav.network` entry (`:51`); add `'/network/discovery': 'nav.discovery'` to `routeTitleKeys` (`:73`).

- [ ] **Step 3: Typecheck**

Run: `cd admin-dashboard && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Visual smoke (manual)**

Run backend `npm run dev` + dashboard `npm run dev`; log in as admin; open **Rede → Dispositivos Descobertos**; confirm: page renders, Discover modal opens, empty-state table shows, no console errors. Screenshot into the session temp dir for the record.

- [ ] **Step 5: Commit**

```bash
git add admin-dashboard/src/pages/DiscoveredDevicesPage.tsx admin-dashboard/src/App.tsx admin-dashboard/src/components/Layout.tsx admin-dashboard/src/i18n/index.tsx
git commit -m "feat(dashboard): Discovered Devices page with discovery run + node actions"
```

---

### Task 7: Version bumps, site badge, final gate

**Files:**
- Modify: `backend-api/package.json` + `admin-dashboard/package.json` (`"version": "1.2.3"`)
- Modify: `backend-api/public/install.ps1`, `backend-api/public/update.ps1`, `endpoint-agent/install-linux.sh`, `endpoint-agent/install-macos.sh` (banner strings `v1.2.0` → `v1.2.3`; conclusion messages if they carry the version)
- Modify: `admin-dashboard/src/pages/InstallPage.tsx` (visible version label `v1.2.0` → `v1.2.3`)
- Modify: `backend-api/public/site/index.html:159` (badge `Em desenvolvimento` → `Disponível`), `backend-api/public/site/css/styles.css` (only if a `badge-available` class needs no change — it exists), `backend-api/public/site/js/i18n.js` (EN mirror of the badge text if keyed)
- Test: full gates

**Interfaces:**
- Consumes: Tasks 1-6 complete.
- Produces: v1.2.3 everywhere user-visible.

- [ ] **Step 1: Apply version bumps** (files above; grep `1.2.0` across those paths first to catch stragglers, skip changelog-only mentions)

- [ ] **Step 2: Backend gate**

Run: `cd backend-api && npm test && npx tsc --noEmit`
Expected: 13 suites green, tsc 0.

- [ ] **Step 3: Dashboard gate**

Run: `cd admin-dashboard && npx tsc --noEmit`
Expected: 0.

- [ ] **Step 4: Agent gate**

Run: `cd endpoint-agent && python -m unittest test_discovery -v`
Expected: PASS.

- [ ] **Step 5: Installer parse + i18n sanity**

Run: PSParser tokenize both `.ps1` (0 errors); `bash -n` both `.sh`; count `data-i18n` occurrences on the site pages (must be unchanged from the 1.2.0 baseline: index=101, login=9, register=10, forgot=6 strict `data-i18n=`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: bump to v1.2.3 — NetSentinel card live, banners and labels updated"
```

---

## Self-review notes (plan author)

- Spec §5.1 caps/limits, §6.2 exact route table, §6.4 SQL, §7 page behaviors, §8 invariants, §9 test list all map to Tasks 1-7 (checked section by section).
- Decision locked that the spec left open: **run id == command id** (Task 4/5) — removes a join, keeps `GET /discovery` polling trivial.
- Decision locked: enroll API base = env-derived (`API_HOST` fallback to production host) since the backend has no shared API_ORIGIN constant.
- Review Focus items 1-6 each have a named test in the owning task.

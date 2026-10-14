# Fase B (P0) — Discovery Enrichment + Enrollment Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the P0 gaps found in the Fase A audit: enrich network-discovery ingest with real data (OUI vendor, node_type from linked devices, evidence-based confidence), fix MAC-first dedup, and complete the Device Enrollment decision flow (tenant authorization, review_status lifecycle, register-gate E2E tests, removal of the superseded bare-JWT enrollment path).

**Architecture:** All changes are backend (`backend-api`) plus one npm data dependency (`oui-data`). Ingest enrichment happens in `discoveryService.ingestHost` using a new pure lookup helper. Enrollment lifecycle changes live in `installRequests.ts` and are asserted through the project's existing FakePool test harness (`tsx` scripts, no framework). No public HTTP API shapes change; `network_nodes` schema is unchanged (confidence goes into the existing `metadata` JSONB).

**Tech Stack:** TypeScript (CommonJS, tsx runtime), Express, pg (FakePool in tests), `oui-data` (BSD-2-Clause IEEE OUI JSON, ~5.7 MB, no runtime deps).

**Spec:** Fase A audit report (delivered in conversation, 2026-10-14) — P0 items: "Discovery: enriquecimento real (vendor OUI, node_type, confidence) + testes de ingest; Enrollment: fechar pontas soltas do fluxo de decisão".

## Global Constraints

- Work on branch `feat/p0-discovery-enrollment` (create before Task 1; never touch `main` directly).
- Never fabricate data: vendor only from OUI table; node_type only from a linked agent device; unknown → keep `UNKNOWN`/`null`.
- Preserve admin-set fields on re-ingest: `first_seen`, `name`, and any non-`UNKNOWN` `node_type` must never be overwritten (existing invariant, see `tests/networkDiscovery.test.ts:test_ingest_preserves_first_seen_and_identify_fields`).
- No changes to public HTTP request/response shapes. `network_nodes` DDL unchanged; `vendor` (VARCHAR 150) and `metadata` JSONB are reused.
- Every task: write failing test first, watch it fail, implement minimally, watch it pass, run the **full** suite (`npm test`) plus `npm run typecheck` before committing.
- Test invocation convention: `npx tsx tests/<file>.test.ts` from `backend-api/`; new test files must be appended to the `test` script in `backend-api/package.json`.
- User-facing report at the end of the phase (files touched, tests executed, risks, next steps) in PT-PT; never claim a test ran when it did not.

## Review Focus

1. **OUI lookup must never break ingest** — a malformed MAC, an unregistered OUI, or a package load failure must result in `vendor = null`, never a thrown error. Test: `ouiLookup` garbage-input tests + ingest test with malformed MAC still inserts the node.
2. **MAC-first dedup must neither duplicate nor merge wrongly** — same MAC at a new IP updates the existing node (IP refreshed); a different device at the same IP (no MAC collision) still creates its own node. Tests: both directions in `networkDiscovery.test.ts`.
3. **Admin-set node_type must survive ingest** — the UPDATE may only upgrade rows whose current `node_type` is `'UNKNOWN'`. Test: preservation test updated to assert the `CASE WHEN ... 'UNKNOWN'` guard; new upgrade test for the linked-device path.
4. **Enroll-request tenant isolation** — `createInstallRequests` currently loads the node with no visibility check (`installRequests.ts:149-153`); a `devices.manage` user without `devices.view_all` could enroll another tenant's node and receive installer commands embedding `AGENT_SECRET`. Tests: cross-tenant denial returns `node_not_found`; `view_all` succeeds.
5. **review_status reverts must not clobber admin states** — refuse/expire/cancel must only revert nodes whose `review_status` is still `'enrollment_requested'`. Test: SQL guard assertion (`WHERE ... review_status = 'enrollment_requested'`) in each revert path.
6. **Register gate is the enforcement point** — a refused/expired install token must403 at `POST /api/devices/register` and never create or adopt a device row; an authorized token must create/adopt and mark the request installed. Tests: HTTP-level, both outcomes.

---

### Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Create the working branch**

```bash
git checkout -b feat/p0-discovery-enrollment
```

---

### Task 1: OUI vendor lookup helper

**Files:**
- Create: `backend-api/src/utils/oui.ts`
- Create: `backend-api/src/types/oui-data.d.ts`
- Create: `backend-api/tests/ouiLookup.test.ts`
- Modify: `backend-api/package.json` (add `"oui-data": "^2.1.39"` to `dependencies`; append `&& tsx tests/ouiLookup.test.ts` to the `test` script)

**Interfaces:**
- Consumes: `oui-data` package (CJS `require` of its JSON export; keys are 6/7/9 hex chars, values are vendor strings that may contain newlines for MA-S entries).
- Produces: `export function vendorFromMac(mac: string | null | undefined): string | null` — normalizes the MAC (lowercase, strip non-hex), requires ≥ 6 hex chars, longest-prefix match 9→7→6, returns the vendor with whitespace collapsed and truncated to 150 chars, or `null` on any failure (invalid MAC, unknown OUI, package load error). Lazy-loads and caches the JSON inside a `try/catch` so a missing/corrupt package degrades to `null`.

- [ ] **Step 1: Pin real OUI fixtures**

Run (before writing assertions) and record the exact strings:

```bash
node -e "const o=require('oui-data'); for (const k of ['B827EB','F4F5D8','005056','3C5AB4']) console.log(k, '=>', JSON.stringify(o[k])); console.log('FFFF99 =>', o['FFFF99'])"
```

Pick two keys that return non-empty vendors for the "known" tests (they cover MA-L 6-hex lookup). Note: `B827EB` should be Raspberry Pi — use whatever the package actually returns.

- [ ] **Step 2: Write the failing test `tests/ouiLookup.test.ts`**

Follow the `check`/`checkAsync` pattern from `tests/phoneOsint.test.ts` (assert + process.exitCode; no framework). Assertions:

1. `vendorFromMac('B8:27:EB:00:00:01')` equals the Step 1 string for `B827EB` (colon-separated input).
2. `vendorFromMac('B8-27-EB-AA-BB-CC')` equals the same string (dash-separated, case-insensitive input).
3. `vendorFromMac('b827eb112233')` equals the same string (bare-hex input).
4. `vendorFromMac('FF:FF:F9:00:00:01')` is `null` (unregistered OUI — confirm `FFFF99` is absent in Step 1; if present, pick another absent prefix).
5. `vendorFromMac('not-a-mac')`, `vendorFromMac('')`, `vendorFromMac(null)`, `vendorFromMac(undefined)` are all `null`.
6. A vendor value containing a newline (if one of the chosen fixtures has one) is returned with no `\n` characters and length ≤ 150.

Also import the module under a broken-package guard: assert `vendorFromMac` returns `null` rather than throwing when given `null` (already covered by 5; the lazy try/catch is verified implicitly — do not test module internals).

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx tests/ouiLookup.test.ts` (from `backend-api/`)
Expected: FAIL — cannot resolve `../src/utils/oui` (module not found).

- [ ] **Step 4: Implement `src/utils/oui.ts` + `src/types/oui-data.d.ts`**

`oui-data.d.ts`: `declare module 'oui-data' { const data: Record<string, string>; export default data; }`.
`oui.ts`: `let cache: Record<string, string> | null = null` + `load()` inside `try { cache = require('oui-data') } catch { cache = null }`; `normalizeMac` (strip `/[^0-9a-f]/g`, lowercase, return null if length < 6 or contains non-hex); lookup tries `mac.slice(0,9)`, then `0,7`, then `0,6`; sanitize value with `.replace(/\s+/g, ' ').trim().slice(0, 150) || null`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx tests/ouiLookup.test.ts`
Expected: `ALL PASS`, exit 0.

- [ ] **Step 6: Wire into `npm test` and commit**

Run: `npm test` (full suite must stay green) then:

```bash
git add backend-api/src/utils/oui.ts backend-api/src/types/oui-data.d.ts backend-api/tests/ouiLookup.test.ts backend-api/package.json backend-api/package-lock.json
git commit -m "feat(discovery): OUI vendor lookup helper from IEEE oui-data"
```

---

### Task 2: Ingest enrichment — vendor + confidence + MAC-first dedup + IP refresh

**Files:**
- Modify: `backend-api/src/services/discoveryService.ts` (`ingestHost`, lines ~59-123)
- Modify: `backend-api/tests/networkDiscovery.test.ts`

**Interfaces:**
- Consumes: `vendorFromMac` from Task 1.
- Produces: unchanged `ingestReport` signature and `IngestStats` shape. `network_nodes.vendor` is now populated on INSERT and refreshed on UPDATE when a lookup value exists. `metadata` gains `confidence: 'high' | 'medium' | 'low'` computed at ingest: `'high'` when the host linked to an agent device; `'medium'` when MAC **and** hostname are both present; `'low'` otherwise. Dedup for MAC-bearing hosts keys on MAC alone (most recent row wins); hosts without MAC keep the IP-only (`mac_address IS NULL`) match. UPDATE refreshes `ip_address`, `hostname`, `vendor`, and merges `metadata` (existing `||` merge pattern).

- [ ] **Step 1: Write the failing tests (extend `tests/networkDiscovery.test.ts`)**

Add to the existing harness (same `setScripts`/`captureCalls`; new scripted-key `FROM network_nodes WHERE LOWER(mac_address)`):

1. `test_ingest_resolves_vendor_and_writes_confidence_high_for_linked_host` — host with MAC that links to a device; assert the `INSERT INTO network_nodes` params contain the Task 1 vendor string for that MAC's OUI (use `B8:27:EB:…`), contain `'high'` inside the metadata JSON, and **no longer** contain the literal `NULL` vendor placeholder (the SQL's vendor column is parameterized).
2. `test_ingest_same_mac_new_ip_updates_existing_node` — scripted MAC lookup returns an existing node id; assert `updated_nodes === 1`, `new_nodes === 0`, exactly one `UPDATE network_nodes` whose params include the **new** IP and refresh `last_seen`/`vendor`, and that `first_seen`/`name`/`node_type` are still untouched by the UPDATE (keep the existing preservation assertions valid).
3. `test_ingest_dedups_by_mac_not_ip` — a MAC-bearing host whose IP does not match any row still hits the MAC lookup (not the IP lookup): assert no `SELECT … WHERE ip_address` is emitted for that host when a MAC is present.
4. `test_ingest_ip_only_host_still_matches_ip_and_gets_low_confidence` — host with `mac: null`, no hostname → INSERT params contain `'low'` in the metadata JSON; scripted key stays `'mac_address IS NULL'`.
5. `test_ingest_malformed_mac_does_not_break_insert` — host with `mac: 'garbage'` → still INSERTs (new_nodes=1), vendor param is `null`, node is matched by the IP-only path (MAC lookup skipped or returning empty — assert no throw and one INSERT).

**Update existing tests whose scripted keys change** (expected churn from the dedup change — behavior change, not a regression):
- `test_ingest_links_device_by_mac_case_insensitive`: add script `s('FROM network_nodes WHERE LOWER(mac_address)', [])` so the MAC lookup returns empty before the INSERT.
- `test_ingest_preserves_first_seen_and_identify_fields`: re-key the existing-node script from `NODE_BY_IP` to `'FROM network_nodes WHERE LOWER(mac_address)'` (the lookup is now MAC-first) and strengthen the UPDATE assertion to `assert.ok(/CASE[\s\S]*'UNKNOWN'/.test(upd), 'node_type refresh must be guarded to UNKNOWN rows only')` — this anticipates Task 3's guard; if you implement Task 2 alone, keep the current assertion and upgrade it in Task 3. **Decision: keep this file's Task 2 edit minimal (re-key scripts only); the CASE-guard assertion is Task 3's step.**

- [ ] **Step 2: Run the test to verify the new tests fail**

Run: `npx tsx tests/networkDiscovery.test.ts`
Expected: the 5 new checks FAIL (vendor param absent / dedup still IP-keyed / confidence key absent); other checks still pass or fail only due to re-keying (fix scripts until only the 5 new behavior checks fail).

- [ ] **Step 3: Implement in `discoveryService.ts`**

- Add `import { vendorFromMac } from '../utils/oui';`.
- `ingestHost`: compute `const vendor = vendorFromMac(host.mac);` and `const confidence = deviceId ? 'high' : host.mac && host.hostname ? 'medium' : 'low';` — put `confidence` into the `metadata` object alongside `os_estimate`/`rtt_ms`.
- MAC-bearing lookup becomes: `SELECT id FROM network_nodes WHERE LOWER(mac_address) = LOWER($1) ORDER BY last_seen DESC LIMIT 1` (param = host.mac). Keep the IP-only (`mac_address IS NULL`) lookup for MAC-less hosts. Drop the old `(ip, mac)` composite lookup.
- UPDATE gains: `ip_address = COALESCE($5, ip_address)` and `vendor = COALESCE($6, vendor)` appended to the existing SET list (params: host.ip, vendor); keep the `metadata ||` merge (now includes `confidence`).
- INSERT parameterizes vendor (`$vendor` instead of `NULL`) and keeps `node_type = 'UNKNOWN'` (Task 3 changes that).

- [ ] **Step 4: Run the tests to verify green**

Run: `npx tsx tests/networkDiscovery.test.ts` then the full `npm test` + `npm run typecheck`.
Expected: ALL PASS everywhere.

- [ ] **Step 5: Commit**

```bash
git add backend-api/src/services/discoveryService.ts backend-api/tests/networkDiscovery.test.ts
git commit -m "feat(discovery): OUI vendor + confidence enrichment and MAC-first dedup"
```

---

### Task 3: node_type inference from linked device

**Files:**
- Modify: `backend-api/src/services/discoveryService.ts` (`ingestHost`)
- Modify: `backend-api/tests/networkDiscovery.test.ts`

**Interfaces:**
- Consumes: `deviceId` + the device row fetched by MAC in `ingestHost`.
- Produces: private helper `mapDeviceTypeToNodeType(deviceType: string | null): string` — mapping: `DESKTOP|LAPTOP → ENDPOINT`, `SERVER → SERVER`, `PRINTER → PRINTER`, `CAMERA → CAMERA`, `ROUTER → ROUTER`, `SWITCH → SWITCH`, `ACCESS_POINT → ACCESS_POINT`, `IOT → IOT`, everything else (incl. `MOBILE`, `TABLET`, `PHONE`, `FIREWALL`, `UNKNOWN`, null) → `OTHER` **only when a device is linked**; unlinked hosts keep `'UNKNOWN'`. The device lookup query must select `device_type` in addition to `id`. INSERT uses the mapped value. UPDATE may set `node_type` **only** via `node_type = CASE WHEN network_nodes.node_type = 'UNKNOWN' THEN $mapped ELSE network_nodes.node_type END` — never a plain assignment.

- [ ] **Step 1: Write the failing tests (extend `tests/networkDiscovery.test.ts`)**

1. `test_ingest_sets_node_type_from_linked_device` — device lookup returns `{ id: 'dev-linked', device_type: 'PRINTER' }` → INSERT param contains `'PRINTER'`.
2. `test_ingest_maps_mobile_device_type_to_other` — device_type `'MOBILE'` → INSERT param contains `'OTHER'`.
3. `test_ingest_unlinked_host_stays_unknown` — no device match → INSERT param contains `'UNKNOWN'`.
4. `test_ingest_node_type_upgrade_is_guarded_to_unknown` — existing node row has `node_type: 'ENDPOINT'`, device links → UPDATE **must** contain the `CASE WHEN … 'UNKNOWN'` guard and the mapped value must appear only inside the guard (assert `/CASE[\s\S]*'UNKNOWN'[\s\S]*ENDPOINT|CASE[\s\S]*\$/.test(upd)` — concretely: `assert.ok(upd.includes('CASE'), …)` plus `assert.ok(!/SET[\s\S]*,\s*node_type\s*=\s*\$\d+/.test(upd), 'plain node_type assignment forbidden')`).
5. Strengthen `test_ingest_preserves_first_seen_and_identify_fields` (from Task 2's minimal edit): now that the guard exists, assert `upd.includes('CASE')` and the preserved-row scenario (`node_type: 'PRINTER'` scripted) still shows no plain assignment.

- [ ] **Step 2: Run to verify FAIL**

Run: `npx tsx tests/networkDiscovery.test.ts`
Expected: new checks FAIL (INSERT still hardcodes `'UNKNOWN'`).

- [ ] **Step 3: Implement**

In `ingestHost`: extend the device SELECT to `SELECT id, device_type FROM devices …`; add `mapDeviceTypeToNodeType` (pure `switch`/map as specified in Interfaces); INSERT's node_type becomes the mapped value or `'UNKNOWN'`; UPDATE appends the guarded CASE assignment; extend the metadata-merge test assumptions if needed.

- [ ] **Step 4: Run to verify green + full suite**

Run: `npx tsx tests/networkDiscovery.test.ts`, `npm test`, `npm run typecheck`.
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-api/src/services/discoveryService.ts backend-api/tests/networkDiscovery.test.ts
git commit -m "feat(discovery): infer node_type from linked agent device (guarded upgrade)"
```

---

### Task 4: Enroll-request tenant authorization + removal of superseded bare-JWT path

**Files:**
- Modify: `backend-api/src/services/installRequests.ts` (`createInstallRequests`, lines ~143-205)
- Modify: `backend-api/src/services/discoveryService.ts` (delete `requestEnrollment`, lines ~345-370; drop the now-unused `jwt`/`JWT` imports if nothing else in the file uses them)
- Modify: `backend-api/tests/installRequests.test.ts`
- Modify: `backend-api/tests/networkDiscovery.test.ts` (remove the two `requestEnrollment` checks; keep the rest of `test_mutations_scope_by_created_by` minus its enrollment segment)

**Interfaces:**
- Consumes: `canViewUnownedDevices` from `src/utils/tenant` (takes `{ permissions: string[] }`).
- Produces: `createInstallRequests` now returns `{ node_id, ok: false, reason: 'node_not_found' }` for nodes the caller cannot see (no existence leak — same reason as a missing node). Visibility rule: pass if `canViewUnownedDevices(user)` (i.e. `devices.view_all`) **or** `node.created_by === user.id`; the node SELECT already returns `created_by`. `discoveryService.requestEnrollment` is deleted; the live path is exclusively `createInstallRequests` via `netsentinel.ts:713` (already the case — this removes dead code that minted consent-bypassing 30-day `typ:'enroll'` JWTs and is only referenced by its own tests).

- [ ] **Step 1: Write the failing tests (`tests/installRequests.test.ts`)**

1. `create_blocks_node_from_another_tenant` — caller `{ id: 'u1', permissions: ['devices.manage'] }`, scripted node row `created_by: 'other-user'` → result `ok:false, reason:'node_not_found'`; assert **no** `INSERT INTO installation_requests` was emitted.
2. `create_allows_node_owner_without_view_all` — caller `{ id: 'u1', permissions: ['devices.manage'] }`, node `created_by: 'u1'` → proceeds (reuse the `create_success_inserts_and_marks_node_review_status` scripts; assert `ok:true`).
3. `create_allows_view_all_for_unowned_node` — caller with `devices.view_all`, node `created_by: null` → `ok:true`.

Update any existing `create_*` tests whose caller lacks visibility: add `devices.view_all` to their permission arrays or set `created_by` to the caller id (audit each `create_*` test: `already_enrolled`, `active_request_exists`, `success_inserts…`).

- [ ] **Step 2: Run to verify FAIL**

Run: `npx tsx tests/installRequests.test.ts`
Expected: test 1 FAILS (currently succeeds in creating a request for another tenant's node).

- [ ] **Step 3: Implement the visibility check; delete `requestEnrollment`**

In `createInstallRequests`, after loading the node row: `if (!canViewUnownedDevices(user) && row.created_by !== user.id) { push node_not_found; continue; }`. Delete `requestEnrollment` from `discoveryService.ts` and its `jwt`/`JWT` imports (verify with grep that nothing else in the file uses them). Remove `requestEnrollment` from the `networkDiscovery.test.ts` import block and delete `test_request_enrollment_returns_three_commands_and_token` plus the requestEnrollment half of `test_mutations_scope_by_created_by` (keep its `setNodeReview`/`identifyNode`/`getNode` segments).

- [ ] **Step 4: Run to verify green + full suite**

Run: `npx tsx tests/installRequests.test.ts`, `npx tsx tests/networkDiscovery.test.ts`, `npm test`, `npm run typecheck`.
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-api/src/services/installRequests.ts backend-api/src/services/discoveryService.ts backend-api/tests/installRequests.test.ts backend-api/tests/networkDiscovery.test.ts
git commit -m "fix(enrollment): tenant-scope createInstallRequests; remove superseded requestEnrollment JWT path"
```

---

### Task 5: review_status lifecycle across the decision flow

**Files:**
- Modify: `backend-api/src/services/installRequests.ts` (`recordDecision`, `cancelInstallRequest`, `expireStaleRequests`, `markIntegratedByDevice`)
- Modify: `backend-api/tests/installRequests.test.ts`

**Interfaces:**
- Consumes: existing `query` from `config/database`.
- Produces: three private helpers (not exported): `revertNodeEnrollment(nodeId: string)` → `UPDATE network_nodes SET review_status = 'new', updated_at = NOW() WHERE id = $1 AND review_status = 'enrollment_requested'`; `markNodeEnrolled(deviceId: string)` → `UPDATE network_nodes SET review_status = 'known', updated_at = NOW() WHERE device_id = $1 AND review_status = 'enrollment_requested'`. Call sites: `recordDecision` when the resulting status is `'refused'` (use the row's `node_id`); `cancelInstallRequest` after a successful cancel (the RETURNING row carries `node_id`); `expireStaleRequests` per expired row (**change `RETURNING id` to `RETURNING id, node_id`** and loop); `markIntegratedByDevice` after a successful flip (call `markNodeEnrolled(deviceId)`).

- [ ] **Step 1: Write the failing tests (`tests/installRequests.test.ts`)**

For each path, assert via `captureCalls` that a `UPDATE network_nodes` was emitted with the exact guard (`sql.includes("review_status = 'new'") && sql.includes("review_status = 'enrollment_requested'")` for reverts; `review_status = 'known'` + `WHERE device_id` for the enrolled flip) and that its params carry the node/device id:

1. `decision_refuse_reverts_node_to_new` — extend the existing `decision_refuse_from_pending` test's scripts with a `s('UPDATE network_nodes', [])` entry and the SQL assertions above.
2. `cancel_reverts_node_to_new` — new test: scripted `UPDATE installation_requests … RETURNING` row with `node_id`, assert revert SQL emitted.
3. `expire_sweep_reverts_nodes_to_new` — extend `expire_sweep_targets_pending_and_delivered_only`: scripted expired rows now include `node_id`; assert one revert per row.
4. `integrated_marks_node_known` — extend `integrated_only_flips_from_installed`: after the successful flip, assert `UPDATE network_nodes … 'known'` with `WHERE device_id`.
5. `integrated_does_not_touch_nodes_not_in_enrollment_requested` — guard is part of the SQL itself; assert the SQL string contains `review_status = 'enrollment_requested'` (the clobber-prevention contract lives in the WHERE clause).

- [ ] **Step 2: Run to verify FAIL**

Run: `npx tsx tests/installRequests.test.ts`
Expected: FAIL — no `UPDATE network_nodes` emitted from any of these flows.

- [ ] **Step 3: Implement the helpers and call sites**

As specified in Interfaces. `expireStaleRequests` loop: `for (const row of stale.rows) { await audit(...); if (row.node_id) await revertNodeEnrollment(row.node_id); }` (preserve the existing audit call).

- [ ] **Step 4: Run to verify green + full suite**

Run: `npx tsx tests/installRequests.test.ts`, `npm test`, `npm run typecheck`.
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-api/src/services/installRequests.ts backend-api/tests/installRequests.test.ts
git commit -m "feat(enrollment): node review_status follows decision lifecycle"
```

---

### Task 6: Register-gate E2E (HTTP) + markInstalling coverage

**Files:**
- Modify: `backend-api/tests/installRequests.test.ts` (mount `devicesRouter` like `networkDiscovery.test.ts` does for its HTTP section)

**Interfaces:**
- Consumes: `POST /api/devices/register` with `X-Agent-Secret` header + install token in body (`enroll_token` field carrying a `typ:'install'` JWT — see `firstInstallToken` in `devices.ts:175-181` and the token construction used by `device_decision_endpoint_accepts_install_jwt_json`).
- Produces: no production changes unless a test reveals a defect (if `POST /register` with a refused token does not403 or still marks the request installed, fix the handler in `devices.ts` and note it in the report — the gate logic at `devices.ts:343-352` already exists, so this task should be pure test unless something is broken).

- [ ] **Step 1: Write the failing tests**

Build a minimal express app in the test mounting `express.json()` + `/api/devices` devicesRouter (copy the harness setup from `networkDiscovery.test.ts` lines 575-582; the FakePool is already installed in this file). Sign install JWTs with a helper (extract the pattern from `device_decision_endpoint_accepts_install_jwt_json`):

1. `register_with_refused_install_token_is_403_and_creates_nothing` — scripted `WHERE r.install_jti` row with `status: 'refused'`; `POST /register` with agent secret + token → status 403; assert no `INSERT INTO devices` and no `SET status = 'installed'` emitted.
2. `register_with_expired_install_token_is_403` — same with `status: 'expired'` → 403.
3. `register_with_authorized_install_token_marks_request_installed` — scripted gate row `status: 'authorized'`, `node_id` present; `FROM devices WHERE agent_id` empty; `ip_address IS NOT NULL` (findDeviceByIp) empty; INSERT `RETURNING id` → `{ id: 'dev-new' }`; assert 201, `UPDATE installation_requests … 'installed'` emitted with `'dev-new'`, and `UPDATE network_nodes … device_id` emitted (via `markRequestInstalledDevice`).
4. `install_script_fetch_marks_request_installing` — extend or add: scripted `WHERE r.install_jti` row `status: 'authorized'`; `GET /public/install.ps1?t=<token>` → assert `SET status = 'installing'` emitted (covers the untested `markInstalling` path at `devices.ts:1815`). Note: this route reads `public/install.ps1` from disk — already exercised by `installAccess.test.ts`, so the file exists.

- [ ] **Step 2: Run to verify FAIL**

Run: `npx tsx tests/installRequests.test.ts`
Expected: any check asserting behavior that does not hold FAILS; if all four pass immediately, **stop** — the tests would be documenting existing behavior, so re-verify the assertions are actually reaching the HTTP handler (common cause: wrong field name for the token — it is `enroll_token` in the body, or `t`).

- [ ] **Step 3: Fix defects only if a test fails**

If a gate defect surfaces (e.g. refused token not rejected), patch `devices.ts` minimally and record it for the phase report. Otherwise no production file changes.

- [ ] **Step 4: Run to verify green + full suite**

Run: `npx tsx tests/installRequests.test.ts`, `npm test`, `npm run typecheck`.
Expected: ALL PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-api/tests/installRequests.test.ts
git commit -m "test(enrollment): HTTP register-gate and installing-transition coverage"
```

(Include any `devices.ts` fix in the same commit with a `fix(enrollment):` prefix if one was needed.)

---

### Task 7: Phase verification and report

- [ ] **Step 1: Full verification**

Run from `backend-api/`: `npm test`, `npm run typecheck`, `npm run lint`. From repo root: `git log --oneline main..feat/p0-discovery-enrollment` to list the phase's commits.

- [ ] **Step 2: Deliver the PT-PT phase report**

Report (conversation, not a file): ficheiros alterados por commit; todos os testes executados com resultado; decisões de design (dedup por MAC, confidence em metadata sem nova coluna, remoção de `requestEnrollment`); riscos residuais (tamanho da imagem Docker +5.7 MB com `oui-data`; ingest continua N+1 — otimização adiada; `expireStaleRequests` passou a fazer 1 UPDATE extra por linha expirada); próximos passos (merge após revisão, Fase C segurança).

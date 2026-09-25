# EndpointX Roadmap

> Next release: **v1.2.0** — "Reliable Observability for Endpoints"
> Current release: **v1.1.0** (HERMES, NetSentinel, IAM/RBAC, landing site)

This document is the single source of truth for what we build next.
Pick tasks from [v1.2.0 scope](#v120-scope) and open a PR referencing the milestone.

---

## Where EndpointX stands today (v1.1.0)

Honest assessment against tools like Zabbix / PRTG / LibreNMS:

| Area | Status | Notes |
| --- | --- | --- |
| Agent (CPU/RAM/disk/network, inventory) | ✅ Real | Heartbeat 60s, security scan 10min, tamper detection, remote containment |
| Device management & commands | ✅ Real | Reboot, isolate/quarantine, auto-update, offline queue |
| HERMES port scan & risk scoring | ✅ Real | TCP scan, banner grab, port baselines, risk score, recommendations |
| RBAC / MFA / audit trail | ✅ Real | Granular permissions, immutable audit logs |
| Metrics storage | ⚠️ Basic | `device_heartbeats` append-only, no retention, queries capped at ~100 points |
| Alert rules (thresholds) | ❌ Missing | Metrics are stored but never evaluated (no `cpu > 90 for 5m`) |
| Notifications | ⚠️ Partial | Email only on manual alerts; test endpoint is a stub; no webhooks |
| Agentless monitoring (SNMP/ICMP) | ❌ Missing | Cannot monitor switches, routers, printers |
| NetSentinel / NAC | ⚠️ Stub | API exists, no UI, connectors are seed-only |
| Real-time (Socket.IO) | ⚠️ Broken | Frontend listens, backend never emits |

**Strategic position:** EndpointX competes as **endpoint security + EPM** (like Fleet / Wazuh / Intune-lite), **not** as a full NMS. Trying to beat Zabbix on SNMP/templates/HA first is a losing game; we harden our niche and add the monitoring basics that matter for endpoints.

---

## v1.2.0 scope

Five milestones, ordered by user impact. Each task should be an issue + PR.

### M1 — Alerting that actually works _(priority: high)_

- [ ] Threshold engine: evaluate `cpu_usage`, `ram_usage`, `disk_usage`, `offline` on the server (table `alert_rules`, job every minute)
- [ ] Wire the already-existing `max_cpu_usage` / `max_disk_usage` policy fields that the UI shows but the backend ignores
- [ ] Send email on **automatic** alerts (agent security scan, tamper, HERMES) — today only manual alerts send mail
- [ ] Fix `POST /notifications/test` to really send an email (currently inserts a fake `notification_log` row)
- [ ] Connect UI SMTP settings (`notification_*`) to `emailService.ts` (today it only reads `process.env`)
- [ ] Generic outgoing **webhook** per alert (Slack/Discord/Teams-compatible JSON payload)
- [ ] Alert lifecycle: ack, re-arm, 1h dedup as a shared helper (replace per-endpoint special cases)

### M2 — Metric retention & truthful charts _(priority: high)_

- [ ] Retention job for `device_heartbeats` honouring `data_retention_days` (today: table grows forever)
- [ ] Rollups: 5m → 1h → 1d aggregates so charts can show months, not `LIMIT 100`
- [ ] Time-range queries (`?from=&to=&interval=`) for device history and bandwidth
- [ ] Fix wrong metrics: bandwidth must be **rates** (counters are cumulative), `/network/stats` "average latency" must not be `AVG(ram_usage)`
- [ ] Relabel the fake "Heartbeat Trend (Last 24h)" chart (it currently shows 24 rows ≈ 24 minutes)

### M3 — Deeper endpoint telemetry _(priority: medium)_

- [ ] Periodic inventory re-collection (today software/services are sent only on the **first** heartbeat)
- [ ] Windows Event Log + Linux journald collection (security-relevant events → `security_events`)
- [ ] Per-partition disk metrics (today only `C:\` or `/`)
- [ ] Network interfaces as rates per interface (not only global counters)

### M4 — HERMES depth _(priority: medium)_

- [ ] Real CVE feed (NVD API or offline dataset) replacing the 5 hardcoded `LOCAL_CVE_RULES`
- [ ] Scheduled daily scan (setting `hermes_daily_scan_enabled` exists, no scheduler behind it)
- [ ] Call `discoverUnknownAsset` (defined but never invoked) or delete it
- [ ] UDP / IPv6 support in the scanner (optional, behind the Safe policy)

### M5 — Product cleanup & integration _(priority: medium)_

- [ ] **Decide NetSentinel's fate**: ship UI + real discovery **or** remove dead routes/connectors stub (issue: "NetSentinel: build or remove")
- [ ] Wire Socket.IO emitters (`websocket/index.ts`) so the dashboard gets live updates instead of polling
- [ ] `/metrics` Prometheus endpoint (OpenMetrics) for external scraping
- [ ] Outgoing webhooks documented in `docs/api.md`; API keys for third parties (optional stretch)

### Definition of done for v1.2.0

1. `npm run typecheck` (backend) and `npm run build` (dashboard) pass
2. New tables created via migration-safe seed (existing DBs must upgrade cleanly)
3. PT + EN strings added for every new UI text (`admin-dashboard/src/i18n/index.tsx`, `backend-api/public/site/js/i18n.js`)
4. Docs updated (`docs/api.md`, this roadmap, README if user-facing)
5. No secrets committed; `.env` stays ignored

---

## Later (v1.3.0+): optional NMS track

Only if the endpoint track is solid. Rough order:

1. **Agentless checks**: ICMP ping + HTTP/TCP scheduled checks
2. **SNMP v2c/v3 poller** (interfaces, CPU, disk of network gear)
3. **Real discovery**: ping sweep / ARP scan (replace the current "discovery" that only copies registered devices into `network_nodes`)
4. Topology **map UI** (endpoint `/netsentinel/topology` exists, has no consumer)
5. Templates, maintenance windows, HA/workers, read replicas

Do **not** start these before M1–M2 of v1.2.0 are merged.

---

## How to pick up a task

1. Search open issues labelled `roadmap` and `good first issue`
2. Comment on the issue saying you take it (avoid duplicate work)
3. Branch: `feat/1.2.0-<short-slug>` or `fix/1.2.0-<short-slug>`
4. Open a PR using the PR template; link `Closes #<issue>`
5. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, conventions and checks

### Suggested labels (for maintainers)

`roadmap` · `milestone:1.2.0` · `good first issue` · `help wanted` ·
`backend` · `frontend` · `agent` · `docs` · `priority:high` · `priority:medium`

# HERMES API

Base path: `/api/hermes`  
All admin endpoints require JWT authentication + permission.

## Status

`GET /api/hermes/status` — `hermes.view`

Returns assets, vulnerability counts by severity, security score, active scans, top findings, emergency stop flag.

## Scans

| Method | Path | Permission |
|--------|------|------------|
| POST | `/scans` | `hermes.manage` |
| GET | `/scans` | `hermes.view` |
| GET | `/scans/:id` | `hermes.view` |
| POST | `/scans/:id/stop` | `hermes.manage` |
| POST | `/emergency-stop` | `hermes.manage` |

### Start scan body

```json
{ "scan_type": "quick | daily | weekly | full | custom" }
```

## Assets & findings

| Method | Path | Permission |
|--------|------|------------|
| GET | `/assets` | `hermes.view` |
| GET | `/assets/:id` | `hermes.view` |
| GET | `/findings?severity=&status=` | `hermes.view` |
| GET | `/vulnerabilities` | `hermes.view` |
| GET | `/alerts` | `hermes.view` |
| GET | `/risk` | `hermes.view` |
| GET | `/attack-surface` | `hermes.view` |

## Recommendations (remediation approval)

| Method | Path | Permission |
|--------|------|------------|
| GET | `/recommendations` | `hermes.view` |
| POST | `/recommendations/:id/approve` | `hermes.approve` |
| POST | `/recommendations/:id/reject` | `hermes.approve` |
| POST | `/findings/:id/exception` | `hermes.approve` |

### Exception body

```json
{
  "exception_type": "confirm_finding | false_positive | accept_risk | ignore_until | create_exception",
  "reason": "Required justification",
  "expires_at": "2026-12-31T00:00:00Z"
}
```

History is never silently deleted.

## Reports & audit

| Method | Path | Permission |
|--------|------|------------|
| GET | `/reports` | `hermes.view` |
| GET | `/audit` | `hermes.view` |
| GET | `/policies` | `hermes.view` |

## Forensic investigations (read-only)

Collection runs on the endpoint through the agent (`forensic_collect`) and never
modifies files, logs, registry keys or processes. Browser history and event log
sections are gated by the `hermes_collect_browser` / `hermes_collect_eventlog`
settings.

| Method | Path | Permission |
|--------|------|------------|
| POST | `/investigations` | `hermes.manage` |
| GET | `/investigations?device_id=&limit=` | `hermes.view` |
| GET | `/investigations/:id` | `hermes.view` |
| GET | `/investigations/:id/report?format=json\|md` | `hermes.view` |
| POST | `/investigations/:id/cancel` | `hermes.manage` |

### Start body

```json
{
  "alert_id": "uuid",
  "sections": ["processes", "connections", "files", "persistence", "browser", "events", "users"]
}
```

`sections` is optional and defaults to all of them. The endpoint must be online;
otherwise `409`. `409` is also returned when an investigation for that alert is
already running, and the error body carries `investigationId` so the client can
open it.

Status flow: `queued → collecting → analyzing → complete | failed | cancelled`.

Every statement in the report is labelled `observation | evidence | indicator |
correlation | hypothesis | conclusion`. Sections the agent did not return are
listed under `gaps` and are never reported as negative findings. Retention:
`hermes_forensic_retention_days` (default 90).

Response envelope: `{ "success": true, "data": { ... } }`.

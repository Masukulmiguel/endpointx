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

Response envelope: `{ "success": true, "data": { ... } }`.

# HERMES Security

HERMES is a **privileged component**. It performs defensive assessment only.

## Hard constraints

- Never scans outside `hermes_allowed_cidrs` and authorized devices.
- Never implements ransomware, keyloggers, credential theft, malware, AV evasion, DoS, brute-force, or destructive exploitation.
- Emergency stop immediately sets all running/pending scans to `stopped`.

## RBAC

| Permission | Purpose |
|------------|---------|
| `hermes.view` | Read status, findings, assets, reports |
| `hermes.manage` | Start/stop scans, emergency stop |
| `hermes.approve` | Approve/reject recommendations, manage exceptions |

Admin role receives all three. Supervisor/technician get view only (new DBs).

## Rate limiting

Per scan policy:

- `max_concurrency` (default 5)
- `rate_limit_per_sec` (default 20)
- `request_timeout_ms` (default 2000)
- Excluded ports and excluded hosts

Banner grabs only on common service ports with short timeouts.

## Evidence & confidence

Findings store:

- `evidence[]` (JSON checks performed)
- `confidence` (0–100)
- `is_potential` for uncertain matches
- AI/HEMES explanations never invent CVEs — only rule/DB matches with sources

## Audit

Every scan start/stop/complete, recommendation decision, exception, and emergency stop writes `hermes_audit_logs`.

## Secrets

Uses existing `AGENT_SECRET` / JWT / DB credentials. No new secret material is introduced by HERMES.

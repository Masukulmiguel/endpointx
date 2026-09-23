# HERMES Threat Model

## Assets

- PostgreSQL (`endpointx-db`)
- API JWT / session tokens
- Agent secret
- HERMES scan orchestration (privileged)

## Adversaries

1. **Compromised admin session** — could start broad scans or approve bad remediations.
2. **Malicious insider** — abuse HERMES as a network reconnaissance tool.
3. **Compromised agent** — false inventory / tamper.
4. **External attacker** — if API exposed without auth (mitigated by JWT + RBAC).

## Mitigations

| Threat | Control |
|--------|---------|
| Scan outside scope | Allowed CIDR check + authorized devices only |
| Scan flood / DoS | Rate limit, concurrency, timeout, emergency stop |
| Privilege abuse | RBAC `hermes.view/manage/approve`, audit logs |
| Tampered agent | Existing agent hash + `tamper_detected` alert |
| Silent finding deletion | Exceptions keep history (`hermes_exceptions`) |
| False positive hiding | Explicit reason required; actor stored |
| Secrets leakage | No secrets in findings/reports; env-only config |

## Out of scope

Offensive exploitation, credential attacks, malware, data exfiltration.

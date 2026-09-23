# HERMES Architecture

**H**ost **E**valuation **R**isk **M**onitoring **E**ngine **S**ecurity

HERMES is the defensive security intelligence engine of EndpointX/NetSentinel.

## Principles

- Only authorized devices, registered endpoints, agent-installed hosts, and administrator-configured CIDR ranges.
- Defensive security assessment only — no offensive exploitation.
- Every conclusion carries evidence, confidence, source, and timestamp.
- Disruptive remediation requires administrator approval.

## Structure

```text
backend-api/src/routes/hermes.ts   API + scan runner
admin-dashboard/src/pages/HermesPage.tsx  /hermes UI
database tables: hermes_*
```

## Pipeline

```text
OBSERVE → DISCOVER → IDENTIFY → ANALYZE → CORRELATE → ASSS → ALERT → RECOMMEND → RECHECK
```

1. **Asset Discovery** — sync authorized devices; unknown IPs become review queue items (`UNKNOWN ASSET DETECTED`).
2. **Port/Service Scan** — rate-limited TCP connect probes (non-destructive), banner grab, service identification with confidence.
3. **Endpoint Inventory** — uses agent software/services data (no passwords/keystrokes/content).
4. **CVE Correlation** — version-aware local rules + NVD references; uncertain matches marked `POTENTIAL`.
5. **Risk Engine** — CVSS, exposure, open ports, findings → posture score with reasons.
6. **HERMES Intelligence** — explains risk with evidence checklist (never invents CVEs).
7. **Continuous Monitoring** — baselines for open ports; new ports raise `NEW ATTACK SURFACE`.
8. **Alerts** — critical vuln, unknown device, new port, risky service, offline agent, etc.
9. **Reports** — `/api/hermes/reports` JSON assessment.
10. **Remediation** — recommendations require Approve/Reject; HERMES never auto-executes disruptive actions.

## Scan policies

| Policy | Scope |
|--------|--------|
| Safe Scan | Discovery, ports, services, versions, vuln correlation |
| Standard Scan | + configuration, applications, posture |
| Deep Assessment | Deeper non-destructive checks on authorized assets only |

## Abuse protection

- `hermes_allowed_cidrs`
- Excluded ports/hosts
- Concurrency + rate limit + request timeout
- `STOP ALL HERMES SCANS` emergency stop (`POST /api/hermes/emergency-stop`)
- RBAC: `hermes.view`, `hermes.manage`, `hermes.approve`
- Full audit log in `hermes_audit_logs`

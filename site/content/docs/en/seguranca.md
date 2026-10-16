---
title: Security and permissions
lead: Sessions, MFA, roles, auditing and download protection.
description: How EndpointX validates sessions, tokens and MFA, which roles and permissions exist, how actions are audited, and what downloads and the agent collect.
---

## Sessions and tokens

- **Short-lived access token** — JWT signed with `JWT_ACCESS_SECRET`, valid for 1 hour by default (`JWT_EXPIRES_IN`), always bound to a session (`sid` = the row in `user_sessions`). Tokens without `sid`, expired tokens or tokens whose session was revoked are rejected (`AUTH_SESSION_INVALID`, «Invalid session token.»).
- **7-day refresh token** — stored only as a SHA-256 hash in `user_sessions`, rotated on every use (renewal extends validity by another 7 days) and terminated on logout.
- **Step-up MFA** — temporary `mfa_temp` tokens (issued at login) never pass the session gate: only after `POST /api/auth/mfa-verify` is a full session token issued.
- **Account lockout** — 5 failed login attempts (`MAX_LOGIN_ATTEMPTS`) lock the account for 15 minutes (`LOCKOUT_DURATION`, 900000 ms); passwords are hashed with bcrypt at 12 rounds, 12 characters minimum with upper case, lower case, number and symbol.
- **Agent credentials** — agents never use administrator sessions: they authenticate with the fleet secret (`X-Agent-Secret`) and, where applicable, with the enrollment token (30 days) or installation token (7 days) written into their configuration.

```json
{
  "sub": "…",
  "role_id": "…",
  "sid": "…",
  "iat": 1792000000,
  "exp": 1792003600
}
```

## MFA

- **Where** — TOTP (compatible with Google Authenticator, Authy and friends): the panel has the MFA area under **Security**, with a QR code to register the app and 10 recovery codes stored with bcrypt (each one works once).
- **At login** — if the account has MFA enabled, `POST /api/auth/login` returns `requiresMfa: true` with an `mfa_temp`; `POST /api/auth/mfa-verify` accepts the TOTP code or a recovery code and only then issues the real session (the `login_mfa` action is written to the audit trail).
- **Optional by default** — the `mfa_required` setting («Require MFA for all users») ships as `false`; when enabled, MFA stops being optional for panel users.
- **In development** — today it is TOTP and recovery codes only; verification by SMS, email and hardware keys (FIDO2) are planned, not implemented in this version.

## Roles and permissions

Four system roles, with permissions assigned at seed time (`SEED_ROLE_PERMISSIONS`):

| Role | Scope |
|------|-------|
| `admin` | Every permission in the catalog (full access) |
| `supervisor` | Device and user management (`devices.manage`, `devices.commands`, `users.view`, `logs.view`, alerts, networks) |
| `technician` | View devices and run commands (`devices.view`, `devices.commands`, `alerts.view`, `network.view`) |
| `user` | View-only (read) — the role free sign-ups receive |

- Enforcement happens on the server: every route uses `requirePermission(...)` and without the permission you get `403` with `AUTH_PERMISSION_DENIED` — even if the JWT says otherwise (permissions are read from the database with a 60-second cache, so a permission change always lands on the next session renewal).
- New registrations enter as `user` (free early access); administrators invite others with `POST /api/auth/invite`, which requires `users.manage` and picks the invitee's role.

```json
{
  "success": false,
  "error": {
    "message": "You do not have the required permissions to perform this action.",
    "code": "AUTH_PERMISSION_DENIED"
  }
}
```

## Audit logs

- `audit_logs` is **append-only**: panel routes only read, never write or delete — rows are written solely by the API itself on sensitive operations.
- Reading requires `logs.view`: `GET /api/audit` (paginated with `page`/`limit`), `GET /api/audit/stats` and `GET /api/audit/:id`; export requires `logs.export` on `GET /api/audit/export`, a CSV file with the 1000 most recent rows (columns ID, User, Action, Target, Description, IP, Date).
- Recorded actions include `login`, `logout`, `login_mfa`, `command_execute`, `scan_stopped`, `emergency_stop_enabled`, device approvals and installation decisions — always with the acting user and source IP.

```bash
curl -H "Authorization: Bearer <ACCESS_TOKEN>" https://endpointx-api-5ypc.onrender.com/api/audit/export -o audit-logs.csv
```

## Download protection

> **Note:** protecting the public binaries (Windows installer and APK) — a valid enrollment token or an authorized session — is platform behaviour in version 1.3.0, landing in the same release.

What already works this way today:

- The installation scripts (`install.ps1`, `install-linux.sh`, `install-macos.sh`) require an enrollment token in `?t=`; without it the API answers `403` «Valid enrolment token required».
- Internal panel downloads require an authenticated session: `GET /api/devices/download/installer` needs `devices.manage` and `GET /api/devices/download/agent/:filename` a valid session.
- Enrollment tokens are only issued to sessions holding `devices.manage` (`GET /api/devices/enroll-token`), and the scripts never store administrator credentials — only the enrollment token in the agent's configuration.

## What EndpointX does not collect

The agent **never** collects passwords, keystrokes or file contents — only what is needed to manage and protect the device: hardware and software inventory, processes and services, CPU, memory, disk and network metrics, and the device's connection state.

- Device data stays in the database of your own installation (PostgreSQL): the agent only talks to the EndpointX API and the records live where you run them. Separately, the OSINT module queries public external sources (e.g. WHOIS, Shodan) only when someone runs a lookup — and optional SSO connects to Microsoft/Google only if you enable it.
- Every module's scope is declared by the API: `GET /api/netsentinel/privacy` returns what the Zero Trust layer reads and writes.
- Modules still in development (NAC, software deployment, CVE feed) are marked as in development in this version 1.3.0, just like the rest of the product.

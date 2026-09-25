# Security Policy

## Reporting a vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

- **Email**: security@endpointx.example.com
- **Response time**: within 48 hours
- Include: affected component/version, reproduction steps, impact

You will be credited in the release notes unless you prefer otherwise.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.1.x   | ✅ current |
| < 1.1   | ❌ upgrade required |

## Scope

EndpointX is a **defensive** platform. Out of scope by design:

- Offensive tooling requests (exploits, credential attacks, DoS)
- HERMES misuse against unauthorized assets — scanning only targets
  registered/authorized devices with a CIDR allow-list

## Secrets & configuration

- Never commit `.env`, JWT secrets, `AGENT_SECRET`, SMTP or API keys
- Rotate any key that leaks (Render environment variables + database)
- The admin password must be set via `SEED_ADMIN_PASSWORD` on first deployment
  (no default credentials ship with the repository) and rotated regularly

## Hardening checklist for operators

- Serve API/dashboard behind HTTPS only
- Keep PostgreSQL and Render services on private networking where possible
- Restrict agent enrollment (`X-Agent-Secret`) and rotate it periodically
- Review `audit_logs` regularly; RBAC permissions follow least privilege

# EndpointX Security Documentation

## Overview

This document describes the security architecture, mechanisms, and best practices implemented in the EndpointX platform. Security is a core design principle woven throughout every layer of the system.

## Table of Contents

- [Authentication](#authentication)
- [Password Policies](#password-policies)
- [Multi-Factor Authentication](#multi-factor-authentication)
- [Session Management](#session-management)
- [Role-Based Access Control](#role-based-access-control)
- [Audit Logging](#audit-logging)
- [Data Encryption](#data-encryption)
- [Network Security](#network-security)
- [Agent Security](#agent-security)
- [Vulnerability Management](#vulnerability-management)
- [Incident Response](#incident-response)
- [Compliance](#compliance)

---

## Authentication

### JWT-Based Authentication

EndpointX uses JSON Web Tokens (JWT) for stateless authentication.

| Token Type      | Algorithm | Lifetime  | Storage           | Purpose              |
| --------------- | --------- | --------- | ----------------- | -------------------- |
| Access Token    | HS256     | 15 minutes| Memory / State    | API authorization    |
| Refresh Token   | HS256     | 7 days    | HttpOnly Cookie   | Token renewal        |
| Agent Token     | HMAC-SHA256| 30 days  | Local file (encrypted) | Agent-server auth |

### Token Structure

**Access Token Payload:**

```json
{
  "sub": "user-uuid",
  "email": "admin@company.com",
  "role": "admin",
  "permissions": ["device:read", "device:write", ...],
  "iat": 1705312800,
  "exp": 1705313700
}
```

### Authentication Flow

```
┌──────────┐                    ┌──────────┐
│  Client   │                    │  Server   │
└────┬─────┘                    └────┬─────┘
     │                               │
     │  POST /auth/login             │
     │  { email, password }          │
     │──────────────────────────────▶│
     │                               │──▶ 1. Validate input
     │                               │──▶ 2. Look up user
     │                               │──▶ 3. Compare password (bcrypt)
     │                               │──▶ 4. Check account lockout
     │                               │──▶ 5. Generate access token
     │                               │──▶ 6. Generate refresh token
     │                               │──▶ 7. Hash refresh token
     │                               │──▶ 8. Store refresh token hash
     │                               │──▶ 9. Create audit log
     │  200 { tokens, user }         │
     │◀──────────────────────────────│
     │                               │
     │  GET /api/resource            │
     │  Authorization: Bearer <jwt>  │
     │──────────────────────────────▶│
     │                               │──▶ 1. Extract token
     │                               │──▶ 2. Verify signature
     │                               │──▶ 3. Check expiration
     │                               │──▶ 4. Load permissions
     │                               │──▶ 5. Check RBAC
     │                               │──▶ 6. Create audit log
     │  200 { data }                 │
     │◀──────────────────────────────│
```

### Account Lockout

| Parameter              | Value  |
| ---------------------- | ------ |
| Max Failed Attempts    | 5      |
| Lockout Duration       | 30 min |
| Counter Reset After    | 15 min of no failures |
| Notification           | Email to user and admin |

**Lockout Trigger Logic:**

```
IF failed_attempts >= 5 AND last_failed_at > NOW() - INTERVAL '15 minutes'
THEN account_locked_until = NOW() + INTERVAL '30 minutes'
```

---

## Password Policies

### Requirements

| Policy                     | Minimum    | Recommended |
| -------------------------- | ---------- | ----------- |
| Length                     | 12 chars   | 16+ chars   |
| Uppercase letters          | 1          | 2+          |
| Lowercase letters          | 1          | 2+          |
| Numbers                    | 1          | 2+          |
| Special characters         | 1          | 2+          |
| No common passwords        | Yes        | Yes         |
| No email in password       | Yes        | Yes         |
| No user name in password   | Yes        | Yes         |
| Password history           | 12         | 24          |
| Max age                    | 90 days    | 60 days     |
| Min age (before change)    | 1 day      | 1 day       |

### Hashing Algorithm

- **Algorithm**: bcrypt
- **Cost Factor**: 12 (configurable via `BCRYPT_ROUNDS` env var)
- **Salt**: Automatically generated per password

```javascript
// Hashing
const hash = await bcrypt.hash(password, 12);

// Verification
const isValid = await bcrypt.compare(inputPassword, storedHash);
```

### Password Complexity Validation

```typescript
const passwordSchema = z.string()
  .min(12, "Password must be at least 12 characters")
  .max(128, "Password must not exceed 128 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number")
  .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character");
```

---

## Multi-Factor Authentication

### Implementation Status

MFA is implemented but optional. Enable via settings.

### Supported Methods

| Method              | Status    | Description                     |
| ------------------- | --------- | ------------------------------- |
| TOTP (Authenticator)| Active    | Google Authenticator, Authy     |
| SMS                 | Planned   | Via Twilio integration          |
| Email               | Planned   | Via SMTP                        |
| Hardware Keys       | Planned   | FIDO2/WebAuthn                  |

### TOTP Setup Flow

```
1. User enables MFA in profile settings
2. Server generates TOTP secret
3. Server returns QR code URL
4. User scans QR with authenticator app
5. User enters verification code
6. Server verifies code and activates MFA
7. Server generates backup codes (10 single-use codes)
```

### Backup Codes

- 10 single-use codes generated on MFA setup
- Stored as bcrypt hashes
- Can be used if authenticator device is lost
- Regenerating MFA invalidates old backup codes

---

## Session Management

### Access Token Lifecycle

```
┌─────────────────────────────────────────────────────────┐
│                    Access Token                         │
│                                                         │
│  Created ──────────────────────────────▶ Expired        │
│    │                                       │            │
│    │  [Valid for API calls]                │            │
│    │                                       │            │
│    └──▶ Refresh ──▶ New Token              │            │
│          (before expiry)                   │            │
└─────────────────────────────────────────────────────────┘
```

### Token Refresh Strategy

1. Client attempts API call with expired token
2. Server returns `401 Unauthorized`
3. Client sends refresh request with refresh token
4. Server validates refresh token (not expired, not revoked)
5. Server issues new access token
6. Server rotates refresh token (old one invalidated)
7. Client retries original API call with new token

### Session Invalidation

| Event                  | Action                                |
| ---------------------- | ------------------------------------- |
| User logout            | Revoke refresh token                  |
| Password change        | Revoke all refresh tokens             |
| Role change            | Revoke all refresh tokens             |
| Account deactivation   | Revoke all tokens                     |
| Admin force logout     | Revoke all tokens for user            |
| Token expiry           | Automatic expiration                  |

### Redis Session Store

```javascript
// Refresh token storage in Redis
await redis.setex(
  `refresh:${tokenHash}`,
  7 * 24 * 60 * 60, // 7 days TTL
  JSON.stringify({
    userId: "user-uuid",
    createdAt: "2025-01-15T10:30:00Z",
    userAgent: "Mozilla/5.0...",
    ipAddress: "192.168.1.50"
  })
);
```

---

## Role-Based Access Control

### Roles

| Role           | Description                           | Default |
| -------------- | ------------------------------------- | ------- |
| `admin`        | Full system access                    | No      |
| `supervisor`   | Device and command management         | No      |
| `technician`   | Device monitoring and commands        | Yes     |
| `user`         | View own devices only                 | No      |

### Permissions Matrix

| Permission            | Admin | Supervisor | Technician | User |
| --------------------- |:-----:|:----------:|:----------:|:----:|
| **Device**            |       |            |            |      |
| `device:read`         | ✅    | ✅         | ✅         | ✅*  |
| `device:write`        | ✅    | ✅         | ❌         | ❌   |
| `device:delete`       | ✅    | ❌         | ❌         | ❌   |
| `device:block`        | ✅    | ✅         | ❌         | ❌   |
| `device:unblock`      | ✅    | ✅         | ❌         | ❌   |
| `device:quarantine`   | ✅    | ✅         | ❌         | ❌   |
| **Command**           |       |            |            |      |
| `command:read`        | ✅    | ✅         | ✅         | ✅*  |
| `command:create`      | ✅    | ✅         | ✅         | ❌   |
| `command:cancel`      | ✅    | ✅         | ❌         | ❌   |
| **User**              |       |            |            |      |
| `user:read`           | ✅    | ✅         | ❌         | ❌   |
| `user:create`         | ✅    | ✅         | ❌         | ❌   |
| `user:write`          | ✅    | ✅         | ❌         | ❌   |
| `user:delete`         | ✅    | ❌         | ❌         | ❌   |
| **Role**              |       |            |            |      |
| `role:read`           | ✅    | ✅         | ❌         | ❌   |
| `role:create`         | ✅    | ❌         | ❌         | ❌   |
| `role:write`          | ✅    | ❌         | ❌         | ❌   |
| `role:delete`         | ✅    | ❌         | ❌         | ❌   |
| **Alert**             |       |            |            |      |
| `alert:read`          | ✅    | ✅         | ✅         | ❌   |
| `alert:dismiss`       | ✅    | ✅         | ❌         | ❌   |
| **Security**          |       |            |            |      |
| `security:read`       | ✅    | ✅         | ❌         | ❌   |
| `security:resolve`    | ✅    | ✅         | ❌         | ❌   |
| **Audit**             |       |            |            |      |
| `audit:read`          | ✅    | ✅         | ❌         | ❌   |
| `audit:export`        | ✅    | ❌         | ❌         | ❌   |
| **Settings**          |       |            |            |      |
| `settings:read`       | ✅    | ✅         | ❌         | ❌   |
| `settings:write`      | ✅    | ❌         | ❌         | ❌   |
| **Dashboard**         |       |            |            |      |
| `dashboard:read`      | ✅    | ✅         | ✅         | ❌   |

> *✅* = With scope restriction (own devices only)

### Permission Check Flow

```
Request → Extract JWT → Verify Signature → Load Permissions → Check Permission → Allow/Deny
                │              │                    │                   │
                │              │                    │                   │
                ▼              ▼                    ▼                   ▼
           Decode payload   Validate         Query role_permissions   Compare required
           Extract user_id  expiration       Load user permissions    vs user permissions
```

### Middleware Implementation

```typescript
const requirePermission = (permission: string) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    const hasPermission = user.permissions.includes(permission);
    
    if (!hasPermission) {
      // Log unauthorized access attempt
      await auditLog({
        userId: user.id,
        action: 'access_denied',
        resource: permission,
        ipAddress: req.ip
      });
      
      return res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN',
          message: `Insufficient permissions: ${permission}`
        }
      });
    }
    
    next();
  };
};
```

---

## Audit Logging

### What Gets Logged

| Event Type           | Details Captured                              |
| -------------------- | --------------------------------------------- |
| Authentication       | Login, logout, failed attempts, lockouts      |
| Authorization        | Permission checks (both pass and fail)        |
| CRUD Operations      | Create, read, update, delete on all resources |
| Device Actions       | Block, unblock, quarantine, command execution  |
| Security Events      | Policy violations, suspicious activity        |
| Configuration Changes| Settings updates, role modifications          |
| Exports              | CSV/data exports                              |

### Audit Log Schema

```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  action VARCHAR(50) NOT NULL,
  resource VARCHAR(50) NOT NULL,
  resource_id VARCHAR(100),
  details JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Immutability

Audit logs are **append-only**. The database enforces this:

```sql
-- Prevent updates
CREATE RULE audit_logs_no_update AS
  ON UPDATE TO audit_logs DO INSTEAD NOTHING;

-- Prevent deletes
CREATE RULE audit_logs_no_delete AS
  ON DELETE TO audit_logs DO INSTEAD NOTHING;

-- Revoke DML permissions from application user
REVOKE UPDATE, DELETE ON audit_logs FROM endpointx_app;
```

### Log Retention

| Log Type         | Retention Period | Archival        |
| ---------------- | ---------------- | --------------- |
| Audit Logs       | 7 years         | Cold storage    |
| Security Events  | 7 years         | Cold storage    |
| Application Logs | 90 days         | Log aggregation|
| Metrics Data     | 1 year          | Time-series DB |

---

## Data Encryption

### At Rest

| Data Type          | Method                     | Key Management         |
| ------------------ | -------------------------- | ---------------------- |
| Passwords          | bcrypt (12 rounds)         | N/A (hash)             |
| Refresh Tokens     | bcrypt (12 rounds)         | N/A (hash)             |
| Agent Credentials  | AES-256-GCM               | Environment variable   |
| Sensitive Fields   | AES-256-GCM               | Environment variable   |
| Database Backups   | AES-256-CBC               | Backup encryption key  |

### In Transit

| Connection         | Protocol                   | Certificate            |
| ------------------ | -------------------------- | ---------------------- |
| API → Client       | TLS 1.2+                   | Let's Encrypt / Custom |
| Agent → API        | TLS 1.2+                   | System CA / Custom     |
| API → Database     | TLS 1.2+ (optional)        | Self-signed / Custom   |
| API → Redis        | TLS 1.2+ (optional)        | Self-signed / Custom   |
| WebSocket          | WSS (TLS 1.2+)             | Same as API            |

### Key Rotation

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Key Vault   │     │  Application │     │   Database   │
│  (HSM/Cloud) │────▶│  (Runtime)   │────▶│  (Encrypted) │
└─────────────┘     └─────────────┘     └─────────────┘
       │
       │  Key Rotation Schedule
       ├── Primary Key:    Every 90 days
       ├── Backup Key:     Every 180 days
       └── Emergency Key:  On-demand
```

---

## Network Security

### Firewall Rules

```
┌─────────────────────────────────────────────────────────┐
│                    Network Zones                         │
├─────────────────┬─────────────────┬─────────────────────┤
│    Public Zone   │   DMZ Zone      │   Internal Zone     │
│                 │                 │                     │
│  ┌───────────┐  │  ┌───────────┐  │  ┌───────────────┐  │
│  │   Nginx   │  │  │  API + WS │  │  │   PostgreSQL  │  │
│  │  (443)    │──┼─▶│  (3001)   │  │  │   (5432)      │  │
│  └───────────┘  │  └───────────┘  │  └───────────────┘  │
│                 │                 │                     │
│  ┌───────────┐  │  ┌───────────┐  │  ┌───────────────┐  │
│  │   HTTPS   │  │  │   Redis   │  │  │   Monitoring  │  │
│  │   Only    │  │  │  (6379)   │  │  │   (Grafana)   │  │
│  └───────────┘  │  └───────────┘  │  └───────────────┘  │
└─────────────────┴─────────────────┴─────────────────────┘
```

### TLS Configuration

```nginx
# Nginx TLS Configuration
ssl_protocols TLSv1.2 TLSv1.3;
ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
ssl_prefer_server_ciphers off;
ssl_session_timeout 1d;
ssl_session_cache shared:SSL:10m;
ssl_session_tickets off;

# HSTS
add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload";

# OCSP Stapling
ssl_stapling on;
ssl_stapling_verify on;
```

### Security Headers

```nginx
# Content Security Policy
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' wss://api.endpointx.example.com;";

# X-Frame-Options
add_header X-Frame-Options "DENY";

# X-Content-Type-Options
add_header X-Content-Type-Options "nosniff";

# X-XSS-Protection
add_header X-XSS-Protection "1; mode=block";

# Referrer Policy
add_header Referrer-Policy "strict-origin-when-cross-origin";

# Permissions Policy
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()";
```

### Rate Limiting

```nginx
# Nginx rate limiting
limit_req_zone $binary_remote_addr zone=auth:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=api:10m rate=100r/m;
limit_req_zone $binary_remote_addr zone=register:10m rate=5r/m;

# Apply limits
location /api/auth/ {
    limit_req zone=auth burst=5 nodelay;
}

location /api/devices/register {
    limit_req zone=register burst=3 nodelay;
}

location /api/ {
    limit_req zone=api burst=20 nodelay;
}
```

---

## Agent Security

### Authentication

Agents authenticate using a three-factor mechanism:

1. **Agent Secret**: Shared secret from environment variable
2. **Device ID**: Unique identifier assigned during registration
3. **HMAC Signature**: Request signing with agent-specific key

### HMAC-SHA256 Request Signing

```python
import hmac
import hashlib
import time
import json

def sign_request(payload: dict, agent_key: str) -> str:
    """Generate HMAC-SHA256 signature for request payload."""
    timestamp = str(int(time.time()))
    message = f"{timestamp}.{json.dumps(payload, sort_keys=True)}"
    signature = hmac.new(
        agent_key.encode(),
        message.encode(),
        hashlib.sha256
    ).hexdigest()
    return f"{timestamp}.{signature}"
```

### Request Headers

```http
POST /api/devices/heartbeat
Content-Type: application/json
X-Agent-ID: agent-uuid-001
X-Device-ID: device-uuid-001
X-Timestamp: 1705312800
X-Signature: 1705312800.a1b2c3d4e5f6...
```

### Credential Storage

Agent credentials are stored encrypted on the endpoint:

```
~/.endpointx/
├── config.json          # Encrypted configuration
├── credentials.enc      # Encrypted credentials
└── logs/
    └── agent.log        # Local agent logs
```

### Agent Integrity Verification

```
1. Agent binary hash verified on startup
2. Configuration file integrity checked
3. Runtime memory integrity monitoring
4. Tamper detection alerts sent to server
```

---

## Vulnerability Management

### Dependency Scanning

```bash
# npm audit
npm audit --audit-level=high

# Python safety check
safety check --full-report

# Docker image scanning
trivy image endpointx-api:latest
```

### Security Testing Schedule

| Test Type              | Frequency  | Tool                    |
| ---------------------- | ---------- | ----------------------- |
| Dependency Scanning    | Daily      | npm audit, safety       |
| SAST (Static Analysis) | On commit  | SonarQube, ESLint       |
| DAST (Dynamic Analysis)| Weekly     | OWASP ZAP              |
| Container Scanning     | On build   | Trivy, Snyk             |
| Penetration Testing    | Quarterly  | External vendor         |

### Vulnerability Response SLA

| Severity   | Response Time | Fix Deadline |
| ---------- | ------------- | ------------ |
| Critical   | 4 hours       | 24 hours     |
| High       | 24 hours      | 7 days       |
| Medium     | 72 hours      | 30 days      |
| Low        | 1 week        | 90 days      |

---

## Incident Response

### Response Phases

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│  Detect   │──▶│  Contain  │──▶│  Eradicate │──▶│  Recover  │
└──────────┘   └──────────┘   └──────────┘   └──────────┘
                                                      │
                                                      ▼
                                               ┌──────────┐
                                               │  Lessons  │
                                               │  Learned  │
                                               └──────────┘
```

### Incident Severity Levels

| Level     | Description                          | Response Team     |
| --------- | ------------------------------------ | ----------------- |
| P1        | Active breach, data exfiltration     | Full team + exec  |
| P2        | Confirmed compromise, contained      | Security + dev    |
| P3        | Suspicious activity, investigation   | Security lead     |
| P4        | Policy violation, monitoring         | Security analyst  |

### Notification Matrix

| Severity | Internal          | External          | Customers       |
| -------- | ----------------- | ----------------- | --------------- |
| P1       | Immediately       | Within 1 hour     | Within 24 hours |
| P2       | Within 1 hour     | Within 24 hours   | As needed       |
| P3       | Within 24 hours   | N/A               | N/A             |
| P4       | Weekly report     | N/A               | N/A             |

---

## Compliance

### SOC 2 Type II Controls

| Control          | Implementation                            | Status    |
| ---------------- | ----------------------------------------- | --------- |
| Access Control   | RBAC with 20+ permissions                 | ✅ Active |
| Audit Logging    | Immutable logs, 7-year retention          | ✅ Active |
| Encryption       | TLS 1.2+ in transit, AES-256 at rest      | ✅ Active |
| Monitoring       | Real-time alerts, metrics collection      | ✅ Active |
| Change Management| Git-based workflow, code review required  | ✅ Active |
| Incident Response| Documented plan, SLA-based response       | ✅ Active |
| Risk Assessment  | Annual review, vulnerability scanning     | ✅ Active |

### GDPR Compliance

| Requirement                | Implementation                            |
| -------------------------- | ----------------------------------------- |
| Data Minimization          | Collect only necessary device data        |
| Right to Erasure           | Soft delete with data purging             |
| Data Portability           | CSV/JSON export for user data             |
| Consent Management         | User consent tracking                     |
| Data Protection Officer    | Designated contact for GDPR inquiries     |
| Breach Notification        | 72-hour notification to authorities       |

### HIPAA Considerations

| Requirement                | Implementation                            |
| -------------------------- | ----------------------------------------- |
| Audit Controls             | Comprehensive audit logging               |
| Access Control             | Role-based access with MFA                |
| Integrity Controls         | Immutability for audit and security logs  |
| Transmission Security      | TLS 1.2+ for all communications           |
| Encryption                 | AES-256 for data at rest                  |
| Emergency Access           | Break-glass procedure for admins          |

### ISO 27001 Alignment

| Domain                      | EndpointX Coverage                         |
| --------------------------- | ------------------------------------------ |
| A.5  Information Security   | Policies, risk assessment                  |
| A.6  Organization           | Roles, responsibilities                    |
| A.7  Human Resources        | Background checks, training                |
| A.8  Asset Management       | Device inventory, classification           |
| A.9  Access Control         | RBAC, authentication, MFA                  |
| A.10 Cryptography           | TLS, AES-256, bcrypt                       |
| A.11 Physical Security      | Cloud provider controls                    |
| A.12 Operations Security    | Logging, monitoring, patching              |
| A.13 Communications Security| Network segmentation, firewalls           |
| A.14 System Development     | Secure coding, testing                     |
| A.15 Supplier Relationships | Third-party dependency management          |
| A.16 Incident Management    | Response plan, SLAs                        |
| A.17 Business Continuity    | Backups, disaster recovery                 |
| A.18 Compliance             | Legal, regulatory, contractual             |

---

## Security Checklist

### Pre-Deployment

- [ ] All secrets in environment variables (not in code)
- [ ] HTTPS enabled with valid certificate
- [ ] Rate limiting configured
- [ ] Security headers configured
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (input validation, CSP)
- [ ] CSRF protection enabled
- [ ] Audit logging active
- [ ] Default passwords changed
- [ ] Unnecessary ports/services disabled
- [ ] Database access restricted to API only
- [ ] Redis password protected
- [ ] Agent secret is strong and unique

### Runtime Monitoring

- [ ] Failed login attempts monitored
- [ ] Account lockouts triggered correctly
- [ ] Rate limit violations logged
- [ ] Security events alerting active
- [ ] Audit log integrity verified
- [ ] Certificate expiry monitored
- [ ] Dependency vulnerabilities tracked

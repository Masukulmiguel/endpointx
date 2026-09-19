# EndpointX Architecture

## Overview

EndpointX is an Identity, Access, and Endpoint Management (IAM + EPM) platform designed for managing authorized devices within an enterprise network. It provides real-time device monitoring, command execution, and security event tracking through a centralized admin dashboard backed by a robust API and agent-based endpoint communication.

## System Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Admin Dashboard │────▶│   Backend API   │────▶│    PostgreSQL   │
│  (React/Vite)   │     │  (Node.js/Express) │    │     Database    │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                          ┌──────┴──────┐
                          │    Redis    │
                          │   Cache     │
                          └─────────────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
              ┌─────┴─────┐ ┌───┴───┐ ┌─────┴─────┐
              │  Device 1  │ │  Dev 2 │ │  Device N  │
              │  (Agent)   │ │ (Agent)│ │  (Agent)   │
              └───────────┘ └────────┘ └───────────┘
```

## Components

### 1. Admin Dashboard

| Property       | Value                                    |
| -------------- | ---------------------------------------- |
| **Stack**      | React 18, TypeScript, Vite, Tailwind CSS |
| **Port**       | 5173 (dev), 80 (production via nginx)    |
| **State Mgmt** | React Query + Context API                |

**Features:**

- Real-time updates via Socket.IO
- Responsive design (desktop, tablet, mobile)
- Dark mode interface
- RBAC-aware UI components
- Form validation with Zod schemas
- Toast notifications for user feedback

### 2. Backend API

| Property       | Value                                          |
| -------------- | ---------------------------------------------- |
| **Stack**      | Node.js, Express, TypeScript, Socket.IO        |
| **Port**       | 3001                                           |
| **ORM**        | Knex.js                                        |
| **Validation** | Zod                                            |

**Features:**

- JWT authentication with refresh tokens
- RBAC with granular permissions (20+ permissions)
- Rate limiting (configurable per endpoint)
- Input validation (Zod schemas)
- Audit logging (immutable records)
- Real-time WebSocket events
- Health check endpoint

### 3. Database

| Property       | Value                          |
| -------------- | ------------------------------ |
| **Primary**    | PostgreSQL 16                  |
| **Cache**      | Redis 7                        |
| **Port**       | 5432 (PG), 6379 (Redis)        |

**Features:**

- UUID primary keys for all tables
- Immutability for audit and security logs
- Automatic `created_at` / `updated_at` timestamps
- Comprehensive indexing on frequently queried columns
- Foreign key constraints for referential integrity
- Soft deletes for user management

### 4. Endpoint Agent

| Property       | Value                                  |
| -------------- | -------------------------------------- |
| **Stack**      | Python 3.9+, psutil, requests, cryptography |
| **Transport**  | HTTPS (TLS 1.2+)                       |
| **Auth**       | HMAC-SHA256 request signing             |

**Features:**

- Cross-platform (Windows, Linux, macOS)
- Encrypted credential storage
- Periodic heartbeat with system metrics
- Command queue processing
- Automatic retry with exponential backoff
- Local logging with rotation

## Data Flow

### Device Registration

```
Agent                          Server
  │                               │
  │  POST /api/devices/register   │
  │  { system_info, agent_secret }│
  │──────────────────────────────▶│
  │                               │──▶ Validate agent_secret
  │                               │──▶ Create device record
  │                               │──▶ Generate agent_id
  │  201 { device_id, agent_id }  │
  │◀──────────────────────────────│
  │                               │
  │──▶ Store credentials locally  │
```

1. Agent installs on authorized device
2. Agent collects system information (OS, hostname, IPs, hardware)
3. Agent sends `POST /api/devices/register` with system info and agent secret
4. Server validates agent secret against environment variable
5. Server creates device record with `pending` status
6. Server returns `device_id` and `agent_id`
7. Agent stores credentials in encrypted local file

### Heartbeat Cycle

```
Agent                          Server
  │                               │
  │  POST /api/devices/heartbeat  │
  │  { metrics, agent_id }        │
  │──────────────────────────────▶│
  │                               │──▶ Update device status
  │                               │──▶ Store metrics
  │                               │──▶ Check command queue
  │  200 { commands: [...] }      │
  │◀──────────────────────────────│
  │                               │
  │──▶ Execute commands           │
  │  POST /api/commands/:id/result│
  │──────────────────────────────▶│
```

1. Agent collects CPU, RAM, disk, network metrics
2. Agent sends `POST /api/devices/heartbeat`
3. Server updates device `last_seen` and status to `online`
4. Server stores metrics in `device_metrics` table
5. Server returns any pending commands for the device
6. Agent executes commands and sends results back
7. Server updates command status and stores output

### Admin Actions

```
Admin        Dashboard      API         Database      Agent
  │              │            │             │            │
  │──Click──────▶│            │             │            │
  │              │──API Call──▶│             │            │
  │              │            │──Validate──▶│            │
  │              │            │──RBAC──────▶│            │
  │              │            │──Audit Log──▶│            │
  │              │  Socket.IO │             │            │
  │              │◀───────────│             │            │
  │              │            │──Queue Cmd──▶│            │
  │              │            │             │            │
  │              │            │             │──Dispatch──▶│
```

1. Admin performs action in dashboard
2. Dashboard sends API request to backend
3. Backend validates JWT token and RBAC permissions
4. Backend creates immutable audit log entry
5. Backend emits Socket.IO event to relevant clients
6. If action requires agent interaction, command is queued
7. Agent picks up command on next heartbeat
8. Agent executes and reports result

## Database Schema

### Entity Relationship Diagram

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│    users      │     │    roles      │     │ permissions  │
├──────────────┤     ├──────────────┤     ├──────────────┤
│ id (UUID) PK │     │ id (UUID) PK │     │ id (UUID) PK │
│ username     │     │ name         │     │ name         │
│ email        │     │ description  │     │ description  │
│ password_hash│     │ is_default   │     │ category     │
│ role_id (FK) │◀───▶│ created_at   │     └──────┬───────┘
│ is_active    │     └──────────────┘            │
│ mfa_enabled  │     ┌──────────────┐            │
│ created_at   │◀────│role_permissions│◀──────────┘
│ updated_at   │     ├──────────────┤
└──────┬───────┘     │ role_id (FK) │
       │             │ permission_id│
       │             └──────────────┘
       │
       │             ┌──────────────┐
       │             │   devices     │
       │             ├──────────────┤
       │             │ id (UUID) PK │
       ├────────────▶│ device_name  │
       │             │ hostname     │
       │             │ os_type      │
       │             │ status       │
       │             │ agent_id     │
       │             │ user_id (FK) │
       │             │ last_seen    │
       │             │ created_at   │
       │             └──────┬───────┘
       │                    │
       │             ┌──────┴───────┐
       │             │ device_metrics│
       │             ├──────────────┤
       │             │ id (UUID) PK │
       │             │ device_id FK │
       │             │ cpu_usage    │
       │             │ ram_usage    │
       │             │ disk_usage   │
       │             │ recorded_at  │
       │             └──────────────┘
       │
       │             ┌──────────────┐
       │             │   commands    │
       │             ├──────────────┤
       │             │ id (UUID) PK │
       ├────────────▶│ device_id FK │
       │             │ command      │
       │             │ status       │
       │             │ output       │
       │             │ created_by   │
       │             │ created_at   │
       │             │ executed_at  │
       │             └──────────────┘
       │
       │             ┌──────────────┐
       │             │ audit_logs   │
       │             ├──────────────┤
       │             │ id (UUID) PK │
       └────────────▶│ user_id (FK) │
                     │ action       │
                     │ resource     │
                     │ details (JSON)│
                     │ ip_address   │
                     │ user_agent   │
                     │ created_at   │
                     └──────────────┘
```

### Table Summary

| Table              | Purpose                              | Records (est.) |
| ------------------ | ------------------------------------ | -------------- |
| `users`            | Admin/operator accounts              | 10–100         |
| `roles`            | RBAC role definitions                | 4–10           |
| `permissions`      | Granular permission definitions      | 20             |
| `role_permissions` | Role-permission mappings             | 40–100         |
| `devices`          | Registered endpoint devices          | 100–10,000     |
| `device_metrics`   | Time-series device performance data  | Millions       |
| `commands`         | Command execution requests           | 1,000–100,000  |
| `audit_logs`       | Immutable audit trail                | Millions       |
| `security_events`  | Security incident records            | 10,000+        |
| `alerts`           | System and security alerts           | 1,000+         |
| `settings`         | Application configuration            | 20–50          |

## Security Architecture

### Authentication Flow

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│  Client   │                    │  Server   │                    │  Redis    │
└────┬─────┘                    └────┬─────┘                    └────┬─────┘
     │                               │                               │
     │  POST /auth/login             │                               │
     │  { email, password }          │                               │
     │──────────────────────────────▶│                               │
     │                               │──▶ Validate credentials       │
     │                               │──▶ Check account lockout      │
     │                               │──▶ Generate JWT access token  │
     │                               │──▶ Generate refresh token     │
     │                               │──▶ Store refresh token hash   │
     │  200 { accessToken, refresh } │                               │
     │◀──────────────────────────────│                               │
     │                               │                               │
     │  GET /api/resource            │                               │
     │  Authorization: Bearer <jwt>  │                               │
     │──────────────────────────────▶│                               │
     │                               │──▶ Verify JWT                 │
     │                               │──▶ Check RBAC permissions     │
     │                               │──▶ Audit log                  │
     │  200 { data }                 │                               │
     │◀──────────────────────────────│                               │
     │                               │                               │
     │  POST /auth/refresh           │                               │
     │  { refreshToken }             │                               │
     │──────────────────────────────▶│──▶ Validate refresh token     │
     │                               │──▶ Rotate refresh token       │
     │  200 { accessToken, refresh } │                               │
     │◀──────────────────────────────│                               │
```

### Token Specifications

| Token          | Lifetime | Storage        | Rotation |
| -------------- | -------- | -------------- | -------- |
| Access Token   | 15 min   | Memory/State   | No       |
| Refresh Token  | 7 days   | HttpOnly Cookie| Yes      |
| Agent Token    | 30 days  | Local file     | On register |

### Authorization (RBAC)

| Role           | Permissions Count | Description                    |
| -------------- | ----------------- | ------------------------------ |
| Admin          | 20                | Full system access             |
| Supervisor     | 14                | Device + command management    |
| Technician     | 8                 | Device monitoring + commands   |
| User           | 3                 | View own devices only          |

### Communication Security

- **API Communication**: All traffic over HTTPS/TLS 1.2+
- **Agent Authentication**: Shared secret + device ID + HMAC-SHA256 signatures
- **Certificate Pinning**: Optional for high-security deployments
- **WebSocket**: WSS (WebSocket Secure) in production

### Data Security

| Layer            | Mechanism                              |
| ---------------- | -------------------------------------- |
| Passwords        | bcrypt (12 rounds)                     |
| Audit Logs       | Immutable (no UPDATE/DELETE allowed)   |
| Input Validation | Zod schemas on all endpoints           |
| SQL Injection    | Parameterized queries (Knex.js)        |
| XSS              | Content Security Policy headers        |
| CSRF             | SameSite cookie attribute              |
| Secrets          | Environment variables (never in code)  |

## Scalability Considerations

### Horizontal Scaling

```
                    ┌─────────────┐
                    │ Load Balancer│
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴─────┐ ┌───┴───┐ ┌─────┴─────┐
        │  API #1   │ │ API #2 │ │  API #N   │
        └─────┬─────┘ └───┬───┘ └─────┬─────┘
              │            │            │
              └────────────┼────────────┘
                           │
                    ┌──────┴──────┐
                    │    Redis    │
                    │  (Shared)   │
                    └──────┬──────┘
                           │
                    ┌──────┴──────┐
                    │  PostgreSQL  │
                    │  (Primary)   │
                    └──────┬──────┘
                           │
                    ┌──────┴──────┐
                    │  PostgreSQL  │
                    │  (Replica)   │
                    └─────────────┘
```

- **Stateless API**: No session state in memory; all state in Redis/DB
- **Connection Pooling**: Max 20 database connections per API instance
- **Load Balancer**: Round-robin or least-connections distribution
- **Redis Cluster**: For high-availability caching and pub/sub

### Database Optimization

| Strategy                    | Implementation                              |
| --------------------------- | ------------------------------------------- |
| Indexing                    | B-tree indexes on frequently queried columns|
| Partitioning                | Time-based partitioning for metrics         |
| Soft Deletes                | `deleted_at` column instead of DELETE       |
| Connection Pooling          | pgBouncer or Knex pool (max 20)             |
| Read Replicas               | Separate read/write connections              |

### Agent Scalability

| Parameter              | Default  | Range        |
| ---------------------- | -------- | ------------ |
| Heartbeat Interval     | 60s      | 10s – 300s   |
| Command Timeout        | 30s      | 5s – 300s    |
| Retry Max Attempts     | 3        | 1 – 10       |
| Retry Backoff          | Exponential | 1s – 60s  |
| Batch Size (Inventory) | 100      | 10 – 500     |

## Future Enhancements

### Authentication

- Microsoft Entra ID (Azure AD) integration
- Active Directory / LDAP synchronization
- Single Sign-On (SAML 2.0 / OIDC)
- OAuth2/OIDC provider federation
- Hardware security keys (FIDO2/WebAuthn)

### Monitoring & Observability

- Prometheus metrics export (`/metrics` endpoint)
- Grafana dashboard templates
- Distributed tracing (OpenTelemetry)
- Centralized log aggregation (ELK/Loki)
- Alertmanager integration

### Agent Capabilities

- Mutual TLS (mTLS) authentication
- Remote script execution (Python/PowerShell/Bash)
- Software deployment and installation
- Automated patch management
- Compliance baseline checking
- File integrity monitoring

### Compliance & Governance

- SOC 2 Type II compliance features
- GDPR data handling and right-to-erasure
- HIPAA audit trail requirements
- ISO 27001 control mapping
- Automated compliance reporting

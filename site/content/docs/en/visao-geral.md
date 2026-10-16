---
title: Platform overview
lead: Architecture, concepts and what each area of the panel does.
description: Explore the four-layer EndpointX architecture, the key concepts — devices, agents, enrollment and heartbeat — and what each area of the panel does.
---

## What is EndpointX

EndpointX is an Identity, Access and Endpoint Management (IAM + EPM) platform for managing authorized devices on a corporate network. It brings together real-time monitoring, remote command execution and security event tracking, all from a single admin panel.

The platform is defensive by design: it only works with registered and authorized devices, with network ranges configured by the administrator, and it never collects passwords, keystrokes or file contents.

## Architecture in 4 layers

The system is organized in four layers:

1. **Agents** — run on authorized endpoints (Windows, Linux and macOS), collect inventory and metrics and send periodic heartbeats to the API over HTTPS, signed with HMAC-SHA256.
2. **Express API** — Node.js backend with Express and Socket.IO, JWT authentication with refresh tokens, RBAC with granular permissions, input validation and immutable audit logging.
3. **PostgreSQL** — main database (PostgreSQL 16) with UUID keys, indexes and immutable audit logs; Redis is used as cache and for shared real-time data.
4. **React dashboard** — React admin panel with real-time updates over WebSocket, permission-aware (RBAC-aware) UI and dark mode.

> **Note:** the heartbeat interval is configurable (60 seconds by default) and the agent automatically retries failed communication.

## Key concepts

- **User and session** — administrators sign in with email and password; the session uses a short-lived access token and a revocable refresh token, with optional MFA.
- **Device and agent** — every authorized endpoint has a record in the panel and an installed agent that collects inventory (software, services, processes, partitions, interfaces) and health metrics.
- **Enrollment** — PCs join with an enrollment token and mobiles through a PWA page; every device enters as PENDING until an administrator approves it (Zero Trust).
- **Heartbeat** — the agent sends `POST /api/devices/heartbeat` with metrics (CPU, RAM, disk); the API replies with any commands pending for the device.

Example of the heartbeat cycle:

```http
POST /api/devices/heartbeat
Content-Type: application/json

{
  "agent_id": "agt_…",
  "metrics": { "cpu": 42, "ram": 61, "disk": 73 }
}
```

## Panel areas

- **Dashboard** — overview with device status, recent activity and alerts.
- **Devices** — inventory and health of every endpoint, remote commands and history.
- **Network / Discovery** — sweeps of authorized CIDR ranges, review of discovered nodes (approve, ignore or request installation) and network access decisions (NAC), under development.
- **HERMES** — defensive intelligence engine that correlates inventory, ports, services and CVEs, presenting risk with evidence, confidence and timestamp.
- **Security** — alerts, rules, incidents, MFA and audit records.
- **Settings** — installation configuration, users, roles and permissions.

## Development status

EndpointX is in free early access at version 1.3.0, under continuous development. Device enrollment, heartbeat monitoring, vulnerability analysis, security monitoring and access control with auditing are available.

Network access decisions (NetSentinel / NAC) and other capabilities marked as “in development” in the panel are under construction — we would rather say so than pretend they are ready. This documentation describes the real system, with no invented client numbers or certifications.

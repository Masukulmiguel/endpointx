---
title: Agent management
lead: Enrollment, heartbeat, tokens and updates.
description: How the EndpointX agent enrolls, its heartbeat cycle and thresholds, the token types, remote commands, and how to update or uninstall.
---

## What the agent is

The agent is the program that runs on authorized endpoints and feeds the panel with real data. On Windows, Linux and macOS it is a Python agent (built on `psutil`) that:

- **collects inventory** — software, services, processes, partitions and network interfaces;
- **reports metrics** — CPU, RAM, disk and network traffic, including the full capacity of each component;
- **keeps the heartbeat** — sends `POST /api/devices/heartbeat` and `POST /api/devices/command-poll` to the API over HTTPS, authenticating with the shared fleet secret (`X-Agent-Secret`);
- **runs commands** — picks up panel commands from the heartbeat or poll response and returns their results.

On Windows it runs in the background and starts automatically at login; on Linux it runs as a systemd service and on macOS as a launchd service. Phones do not run the Python agent: the mobile page registers the device and keeps it present via `POST /api/devices/mobile/heartbeat` (with its own token), and the Android app adds remote control.

Example of the configuration written by the installer:

```yaml
agent_id: AUTO
heartbeat_interval: 60
server_url: https://endpointx-api-5ypc.onrender.com/api
```

## Enrollment and the PENDING state

- **PCs** — the installer runs `python agent.py --register`, which calls `POST /api/devices/register` with the fleet secret and the account's enrollment token. The device is linked to the account (`created_by`) and authorized to work.
- **Phones** — `POST /api/devices/mobile/register` also requires an enrollment token and creates the device with `approval_status = 'pending'` and `is_authorized = false`: it lands in **PENDING** in the panel.
- **Approval (Zero Trust)** — `POST /api/netsentinel/devices/:id/approve` moves the device to `approved`/`is_authorized` and `trust_level = KNOWN`; `POST /api/netsentinel/devices/:id/reject` marks it `rejected`, `trust_level = BLOCKED` and `is_authorized = false`. Only the account that created the device (or an administrator) can decide.
- **No duplicates** — re-registering the same machine (same IP, same OS and matching name/model) reuses the existing row instead of creating a second record; the same applies to phones with a reinstalled APK.

## Heartbeat and thresholds

- **Interval** — configurable (`heartbeat_interval`, 60 seconds by default). Each heartbeat updates state, metrics and hardware capacity, and returns the device's pending commands.
- **Command polling** — the agent calls `POST /api/devices/command-poll` roughly every 3 seconds, so a panel command does not wait for the next heartbeat.
- **Offline** — a device that misses the heartbeat for `OFFLINE_THRESHOLD` (300 seconds, 5 minutes, by default) becomes `offline`. Phones use `MOBILE_OFFLINE_THRESHOLD` (1800 seconds, 30 minutes) because browsers freeze background timers — both values are set at deploy time.
- **Offline alerts** — threshold rules accept an `offline` deviation between 30 and 86400 seconds.
- **Contained devices** — blocked or quarantined devices keep reporting metrics, but never return to `online` and only receive containment commands (`isolate`, `unisolate`, `quarantine`).

Example of the low-latency poll:

```http
POST /api/devices/command-poll
Content-Type: application/json
X-Agent-Secret: <AGENT_SECRET>

{
  "agent_id": "agt_…"
}
```

## Tokens (enrollment vs session)

| Type | What it is for | Lifetime | How you get it |
|------|----------------|----------|----------------|
| Enrollment (`typ: enroll`) | Linking devices to the account in scripts and mobile links | 30 days | `GET /api/devices/enroll-token` (requires `devices.manage`), carried in `?t=` |
| Installation (`typ: install`) | Installation requests originated by Network Discovery | 7 days, bound to the request (jti) | Returned with the request (`buildInstallCommands`); only releases scripts while the request is authorized |
| Administrator session | Authenticating the panel and the API | Short-lived access + 7-day refresh bound to `sid` | Login (`POST /api/auth/login`); revoked on logout |
| Agent secret | `register`, `heartbeat`, `command-poll` | While configured at deploy time | `X-Agent-Secret`, generated on the server |

Agents **never** use administrator session tokens — only the fleet secret and, when applicable, the enrollment/installation token embedded in their configuration.

Enrollment token response:

```json
{
  "success": true,
  "data": { "token": "eyJhbGciOi…", "expires_in": "30d" }
}
```

## Remote commands

Accepted commands (`POST /api/commands`, requires `devices.commands`):

`reboot`, `shutdown`, `lock`, `unlock`, `inventory`, `update_agent`, `scan`, `get_info`, `uninstall_agent`, `isolate`, `unisolate`, `quarantine`, `network_discovery`.

```http
POST /api/commands
Authorization: Bearer <ACCESS_TOKEN>
Content-Type: application/json

{
  "device_id": "…",
  "command_type": "reboot"
}
```

- **Delivery** — `pending` commands are claimed by the heartbeat (up to 10 at a time, 5 while contained) or by the poll; `processing` without confirmation for 5 minutes becomes `failed`.
- **Cancellation** — `POST /api/commands/:id/cancel` cancels commands still in `pending`.
- **Auditing** — every command is written to `audit_logs` with the `command_execute` action and the IP of whoever issued it.
- **Restriction** — `uninstall_agent` can only be issued by administrators, and its payload carries an HMAC-SHA256 signature the agent validates before running.

## Update or uninstall

**Update (Windows):**

```powershell
irm https://endpointx-api-5ypc.onrender.com/api/devices/public/update.ps1 | iex
```

**Update (panel):** the `update_agent` command, created with `POST /api/devices/:id/update-agent`, updates the agent files on the selected device.

**Uninstall:** send the `uninstall_agent` command from the panel (admin role, with the HMAC signature described above). Locally, the agent folder also ships a `desinstalar.bat` script for manual removal. After uninstalling, reinstall with the commands from the [Installation](/en/docs/instalacao) page.

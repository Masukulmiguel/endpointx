---
title: Installation and requirements
lead: Prerequisites, first steps and agent installation.
description: Requirements, account setup, enrollment token and the exact commands to install the EndpointX agent on Windows, Linux, macOS and mobile devices.
---

## Requirements

To install the agent on an authorized endpoint you need:

- **An EndpointX account** — the free early access of version 1.3.0 boots with an administrator account created on first start (built from `SEED_ADMIN_PASSWORD`, 12 characters minimum) and allows anyone to sign up.
- **Python on the endpoint** — on Windows, Python installed with "Add Python to PATH" checked; on Linux and macOS, Python 3.8+. The installation guide recommends Python 3.10+ on remote PCs.
- **Network** — the endpoint must reach the API over HTTPS. In self-hosted setups the firewall must not block the backend port (3001 by default).
- **Manage permission** — installation commands and enrollment tokens are issued by accounts with the `devices.manage` permission (admin roles).

The scripts configure the agent to point at the API automatically — you never have to edit `config.yaml` by hand.

## Create an account and get the token

Create an account (free early access sign-up), sign in to the panel and open the **Install Agent** page. The panel fetches the account's enrollment token with `GET /api/devices/enroll-token` and shows the command already complete, token included.

You can also mint the token yourself from an admin session:

```bash
curl -H "Authorization: Bearer <ADMIN_JWT>" https://endpointx.onrender.com/api/devices/enroll-token
```

The token lasts 30 days (`expires_in: "30d"`), belongs to the account that issued it and is a credential — never commit it or share it outside the panel. Without a valid token the installation scripts refuse to run (HTTP 403 «Valid enrolment token required»).

## Windows (PowerShell)

On the remote PC, open PowerShell and paste (do not close the shell):

```powershell
irm https://endpointx-api-5ypc.onrender.com/api/devices/public/install.ps1?t=<ENROLL_TOKEN> | iex
```

This is exactly the command the **Install Agent** page shows, with your account's `?t=` already in it. The script:

1. checks that Python is on the PATH (it fails with instructions if not);
2. creates `C:\endpointx\endpoint-agent` and downloads the agent files;
3. writes `config.yaml` with the server, the fleet secret and your token;
4. installs the dependencies (`psutil`, `requests`, `pyyaml`) and registers the device (`python agent.py --register`);
5. creates a background launcher and copies it to the Startup folder so the agent starts on every login.

## Linux and macOS

In the device's terminal (automatic configuration and registration):

```bash
# Linux (Debian/Ubuntu/Fedora — requires sudo)
curl -fsSL https://endpointx-api-5ypc.onrender.com/api/devices/public/install-linux.sh?t=<ENROLL_TOKEN> | sudo bash

# macOS (regular user)
curl -fsSL https://endpointx-api-5ypc.onrender.com/api/devices/public/install-macos.sh?t=<ENROLL_TOKEN> | bash
```

The agent runs as a service — systemd on Linux, launchd on macOS — and starts automatically. To follow it:

```bash
# Linux
systemctl status endpointx-agent
journalctl -u endpointx-agent -f

# macOS
tail -f ~/endpointx-agent/agent-stdout.log
```

## Mobile (Android/iOS)

On the phone, open the registration link (mobile page, with the account's token):

```
https://endpointx-api-5ypc.onrender.com/api/devices/public/mobile?t=<ENROLL_TOKEN>
```

The page is also available as a QR code on the **Install Agent** page, through `GET /api/devices/public/mobile`, and registration goes through `POST /api/devices/mobile/register`. For MDM: Android Enterprise, Apple Business Manager, Intune and Jamf.

To **see and control the phone's screen** from the panel (assisted remote support), install the Android app (Android 8.0+, v1.3.0, signed, ~1 MB, with accessibility and screen-sharing permissions):

```
https://endpointx-api-5ypc.onrender.com/api/devices/public/endpointx-agent.apk
```

With the phone connected over USB and USB debugging enabled, the assisted setup enables control without touching Android settings:

```bash
adb shell pm grant pt.endpointx.agent android.permission.WRITE_SECURE_SETTINGS
adb shell settings put secure enabled_accessibility_services pt.endpointx.agent/.ControlService
adb shell settings put secure accessibility_enabled 1
```

There is also `https://endpointx-api-5ypc.onrender.com/api/devices/public/enable-control.bat`, which installs the APK and turns on the accessibility service. Note (Android 13+): remote control is blocked for sideloaded apps until you enable «Allow restricted settings» in Settings → Apps → EndpointX.

## Verify the device came online

1. Wait up to one heartbeat cycle (60 seconds by default) — the agent registers and starts reporting right away.
2. In the panel, open **Devices**: the endpoint should show as `online`, with metrics and inventory.
3. Phones arrive as `PENDING` (Zero Trust) until an administrator approves them under **Devices**; once approved they become `approved`/`is_authorized`.
4. If in doubt, check the local `endpointx-agent.log` file in the agent folder and list devices with `GET /api/devices` (requires `devices.view`).

## Updates

Quick update for an already-installed agent, on Windows:

```powershell
irm https://endpointx-api-5ypc.onrender.com/api/devices/public/update.ps1 | iex
```

The script stops the agent, downloads the updated files and restarts it in the background. You can also push updates from the panel: the `update_agent` command (created with `POST /api/devices/:id/update-agent`, requires `devices.commands`) is delivered to the agent on its next heartbeat. On Linux and macOS, running the install script from the previous section again restores the latest files.

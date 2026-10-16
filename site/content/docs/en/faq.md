---
title: Frequently asked questions
lead: Short answers to the most common questions.
description: Pricing, requirements, supported systems, mobile devices, offline behaviour, data collected, HERMES, backups, languages and support for EndpointX.
---

### Is EndpointX paid?

No. Version 1.3.0 is in free early access — sign up and start using it with no credit card.

> **Note:** it is a product under active development; features marked as "in development" (NAC, software deployment, CVE feed) are not ready yet, and we would rather say so than pretend otherwise.

### What are the minimum requirements?

An account, a network that can reach the API over HTTPS, and Python on the endpoint: 3.8+ on Linux and macOS (3.10+ recommended on PCs). On Windows, install Python with "Add Python to PATH" checked — the scripts take care of the rest.

### Which operating systems are supported?

Windows (installation via PowerShell), Linux (Debian/Ubuntu/Fedora) and macOS (systemd/launchd) run the Python agent; Android 8.0+ gets an APK and a mobile page; iOS uses the mobile page (PWA) for registration and metrics. The full guide is in [Installation](/en/docs/instalacao).

### What about mobile devices?

By opening `https://endpointx-api-5ypc.onrender.com/api/devices/public/mobile?t=<ENROLL_TOKEN>` (or the QR code on the **Install Agent** page). The phone arrives as **PENDING** until approved in the panel (Zero Trust), and the Android app adds remote screen viewing and control — on iOS you get registration, presence and metrics.

### What happens when a device goes offline?

The agent does not uninstall itself or lose data: it keeps running locally and reconnects on its own (retries with exponential backoff). In the panel the device becomes `offline` after 300 seconds without a heartbeat (1800 seconds for phones) and returns to `online` on the next heartbeat; commands pending for more than 5 minutes become `failed`.

### What data does the agent collect?

Inventory (hardware, software, services, processes, partitions, interfaces), CPU, memory, disk and network metrics, and connection state. It **never** collects passwords, keystrokes or file contents — see [Security](/en/docs/seguranca).

### Is HERMES an offensive tool?

No. It is defensive security: it analyses vulnerabilities and risk on authorized devices and the configured private ranges (by default `192.168.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12` — everything else is ignored). The module is under development in this version.

### How do I stop a HERMES scan?

A single scan: `POST /api/hermes/scans/:id/stop` (it becomes `stopped`). Emergency, all at once: `POST /api/hermes/emergency-stop` — it switches on the emergency stop (`hermes_emergency_stop`) and stops every active scan; both require the `hermes.manage` permission and are recorded in the audit trail.

### How many administrator accounts can I have?

As many as you need. The first administrator is created at boot (`SEED_ADMIN_PASSWORD`) and free sign-ups receive the `user` role (read-only). Invite as many as you like with `POST /api/auth/invite` and choose each person's role (admin, supervisor, technician or user).

### How do I back up the database?

With `pg_dump` (custom-format dump):

```bash
pg_dump -U endpointx -d endpointx -F c -f backup_$(date +%Y%m%d).dump
pg_restore -U endpointx -d endpointx backup_20250115.dump
```

Store the dumps on another machine and test a restore now and then — a backup you have never restored is not a backup.

### Which languages is the documentation in?

Portuguese and English, with the same structure and content in both. The selector at the top of the site switches the whole page's language.

### How do I contact support?

Through the form at [/contacto](/contacto) — describe the problem, the device involved and what you have already tried; we reply by email.

### Where do I find the full documentation?

Right here, inside the site: [/en/docs/visao-geral](/en/docs/visao-geral) in English and [/docs/visao-geral](/docs/visao-geral) in Portuguese. The docs live in the site itself — no jumps to external repositories.

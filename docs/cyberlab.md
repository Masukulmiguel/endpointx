# Cyber Lab

## Overview

Cyber Lab is the EndpointX subsystem for submitting uploaded artifacts to an
external analysis engine and reviewing the results as structured jobs and
findings. The API never implements analysis logic itself: it spawns an
operator-supplied engine binary, captures its JSON output, normalizes it into
findings, and enforces hard limits, permissions, and an honest state model.

This document covers installation, configuration, and day-to-day operation of
Cyber Lab from an operator's perspective.

## Table of Contents

- [Architecture at a Glance](#architecture-at-a-glance)
- [Environment Variables](#environment-variables)
- [Settings Layer](#settings-layer)
- [Provider States](#provider-states)
- [Supported Operations](#supported-operations)
- [Job Lifecycle](#job-lifecycle)
- [Limits](#limits)
- [Permissions](#permissions)
- [API Surface](#api-surface)
- [Troubleshooting](#troubleshooting)

---

## Architecture at a Glance

```
upload artifact → POST /api/cyberlab/jobs → queued / running → engine binary
                                                              → JSON stdout
                                                              → normalized findings
```

- **Artifacts** are uploaded as base64 JSON, stored on disk outside any public
  directory, and referenced by SHA-256 and a server-generated filename.
- **Jobs** run one at a time by default (FIFO queue), each with a hard timeout.
- **Findings** are produced only from parsable engine output; unparsable or
  truncated output downgrades the job to `partial` — findings are never invented.
- Everything sensitive is written to the audit log (`cyberlab.*` actions).

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SEEFAST_CLI` | *(unset)* | Absolute path to the external engine binary. When unset, Cyber Lab reports **Not Configured** and never spawns a process. |
| `SEEFAST_ENGINE_PKG` | *(unset)* | Package the boot hook provisions the engine from — an HTTP(S) URL or a path already on the host. Operator-supplied; the value lives in the deployment dashboard, never in the repository. Unset → nothing is installed. |
| `SEEFAST_ENGINE_PKG_SHA256` | *(unset)* | Expected SHA-256 of the package, in hex. A mismatch installs nothing. |
| `CYBERLAB_MAX_ARTIFACT_MB` | `25` | Maximum artifact size in megabytes (decoded bytes). |
| `CYBERLAB_JOB_TIMEOUT_S` | `120` | Hard per-job timeout in seconds; the child process is killed and the job fails with a timeout error. |
| `CYBERLAB_MAX_CONCURRENT` | `1` | Maximum jobs running simultaneously; extra jobs queue FIFO. |
| `CYBERLAB_MAX_STDOUT_MB` | `5` | Maximum captured stdout/stderr; output beyond this is truncated and the job is downgraded to `partial`. |

Notes:

- `SEEFAST_CLI` must point to an executable the API user can run. The probe and
  all jobs execute it directly. A path that holds nothing runnable is reported
  as **Not Configured** — nothing ran, so nothing failed — and the probe does
  not even spawn.
- **Provisioning on a fresh host.** The container image ships a generic boot
  hook (`backend-api/docker/install-engine.cjs`) that runs before the API
  starts. When `SEEFAST_ENGINE_PKG` and `SEEFAST_CLI` are both set, it fetches
  the package and places it at `SEEFAST_CLI`; with either unset it does
  nothing at all, and the service boots exactly as it did before. The hook:
  - never executes the package — the API runs it later, under its own
    operation allowlist;
  - writes atomically (exclusive temporary file + `rename`), so an
    interrupted boot cannot leave a partial binary at the target path;
  - leaves an existing usable engine alone (idempotent), and replaces one
    that is empty or not executable;
  - installs nothing when the bytes do not match
    `SEEFAST_ENGINE_PKG_SHA256`, and says so in the log when no checksum is
    configured;
  - refuses a remote package served over plain HTTP unless the bytes are
    pinned by a checksum (a package served by the host itself is exempt);
  - never blocks the boot — a provisioning failure is logged (without the
    package specification, which may embed a signed token) and the API comes
    up with the subsystem reporting **Not Configured**.
  - `SEEFAST_CLI` must be an absolute path, and it must not live under a
    directory the API serves publicly.
- The API's body parser for `/api/cyberlab` accepts requests up to **40 MB**.
  The settings layer (`PUT /config`) therefore caps the artifact limit at
  **28 MB** — base64 grows about 4/3 on the wire, so a larger decoded artifact
  would be rejected by the parser before Cyber Lab's own check could answer
  with its honest 413. The environment variable has no such cap: if you raise
  `CYBERLAB_MAX_ARTIFACT_MB` above roughly 30, raise the body parser limit in
  `src/index.ts` as well, or large uploads will be rejected before Cyber Lab's
  own check runs.
- `CYBERLAB_STORAGE_DIR` optionally overrides the artifact storage root
  (default: `backend-api/storage/cyberlab`). It must never live under a public
  directory.

## Settings Layer

Limits can also be tuned from the dashboard (Admin → Cyber Lab → Config) via
these settings keys:

| Settings key | Bounds (PUT /config) | Applies to |
| --- | --- | --- |
| `cyberlab_max_artifact_mb` | 1–28 | Artifact size limit (MB) |
| `cyberlab_job_timeout_s` | 5–600 | Job timeout (seconds) |
| `cyberlab_max_concurrent` | 1–4 | Concurrent running jobs |

**Precedence (12-factor):** environment `CYBERLAB_*` > settings `cyberlab_*` >
defaults. Effective limits are cached in memory for 60 seconds; a successful
`PUT /api/cyberlab/config` invalidates the cache immediately, so the next
`GET /config` reflects the change. `GET /config` returns the effective values
plus which layer overrides each one.

> The stdout cap (`CYBERLAB_MAX_STDOUT_MB`) is environment-only — it has no
> settings key.

## Provider States

Cyber Lab reports four honest states. It never pretends an engine is available:

| State | Meaning |
| --- | --- |
| **Available** | `SEEFAST_CLI` is set and the capability probe succeeded (`<binary> capabilities --json`, 15 s timeout). Version is taken from the probe's JSON output; if absent, it stays `null` — never guessed. |
| **Experimental** | The feature area exists but its behavior may change; the UI marks such pages with an Experimental badge. |
| **Not Configured** | `SEEFAST_CLI` is unset, or the probe failed (`probe_failed`). The precise reason and a sanitized detail (path redacted to `SEEFAST_CLI`, capped at 200 chars) are exposed via `GET /providers`. Jobs cannot be created in this state: `POST /jobs` returns **400 `PROVIDER_NOT_CONFIGURED`** with no job row written. |
| **Coming Soon** | The section is reserved and intentionally not yet functional. |

The probe never spawns a process when `SEEFAST_CLI` is unset, so a fresh
install is safe to boot without the engine.

## Supported Operations

Three job types are supported. Each maps to a fixed argument vector on the
engine binary (allowlisted — unknown types are rejected with 400):

| Type | What it does |
| --- | --- |
| `js_analysis` | Static analysis of a JavaScript application bundle (`analyze-javascript-application <path> --json`). |
| `go_binary` | Inspection of a compiled Go binary (`inspect-go-binary <path> --json`). |
| `rust_binary` | Inspection of a compiled Rust binary (`inspect-rust-binary <path> --json`). |

In all three cases the engine receives the stored artifact path and must
respond with JSON on stdout. The runner captures stdout/stderr (tail-capped),
maps exit codes and signals to run outcomes, and treats a timeout as failure.

## Job Lifecycle

```
queued → running → completed | failed | cancelled | partial
```

| Status | Meaning |
| --- | --- |
| `queued` | Accepted, waiting for a free execution slot (FIFO — oldest queued job is promoted first). |
| `running` | The engine child process is active; the exact `ChildProcess` is tracked for cancellation. |
| `completed` | Exit code 0 and output normalized into findings (or an honest empty summary). |
| `failed` | Non-zero exit, an unexpected signal (OOM kill, segfault, external kill — never a cancellation), spawn failure (including provider became unavailable), or timeout. The error is sanitized and capped before display. |
| `cancelled` | Only on operator request: `queued` → cancelled directly; `running` → `cancel_requested` + SIGTERM to the exact child. The flag is set *before* the signal and wins in finalize, so a genuine cancel is never misread as a failure. Cancelling a finished job returns 409; an unknown id returns 404. Finishing (completion/failure) and promoting the next queued job happen atomically under one lock, so a freed slot is never stolen by a newer job. |
| `partial` | Output exceeded the stdout cap or could not be normalized — the job is marked `partial` and any findings are honestly derived (zero findings rather than fabricated ones). |

A job is never created when the provider is unavailable, and cancelled/failed
jobs never pass through normalization.

## Limits

| Limit | Default | Enforcement point |
| --- | --- | --- |
| Artifact size (base64, decoded) | 25 MB | Rejected with **413** before any file or DB row is written; oversize is judged on the encoded payload length. |
| Job timeout | 120 s | Child killed; job finalized as `failed` with a timeout error. |
| Concurrency | 1 (FIFO) | Start-vs-queue and promote-vs-start are serialised; simultaneous submissions yield one `running` and one `queued`. Raising it via `PUT /config` drains the queue immediately. |
| Stdout/stderr capture | 5 MB | Overflow truncates the run; the job is downgraded to `partial`. |
| Body parser gate | 40 MB | Applied at the `/api/cyberlab` mount (route-level `express.json`). |

The configurable artifact bound is capped at **28 MB**: base64 grows about 4/3 on
the wire, so anything larger would be rejected by the 40 MB parser before the
route could answer with the honest 413.

### Restart recovery

A process that dies mid-run leaves its job row at `running` with no child left
to finalize it — and since slots are only freed by finalize, a single orphan
would wedge the whole queue at concurrency 1. At boot the runner fails every
orphaned `running` row with `interrupted by server restart`, audits each one
as `cyberlab.job_interrupted`, and then drains the queue (unconditionally: a
crash can also leave `queued` jobs with no orphan, and skipping the drain
there would let a later POST jump the FIFO queue). Nothing is resumed: the
engine run died with the process, so resuming would mean reporting a result
that was never observed.

Job creation waits for the recovery to finish. The HTTP port is bound before
the database is ready, so without that wait a job posted in that window would
be seen by the recovery as an orphan and failed by our own restart handling.

The runner is single-process by design (in-process slot lock, in-process
ChildProcess map). Running two API instances against the same database would
make the second one fail the first's legitimately running jobs.

Effective values come from the precedence rules in [Settings Layer](#settings-layer).

## Permissions

Four permissions (category `cyberlab`) gate the subsystem:

| Permission | Grants |
| --- | --- |
| `cyberlab.view` | Read providers, jobs, findings, artifacts, audit, config, and the AI plan endpoint. |
| `cyberlab.manage` | Upload artifacts, start and cancel jobs, acknowledge findings, update config. |
| `cyberlab.approve` | Reserved for step approval (not yet enforced by any route). |
| `cyberlab.export` | Export a job's findings as JSON or CSV. |

The **admin** role receives them automatically: the boot grants the whole
permission catalog to the role named `admin`, so a fresh deploy already has
them. The other seeded roles (`supervisor`, `technician`, `user`) never receive
them — grant them explicitly in the role editor (Admin → Access & security →
Roles → edit the role → tick the Cyber Lab permissions). A role that does not
hold `cyberlab.view` does not see the Cyber Lab section in the panel at all:
the rail only renders the sections the account is allowed to reach.

All `/api/cyberlab` routes require authentication; unauthenticated requests
receive **401**, and missing permissions receive **403**.

## API Surface

| Method & path | Permission | Notes |
| --- | --- | --- |
| `GET /api/cyberlab/providers` | `cyberlab.view` | Capability probe result (state, reason, version, detail). |
| `POST /api/cyberlab/artifacts` | `cyberlab.manage` | Base64 upload; stores file + SHA-256 + audit row. |
| `GET /api/cyberlab/artifacts` | `cyberlab.view` | Paged list (never exposes storage paths). |
| `POST /api/cyberlab/jobs` | `cyberlab.manage` | Body: type + artifact id. 400 on unsupported type or unavailable provider. |
| `GET /api/cyberlab/jobs` / `GET /api/cyberlab/jobs/:id` | `cyberlab.view` | Filter by `status`, paged. |
| `POST /api/cyberlab/jobs/:id/cancel` | `cyberlab.manage` | See job lifecycle. |
| `GET /api/cyberlab/findings` | `cyberlab.view` | Filter by `job_id`, kind, severity and status, paged. |
| `POST /api/cyberlab/findings/:id/acknowledge` | `cyberlab.manage` | `open` → `acknowledged`, audited. |
| `GET /api/cyberlab/jobs/:id/export?format=json\|csv` | `cyberlab.export` | JSON job + findings, or CSV in reports style. CSV cells go through the shared `src/utils/csv.ts` formatter, which neutralises formula injection (`=`, `+`, `-`, `@`, TAB, CR) — findings carry third-party content. |
| `GET /api/cyberlab/audit` | `cyberlab.view` | Only `cyberlab.*` audit actions, paged. |
| `GET` / `PUT /api/cyberlab/config` | `cyberlab.view` / `cyberlab.manage` | Effective limits + overrides; PUT within bounds, audited. |
| `POST /api/cyberlab/ai/plan` | `cyberlab.view` | Propose-only planning assistant; never creates jobs. Falls back to `not_configured` when the AI provider is unavailable. |

## Troubleshooting

**The Cyber Lab section is not in the sidebar** → the rail only renders the
sections the account may reach, so a missing section means the account's role
does not hold `cyberlab.view`. Check the role (Admin → Access & security →
Users → the account → its role), and grant the Cyber Lab permissions in the
role editor. The section itself lives under a collapsible **Cyber Lab** group
in the rail: open it to reach the 14 sections. A section that is present but
empty usually means the engine is not configured yet — see *Not Configured*
below.

**State is "Not Configured" / `POST /jobs` returns 400 `PROVIDER_NOT_CONFIGURED`**
→ Set `SEEFAST_CLI` to the absolute path of the engine binary and restart the
API. Confirm with `GET /api/cyberlab/providers`.

**`reason: probe_failed`** → `SEEFAST_CLI` is set but the binary did not answer
`capabilities --json` within 15 s. Check that:

1. The path is an absolute path to an executable file (not a directory).
2. The API user has permission to execute it.
3. Running `<SEEFAST_CLI> capabilities --json` manually exits 0 and prints JSON
   with a `version` field.

The `detail` field carries a sanitized, length-capped excerpt of the failure.

**Uploads fail with 413** → The artifact exceeds the effective
`cyberlab_max_artifact_mb` (check `GET /config` to see which layer — env,
settings, or default — is winning).

**Jobs stuck in `queued`** → A slot is busy (`cyberlab_max_concurrent`, default
1) or a job is running. The queue promotes FIFO as slots free.

**Job finished as `partial`** → Engine output exceeded the stdout cap or was
not parsable JSON. Raise `CYBERLAB_MAX_STDOUT_MB` (env-only) if legitimate
output is being truncated, or inspect the raw result on the job detail page.

**Job failed immediately with a spawn/timeout error** → Verify the binary still
exists at `SEEFAST_CLI`, runs on the API host, and completes within
`CYBERLAB_JOB_TIMEOUT_S`.

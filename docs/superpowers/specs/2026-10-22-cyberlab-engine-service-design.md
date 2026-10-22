# Cyber Lab engine service — design

**Date:** 2026-10-22
**Status:** draft for review (rev 2 — after the builder check)
**Supersedes:** `2026-10-17-cyberlab-seefast-design.md` (the engine section only)

---

## 1. Intent and the why

The Cyber Lab has a complete, honest HTTP/DB layer and a dashboard with 14
sections. It analyses nothing, because the analysis engine is not there and
could not be there in the place it was designed to live.

The engine is **REA** (`rea-agents` on npm, MIT, the `morluto/rea` project
forked at `Masukulmiguel/rea`). The backend already speaks REA's language: it
invokes `analyze-javascript-application`, `inspect-go-binary` and
`inspect-rust-binary` with `--json`. What it lacks is the engine itself, and
three things around it.

**Measured facts, not estimates.** Every number below was measured on this
machine against `rea-agents@6.7.0` or against the deployed service.

| Fact | Value | How it was measured |
| --- | --- | --- |
| REA's Node requirement | `^22.19.0 \|\| ^24.11.0 \|\| >=26.0.0` | `registry.npmjs.org/rea-agents/latest` → `engines` |
| The API image's Node | `20` | `backend-api/Dockerfile:1` (`FROM node:20`) |
| Peak RSS of one JS analysis | **302 MB** for a 5-file app | `Start-Process` + `WorkingSet64` sampling, local run |
| `rea capabilities --json` latency | 4.0 s | stopwatch, local run |
| `rea --version` latency | 3.2 s | stopwatch, local run |
| REA's CLI surface | **155 commands** in `--help`; `catalog.counts.cli_commands` = 153 | `rea --help`, `doctor --json` → `identity.catalog.counts` |
| Render free plan | 0.1 CPU / 512 MB | render.com/docs/web-services |
| The API's own plan | free, 512 MB, shared with the DB pool | `render.yaml:5` |
| `rea-agents` installed size | 129 MB (`node_modules`), 27 MB (package) | `npm install rea-agents` |
| The API's region | `oregon` | Render API → `GET /v1/services/{id}` → `serviceDetails.region` |

**The conclusion is arithmetic, not preference.** A single analysis needs
~302 MB. The API's container has 512 MB in total, shared with the API process
and its PostgreSQL pool. The engine cannot run beside the API on the free
plan, and it cannot run at all on Node 20. Separating them is not an
architectural preference — it is the only arrangement in which the engine
runs.

**A second, independent finding.** The backend's normaliser reads five field
names that do not exist in REA's output. `normalize.ts:37-45` looks up
`module_count`, `ipc_count`, `native_addon_count`, `compiler_version` and
`package_count` at the top level of the parsed JSON. REA's real output puts
everything under `normalized_result.summary` and
`normalized_result.statistics`, and uses `build_info.go_version` for Go.
Every job would have completed with "no extractable fields" and zero
findings, while reporting success. The contract has to be written against
REA's real output, not against a guess.

---

## 2. The decision (the operator's)

Two decisions were taken by the operator and are not reopened here:

1. **The engine runs in its own Render service**, not inside the API process.
2. **All 24 target kinds REA supports are exposed**, each declaring the
   dependencies it needs, so the panel can say exactly what is operational,
   what is partially operational and what is not implemented — and why.

---

## 3. Goals, non-goals, anti-goals

### Goals

- **G1** A real analysis runs, end to end, and produces real findings.
- **G2** The operation catalogue is real: every entry says whether it is
  available *here*, and names the exact missing requirement.
- **G3** Findings are extracted from REA's real output contract, captured as
  fixtures and asserted by tests.
- **G4** Progress is real — REA emits it — and is visible in the panel.
- **G5** Cancellation reaches the engine process.
- **G6** The engine gets its own memory and its own failure domain.
- **G7** The API remains the only component that talks to an operator: RBAC,
  audit trail and evidence custody stay where they are.

### Non-goals

- Not modifying, patching or vendoring REA. It is called as a CLI.
- Not executing uploaded samples. REA's static inspection reads bytes; the
  registry refuses the operations that run a target (§6.3).
- Not adding offensive scanning against third parties. That is the operator's
  Fase 4 and needs its own authorisation model.
- Not replacing the Cyber Lab dashboard. The 14 sections stay; the six stub
  sections are wired to real data in Fase C.
- Not building a new UI framework, a new queue, or a new auth model.
- Not adding a browser-test harness to the repository. The dashboard has no
  test runner and adding one would breach the zero-new-dependencies rule
  (§4, C1). The panel verification for this phase uses the same out-of-repo
  Playwright scripts Fase A used.

### Anti-goals (a result that would count as failure)

- A green dashboard showing "Not Configured" that the operator has to read as
  a configuration problem.
- A catalogue of 24 entries that all say "unavailable" for different reasons
  and no path to making them available.
- Findings that come from a schema the operator did not ask for.
- Two code paths (local spawn and remote engine) that must both stay honest.
- The engine executing an uploaded file, ever, in any configuration.
- A severity, a confidence or a metric that the engine did not establish.

---

## 4. Constraints

- **C1** Zero new npm dependencies in `backend-api` and `admin-dashboard`
  (standing project rule). The engine service is a *new* service and may
  depend on `rea-agents`; the API and dashboard may not gain anything.
- **C2** REA requires Node `>=22.19`; the API image is Node 20. The engine
  image is therefore `FROM node:22`. The API image stays where it is unless
  another reason moves it.
- **C3** The engine needs a compute plan with more than 512 MB. Render's
  `1c-2g` is 1 CPU / 2 GB at $25/month, and is available for a private
  service. The API can stay on `free` because it no longer carries the engine.
- **C4** The artifact leaves the API's disk to reach the engine. The API's
  disk is ephemeral (Render free, no persistent disk) and the engine's would
  be too.
- **C5** The API's largest accepted body is 40 MB on `/api/cyberlab*`
  (`backend-api/src/index.ts:89`), of which the artifact is base64 (4/3
  growth), so the decoded artifact ceiling is 25 MB by default and 28 MB by
  settings. The engine service must accept the same order of payload.
- **C6** Machine-to-machine auth in this codebase is a shared secret compared
  with `safeCompare` (`backend-api/src/utils/helpers.ts:56-61`) and a
  dedicated header. The engine service follows that pattern exactly; no new
  auth scheme is invented.
- **C7** The deployment is one API instance against one database
  (`jobsRunner.ts:411-415`). The queue stays single-writer; the engine
  service holds no state about the API's database.
- **C8** The engine service is a **private** service (`type: pserv` in the
  blueprint). Render supports private services on the Hobby plan, and
  services in the same region reach each other over Render's private
  network. The engine therefore has no public URL. A free web service can
  send private-network requests, so the API can talk to it.
- **C9** The repository's `.dockerignore` excludes `**/node_modules`, `docs`
  and `*.md`. The engine image must therefore `npm ci` from a **committed**
  `engine-service/package-lock.json`, and the build context is the repo root
  (Render's `dockerfilePath` is repo-root-relative).
- **C10** The repository has no test runner. `backend-api/tests/*.test.ts`
  are standalone `tsx` scripts using `assert` plus a hand-rolled
  `checkAsync`, chained with `&&` in `package.json`'s `test` script. The
  engine service follows that convention; `node:test` is not used anywhere in
  this repository and must not be introduced.
- **C11** `backend-api/src/utils/helpers.ts` imports `bcryptjs` and
  `jsonwebtoken` (lines 1-2). The engine service cannot import from it
  without dragging those into the engine image, so `safeCompare` and
  `redactSensitiveText` are **copied** into the engine service with a
  comment pointing at the original. The duplication is deliberate and small.

---

## 5. Architecture

```
                    ┌──────────────────────────────────────────┐
  operator ────────▶│ endpointx-dashboard (static site)        │
                    └───────────────────┬──────────────────────┘
                                        │ HTTPS (public, CORS allowlist)
                    ┌───────────────────▼──────────────────────┐
                    │ endpointx-api          [free, 512 MB]    │
                    │  • auth, RBAC, audit                      │
                    │  • artifact custody (its own disk)        │
                    │  • job queue (PostgreSQL) + cancel        │
                    │  • findings, export, panel data           │
                    └───────────────────┬──────────────────────┘
                                        │ Render private network
                                        │ http://endpointx-engine:10000
                                        │ X-Engine-Secret (safeCompare)
                    ┌───────────────────▼──────────────────────┐
                    │ endpointx-engine      [1c-2g, 2 GB]      │
                    │  • owns the REA binary (npm rea-agents)  │
                    │  • operation registry (24 target kinds)   │
                    │  • readiness report (rea doctor --json)  │
                    │  • spawns REA, parses rea_progress        │
                    │  • static inspection only                 │
                    └──────────────────────────────────────────┘
```

The split is by **custody** and by **memory**:

- The API keeps the artifact (it is the evidence) and decides *whether* an
  analysis may run (RBAC, `cyberlab.manage`).
- The engine holds the analysis (it is the expensive part) and reports what
  it found and what it could not do.

Neither half knows the other's business beyond the protocol in §6.

---

## 6. The engine service

New directory `engine-service/` at the repository root, its own
`Dockerfile`, its own `package.json` and `package-lock.json`, its own test
suite in the repository's standalone-assert style (C10).

### 6.1 Protocol

All routes require the shared secret: header `X-Engine-Secret`, compared with
`safeCompare` (C6, C11). A missing or wrong secret is `401` with no detail
about what was expected. The service binds to `0.0.0.0:$PORT`; Render's
default is `10000`, and the blueprint wires the API's `ENGINE_URL` to the
engine's `hostport` so the two cannot drift.

| Method & path | Purpose |
| --- | --- |
| `GET /health` | Liveness plus the REA version. **Requires the secret** — a private service has no Render health check (a `pserv` cannot declare `healthCheckPath`), so the only caller is the API, and the API sends the secret. |
| `GET /capabilities` | The readiness snapshot (§6.3), normalised. Cached (§10.3). |
| `GET /operations` | The operation registry (§6.2): the 24 target kinds, each with availability and requirements. |
| `POST /analyses` | Start an analysis. Body: the artifact bytes, raw, `Content-Type: application/octet-stream`; the operation id in the `X-Engine-Operation` header; the deadline in `X-Engine-Timeout-Ms`. Returns `202` + `{analysis_id}`. |
| `GET /analyses/:id` | `{status, progress, phase, message, result, limitations, error, duration_ms, truncated}`. |
| `POST /analyses/:id/cancel` | `202`; terminates the REA child (SIGTERM, then SIGKILL after a grace period). |
| `DELETE /analyses/:id` | Removes the engine's working copy of the artifact. |

**Body size.** The engine's body parser accepts at least the API's ceiling
(C5): 40 MB. The artifact arrives raw, not base64 — the API base64-encodes
only because the API's own upload contract is JSON, and there is no reason to
pay 33% again on the second hop.

### 6.2 The operation registry

One entry per target kind — the 24 rows of REA's own "What you can analyze"
table. The table lists *targets*, not commands, so each entry names the REA
command(s) that serve it. **Those command names must be verified against
REA's real `--help` output (155 commands) and captured as a fixture**, not
read from the table.

The registry is a static declaration in code, so the panel's wording is ours
and does not change with the engine's version:

```ts
type OperationEffect = 'static' | 'executes-target' | 'network';

type OperationRequirement = {
  name: string;                 // 'GHIDRA_INSTALL_DIR'
  kind: 'env' | 'tool' | 'licence';
  check: string;                // the doctor check that satisfies it
  detail: string;               // what is needed, in one sentence
};

type Operation = {
  id: string;                   // 'js_application'
  label: Record<Locale, string>;
  target: string;               // 'JavaScript / Electron application'
  effect: OperationEffect;      // 'static' for everything we expose
  commands: string[];           // the REA CLI commands that serve it
  requirements: OperationRequirement[];
};
```

### 6.3 How availability is computed

REA reports its own readiness. The measured shape of `rea doctor --json` is:

```json
{ "healthy": false,
  "scope_checks": [
    { "name": "node", "ok": true,  "classification": "healthy", "detail": "24.18.1" },
    { "name": "ghidra", "ok": false, "classification": "missing_analysis_engine",
      "detail": "GHIDRA_INSTALL_DIR is not set",
      "remediation": "Set GHIDRA_INSTALL_DIR to an extracted Ghidra 12.1.x release directory." },
    { "name": "jadx", "ok": false, "classification": "missing_analysis_engine",
      "remediation": "Set REA_JADX_MCP_JAR to the absolute path of a caller-supplied jadx-headless-mcp 0.7.1 JAR. REA does not download or install it." }
  ],
  "providerInspections": [
    { "id": "ghidra", "configured": false, "available": false,
      "checks": [ { "name": "configuration", "ok": false, "code": "not_configured",
                    "detail": "...", "remediation": "..." } ] }
  ],
  "identity": { "cli_package_version": "6.7.0", "catalog": { "counts": { "cli_commands": 153, "mcp_tools": 207 } } } }
```

`rea capabilities --json` reports the providers and their operations, each
group carrying `available`, `reason` and `availability_code` (e.g.
`unsupported_host` for the macOS-native group on Linux).

**The mapping is explicit.** Each `OperationRequirement.check` names the
doctor check that satisfies it, so availability is *computed*:

- every requirement's check is `ok` → **available**;
- a requirement's check is not `ok` → **unavailable**, and the panel shows
  REA's own `remediation` text verbatim, not a paraphrase;
- a provider group reports `unsupported_host` → **unsupported on this host**.

**Two corrections to the previous revision of this document**, both found by
review:

- The REA version does **not** come from a top-level `version` field. REA's
  output has none; the version is at `identity.cli_package_version` and at
  `server_identity.server.version`. The existing
  `extractVersion` (`capabilities.ts:26-37`) reads a top-level `version` and
  therefore always returns `null` against real REA. That is a defect in the
  current code and is fixed as part of this work.
- `rea doctor` exits `1` when required checks fail, so the exit code is not
  the success signal. The `ok` field is.

### 6.4 What the engine never does

- It never executes an uploaded artifact. REA's static inspection reads
  bytes; the registry refuses the commands that do not.
- It never reaches the public internet on behalf of an operator. Network
  effects are a property of the operation, not of the caller.
- It never returns a result it did not obtain. If REA fails, the engine
  reports the failure with REA's own stderr (sanitised), and the result is
  absent — never a plausible-looking placeholder.

### 6.5 The safety boundary

An operation whose `effect` is `executes-target` or `network` is refused by
the engine with `403 OPERATION_REFUSED`, permanently, unless an operator
explicitly sets `ENGINE_ALLOW_EFFECT_<ID>`. The default set exposes `static`
only.

This covers REA commands that run a target or reach the network —
`capture-process`, `capture-browser-scenario`, `capture-electron-scenario`,
`debug-with-gdb`, `debug-with-rizin`, `execute-rizin-command`,
`cutter-command` — all of which exist in REA's real `--help` output. The API
cannot ask for them either: its allowlist is narrower than the engine's
registry, and the engine is the one that enforces.

---

## 7. The API side

### 7.1 The adapter becomes a client

`backend-api/src/services/seefast/adapter.ts` currently imports
`child_process` (line 1) and spawns the engine (lines 74-103). It becomes an
HTTP client with a similar result shape, so the rest of the runner barely
moves:

- `runOperation(type, artifactPath, limits)` → `startAnalysis(operationId,
  artifactPath, timeoutMs)`, returning `{analysisId}`.
- `toRawRun` (39-71) and the `RawRun` type (20-28) are replaced by the
  engine's status vocabulary.
- `capabilities.ts` stops spawning (line 81) and asks the engine's
  `/capabilities`; `isRunnablePath` (48-57) disappears with it, and
  `extractVersion` (26-37) is corrected per §6.3.

The `JOB_OPS` allowlist (adapter.ts:14-18) stays, and stays narrow: three
operations, mapped to registry ids.

### 7.2 The runner

`jobsRunner.ts` keeps the queue, the slot, the FIFO promotion, the boot
recovery and the audit. What changes is the coupling to a local child:

| Coupling today | Becomes |
| --- | --- |
| `runningProcesses` map (78-79) | a map of `analysisId` per job |
| `startRun` monkey-patching `execFile` (101-130) | `POST /analyses` to the engine |
| `child.kill('SIGTERM')` in `cancelJob` (355-358) | `POST /analyses/:id/cancel` |
| `mapRunToOutcome` (142-153) | a mapping of the engine's status vocabulary |
| `parseStdout` (132-138) | the engine's parsed result |
| `sanitizeErrorMessage` (56-63) | unchanged, plus the engine's own sanitised detail |

The outcome vocabulary stays the same (`completed`, `failed`, `cancelled`,
`partial`) so the database, the export and the panel do not change.

**The queue-wedge defect (audit H10) is fixed in passing**: with a remote
engine there is no in-process child to leak, and a failed finalisation can be
retried instead of leaving the row `running` for ever.

### 7.3 Progress

REA emits progress events on **stderr**, one JSON object per line. Measured
from a real run:

```json
{"rea_progress":{"phase":"parse_javascript_source","completed":4,"total":5,
                 "message":"Parsing and projecting renderer/app.js (4/5)","sequence":8}}
```

**This stream is not in REA's public documentation.** REA documents MCP
progress tokens instead, and those deliberately omit `total` because the
number of future observations is unknown — REA does not fabricate
percentages. The CLI stream measured here does carry `total`, but only
*per phase*: the phases have different totals, so a single overall
percentage is **not** derivable honestly.

The engine therefore reports the phase, the phase's fraction and the engine's
own message, and the API stores them. The `progress` integer keeps its
contract — **1..100 is a measurement, 0 means "not measured"** (Fase A) — and
carries the *current phase's* fraction when the phase has a total. The
phase's text needs somewhere to live, so `cyberlab_jobs` gains a
`progress_detail JSONB` column holding `{phase, completed, total, message,
sequence}`.

That column needs an `ALTER TABLE`. The repository's schema lives in one
inline multi-statement `CREATE TABLE IF NOT EXISTS` bootstrap
(`backend-api/src/config/database.ts:76-1293`) and contains **no `ALTER
TABLE` statements at all**, so this work introduces the repository's first
idempotent migration: `ALTER TABLE cyberlab_jobs ADD COLUMN IF NOT EXISTS
progress_detail JSONB`, appended to that same bootstrap, which already runs
on every boot and is already idempotent.

Because the progress stream is undocumented, the engine's parser must be
defensive — a stream that stops being emitted degrades to "not measured",
never to a wrong number — and the stream must be captured as a fixture
(§12), like the analysis output.

### 7.4 Capability probe

`GET /api/cyberlab/providers` now reports the *engine service's* state:
reachable, REA version, and how many of the 24 operations are available here.
`not_configured` means "no engine service configured" (`ENGINE_URL` unset);
`probe_failed` means "configured but unreachable"; a new `unavailable` reason
covers "reachable but the engine's own dependencies are missing". The three
are distinct, because Fase A's whole point was that they were not.

### 7.5 Concurrency, timeout and truncation

Three things the previous revision left open:

- **Concurrency.** One analysis peaks at 302 MB; the engine has 2 GB and one
  CPU. The engine therefore **serialises**: it runs one analysis at a time
  and answers `429 ENGINE_BUSY` to the second. The API's own queue absorbs
  that — a job that gets `429` stays `queued` and is retried with backoff,
  which is exactly what the queue is for. The API's `maxConcurrent` setting
  is clamped to 1 for a remote engine, and the panel says why ("the engine
  runs one analysis at a time").
- **Timeout.** The engine owns the deadline, because the engine owns the
  child. The API sends `limits.jobTimeoutMs` (default 120 s, max 600 s) with
  the request; the engine SIGTERMs the child at the deadline and reports
  `timeout`; the API maps it to `failed` with error `TIMEOUT`, exactly as
  today.
- **Truncation.** `limits.maxStdoutBytes` (5 MB) has no remote equivalent
  until the engine imposes one: the engine truncates REA's stdout at the
  limit and reports `truncated`; the API maps it to `partial`, exactly as
  today.

---

## 8. The findings contract

**The engine extracts; the API stores.** The previous revision contradicted
itself here (§8 said the engine, §12 said the API). The engine wins, for a
concrete reason: REA's raw output for a real Electron app is plausibly tens
of megabytes, and parsing that inside the API's 512 MB free-plan container —
which also holds the PostgreSQL pool — is an out-of-memory waiting to happen.
The engine returns a **bounded, shaped** payload; the raw REA JSON never
crosses the private network into the API.

`backend-api/src/services/seefast/normalize.ts` is therefore replaced by the
engine's extractors, and the API's findings are written from the engine's
shaped payload.

### 8.1 What REA actually returns (measured)

For `analyze-javascript-application`, the top level is:

```
evidence_id, subject, provider, analysis_profile, predicate_type, operation,
parameters, raw_result, normalized_result, confidence, authority, environment,
limitations, relationship_coverage, locations, evidence_links
```

and `normalized_result` holds `input_path, format, root_artifact_sha256,
inventory_manifest_id, inventory_graph_sha256, integrity_contradictions,
graph, summary, statistics, limitations, semantic_graph`.

The counts the panel wants live in:

- `normalized_result.summary` — `browser_windows`, `preload_entrypoints`,
  `context_bridge_apis`, `exposed_api_members`,
  `native_addon_bindings`, `resolved_native_addon_bindings`,
  `sender_validation_observations`, `utility_processes`, and
  `ipc.{operations, literal_channels, dynamic_channel_operations,
  renderer_transmissions, renderer_listeners, main_handlers,
  paired_renderer_transmissions, ambiguous_renderer_transmissions,
  unpaired_literal_renderer_transmissions}`
- `normalized_result.statistics` — `relevant_files`, `parsed_javascript_files`,
  `modules`, `findings`, `parse_failures`, `visited_ast_nodes`,
  `text_bytes_read`, `invalid_utf8_files`, `nested_asar_containers`,
  `skipped_javascript_files`

For `inspect-go-binary`, REA's own documentation states the result contains
`build_info` with `go_version`, `module.path`, `module.main`,
`module.dependencies[]`, `module.settings`, `module.complete`, and the
artifact's SHA-256, byte length, container format, architecture, word size and
byte order.

For `inspect-rust-binary`: package names, versions, sources, the root package,
dependency edges and the section's file range.

Every result also carries top-level `limitations` — real sentences about what
the analysis did not establish ("Electron relationships are derived from inert
syntax; runtime registration, reachability, defaults, and enforcement remain
unproven"). **Those limitations are shown, not hidden.** They are the
difference between an analysis and a demo.

### 8.2 The gap that must be closed before those extractors are written

The JavaScript shape above was measured by running REA. **The Go and Rust
shapes were read from REA's documentation, not measured**: this machine has
no Go or Rust toolchain and no sample binaries, so `inspect-go-binary` and
`inspect-rust-binary` were never executed.

The plan must therefore, before writing those two extractors:

1. Build two tiny fixture binaries — a `package main` in Go and a `fn main` in
   Rust — in the engine service's CI job, which installs both toolchains.
2. Run the real REA commands against them and capture the output.
3. Commit the captured output as a fixture, so the test suite asserts against
   the real contract without needing the toolchains.
4. Write the extractors against the fixture, not against the documentation.

If the measured shape differs from the documentation, the documentation is
wrong and the fixture wins. That is the whole point of capturing it.

The same discipline applies to the **progress stream** (§7.3) and to the
**command catalogue** (§6.2): all three are contracts the engine depends on
and none of them is fully documented, so all three are captured as fixtures.

### 8.3 What a finding is

Today every finding is `kind='fact'`, `severity='info'`, `confidence='high'`
(`normalize.ts:88-97`) — the severity and confidence axes are not really
populated, and the panel's "Findings by Severity" is a chart of one bar.

The operator's rule is that vulnerabilities, metrics and capabilities must
not be invented. REA's static analysis does not assess risk; it establishes
**facts** with evidence. So:

- a finding is a fact REA established, carrying REA's own evidence (the
  path, the value, the limitation that applies to it);
- a finding carries **no severity and no confidence of its own**. REA's
  `confidence` and `authority` are carried through when present, as REA's
  values, not as ours;
- the panel's "Findings by Severity" becomes **"Findings by kind"** for
  engine findings, and each finding shows its evidence and the limitations
  that apply to it.

This is a consequence of the operator's own rule, not a new decision: the
alternative would be inventing a severity axis, which the brief forbids.

### 8.4 The artifact shape

REA's JavaScript analysis takes **an extracted application directory or an
ASAR** — `rea analyze-javascript-application /absolute/path/to/app --json`,
and the repository's own integration test already runs the adapter over a
*directory* (`backend-api/tests/cyberlabIntegration.test.ts:272,305`). The
API's upload contract, on the other hand, is one base64 blob written to one
file (`routes/cyberlab.ts:98-104`), and `storage_path` is a file path handed
straight to the runner (`jobsRunner.ts:236`).

The upload contract does not change. The **engine** handles the shape: it
receives the file and, when the operation needs a tree, unpacks it — with
REA's own `extract-artifact`, which is in REA's real command list — and hands
the extracted directory to the analysis command. The size ceiling is
therefore measured on the *uploaded* file, which is what the API enforces
(C5), and the engine enforces the same ceiling on what it unpacks.

---

## 9. Artifact custody and the ephemeral disk

The API holds the artifact. The engine needs the bytes.

**Transfer.** The API reads the file from its disk and POSTs the raw bytes
to `POST /analyses` (C5 sets the size). The engine writes them to its own
working directory, analyses them, and deletes them when the analysis ends.
The engine's working directory is its own, and its disk is ephemeral too —
which is correct: it is scratch space, not custody.

**The API's own ephemeral disk is a separate problem, and this design does
not solve it.** Audit finding H11: the API's artifact rows survive a
redeploy but the files do not, so every job on a pre-redeploy artifact fails
with "artifact for this job no longer exists". Two things follow:

- The engine is never handed a path that does not exist. It receives bytes,
  not a path, so this is structural.
- The API must detect the missing file and report it as what it is. The job
  ends **`failed`** — the outcome vocabulary does not grow — with a distinct
  error code `EVIDENCE_UNAVAILABLE` and the panel's own wording: "the
  evidence file is no longer available on this host". That is materially
  different from a generic failure, and it is what the operator needs to see.

**The availability flag is computed, not stored.** The previous revision said
the artifact row "gains an explicit `available` state", which reads as a
column. It is not a column: a persisted boolean goes stale the moment the
file is deleted, which is exactly the condition it exists to detect.
`GET /artifacts` (`routes/cyberlab.ts:139-162`) does no filesystem check
today; it gains one — an `fs.exists` per row, twenty rows per page, which
costs nothing — and the response carries `available: boolean` alongside the
existing fields. No schema change, no migration, no staleness.

---

## 10. Deployment

### 10.1 Render

`render.yaml` gains a fourth service. The blueprint's type for a private
service is **`pserv`**, not `private`; `private` is rejected at apply time.
A `pserv` also cannot declare `healthCheckPath` (that field is web services
only), which is why the engine's `/health` is authenticated and only the API
calls it.

```yaml
  - type: pserv
    name: endpointx-engine
    runtime: docker
    region: oregon            # must match the API's region
    plan: 1c-2g               # 1 CPU / 2 GB — the engine needs more than 512 MB
    dockerfilePath: ./engine-service/Dockerfile
    envVars:
      - key: ENGINE_SECRET
        generateValue: true   # generated by Render, never pasted
      - key: PORT
        value: "10000"
      # REA provider configuration — all optional, all operator-supplied.
      - key: GHIDRA_INSTALL_DIR
        sync: false
      - key: HOPPER_LAUNCHER_PATH
        sync: false
      - key: REA_IDA_MCP_CONFIG
        sync: false
      - key: REA_JADX_MCP_JAR
        sync: false
      - key: REA_KUNA_COMMAND
        sync: false
      - key: REA_ANALYSIS_PROVIDER
        sync: false
```

The API gains `ENGINE_URL` and `ENGINE_SECRET`, and **loses** the
`SEEFAST_ENGINE_PKG` / `SEEFAST_ENGINE_PKG_SHA256` / `SEEFAST_CLI` block
(lines 64-76) — they belong to the engine's image, which installs
`rea-agents` from npm at build time instead of downloading a package at
boot.

The secret is wired by the blueprint, not by hand:

```yaml
      - key: ENGINE_URL
        fromService:
          name: endpointx-engine
          type: pserv
          property: hostport        # http://endpointx-engine:10000
      - key: ENGINE_SECRET
        fromService:
          name: endpointx-engine
          type: pserv
          envVarKey: ENGINE_SECRET
```

**Region.** The API is in `oregon` (verified through the Render API). The
blueprint currently declares no `region` at all, which means it inherits
Render's default — also `oregon`, and correct today by luck. The blueprint
must pin `region: oregon` on **both** the API and the engine, so a future
default change cannot silently separate them: Render's private network is
per-region, and a service in the wrong region is simply unreachable.

**Cost: $25/month** for `1c-2g`. The API stays on `free`. The engine is a
private service, so it has no public URL and no public attack surface.

**The build.** The root `.dockerignore` excludes `**/node_modules` and
`*.md` (C9), so `engine-service/package-lock.json` must be committed and the
image must `npm ci` from it. The build context is the repo root.

### 10.2 Self-hosted

`docker-compose.yml` gains an `engine` service built from
`engine-service/Dockerfile`, and the `backend` service gets `ENGINE_URL`
pointing at it. The compose file's service names are `backend` and
`frontend`; `docs/deployment.md:125-198` quotes a compose file with
different names and references a `docker-compose.prod.yml` that does not
exist. That drift is fixed as part of this work, because the engine
instructions land in the same document.

### 10.3 Caching

`rea capabilities --json` takes 4.0 s and `rea --version` 3.2 s. The engine
runs both once and **caches the readiness snapshot for 60 seconds**, matching
the API's own `CACHE_TTL_MS` precedent (`limits.ts:27`). The API caches its
probe result for the same period. Without this, every job creation — which
calls `probeCapabilities()` (`routes/cyberlab.ts:206`) — would block for
seconds, and the engine would re-run its readiness audit per request.

The REA version comes from the cached snapshot's
`identity.cli_package_version` (and `server_identity.server.version`), not
from a separate `rea --version` call.

---

## 11. Security

- **S1** The engine is a private service (C8), in the same region as the API
  (pinned in the blueprint).
- **S2** Every route requires `X-Engine-Secret`, compared with `safeCompare`
  (C6, C11). No route reveals the registry, the REA version or anything else
  without it. The secret is generated by Render and never pasted anywhere.
- **S3** The engine refuses `executes-target` and `network` operations by
  default (§6.5). This is the property that makes the Cyber Lab safe to
  expose to operators: uploaded bytes are read, never run.
- **S4** The API remains the authorisation boundary. The engine is not
  reachable by an operator directly, and it holds no user identity, no
  session and no data beyond the bytes it was handed.
- **S5** The engine's error output is sanitised before it crosses the wire
  (`redactSensitiveText`, added in Fase A), so a provider's path or token
  does not reach the panel.
- **S6** Artifacts are operator data. They are not written to logs, not
  included in error messages, and not served from the engine's public
  surface (it has none).

---

## 12. Testing

| Layer | How | What it proves |
| --- | --- | --- |
| Engine service unit | The repository's standalone-assert style (C10), no network | The registry maps REA's doctor output to availability; `executes-target` operations are refused; the progress parser is defensive; the secret check uses `safeCompare` |
| Engine service integration | The real REA, in the engine's image | `rea capabilities --json` and `doctor --json` parse; the three analysis commands run against fixtures and produce the expected shape; the progress stream is emitted and parsed |
| Contract fixtures | Committed JSON captured from real REA runs | The extractors assert against REA's real output — the analysis output (§8.2), the progress stream (§7.3) and the command catalogue (§6.2) — not a guess |
| API client | The repository's standalone-assert style with a fake engine server | The adapter maps every engine status to the right job outcome; cancel reaches the engine; progress is written to the database; `429` leaves the job queued; a failed finalisation does not wedge the queue |
| Panel | The out-of-repo Playwright scripts used in Fase A | The panel shows the catalogue with real availability, shows the phase and its fraction, shows the engine's limitations, and shows "evidence not available" when the file is gone |

**CI needs a second job.** `.github/workflows/ci.yml` currently has exactly
one job, `backend`. The engine service needs its own job, with the REA
package installed plus the Go and Rust toolchains used to build the two
fixture binaries (§8.2). The existing `backend` job must keep its
PostgreSQL service: `tests/authSession.test.ts` needs a real database and
skips nothing.

**The existing `backend-api/tests/cyberlabIntegration.test.ts` skips itself
when the engine is absent** (lines 32-35). That stays true for a developer
without an engine, but CI must run it **with** one — the engine service's
image is the CI environment.

---

## 13. Migration and removal

**Removed** (and why):

- `backend-api/src/services/seefast/adapter.ts`'s `child_process` usage
  (lines 1, 39-103) — the engine is remote now.
- `backend-api/src/services/seefast/capabilities.ts`'s spawn (line 81) and
  `isRunnablePath` (48-57) — same reason.
- `backend-api/src/services/seefast/normalize.ts` — the extraction moves to
  the engine (§8), and the guessed field names go with it.
- `backend-api/docker/install-engine.cjs` and the `SEEFAST_ENGINE_PKG` /
  `SEEFAST_ENGINE_PKG_SHA256` / `SEEFAST_CLI` variables — the engine image
  installs `rea-agents` from npm at build time, which is what a package
  needs. A download hook that writes raw bytes to a path cannot install an
  npm package: the tarball is not an executable.
- `backend-api/tests/engineInstall.test.ts` — it tests the hook above.
- The `SEEFAST_*` block in `render.yaml` (lines 64-76).

**Kept:**

- The `JOB_OPS` allowlist and the three-operation job vocabulary. The
  operation ids are stable; the transport underneath is not.
- The job table, the queue, the slot, the cancellation semantics, the
  outcome vocabulary, the export, the audit, the RBAC, the evidence custody.
- Every panel section and every panel behaviour fixed in Fase A.

**This is a functional removal, and it is deliberate**: the local-engine
path is replaced, not simulated. The alternative — keeping a second
transport — is on the table and is asked about in §15.

---

## 14. What is left for the builder

- The exact shape of the engine service's `package.json` and whether it
  compiles TypeScript or runs `tsx` as the API does. **Recommendation:** run
  `tsx` exactly as the API does (`CMD ["./node_modules/.bin/tsx",
  "src/index.ts"]`), because that is the pattern already proven in this
  repository, and the API's `npm run build` is a no-op (`"build": "echo ok"`).
- The engine's analysis store: an in-memory map is enough if analyses are
  short-lived and the service is the only writer, but a restart loses the
  in-flight analysis. The API must therefore treat "the engine restarted" as
  a failure and re-queue, not as a hang. Decide the in-memory-vs-disk
  question and make the API's handling explicit either way.
- How long the engine keeps the artifact copy, and whether the API asks it
  to delete (`DELETE /analyses/:id`) or the engine deletes on its own.
- The exact wording of the panel's "partially operational" state.
- The order of work, which the plan must fix.

---

## 15. Decisions taken (operator, 2026-10-22)

**D1 — One path. The engine service is the only path.** The API does not
keep a local-spawn transport. The removals in §13 stand in full: the local
spawn code, `install-engine.cjs`, the `SEEFAST_*` variables and
`engineInstall.test.ts` go. `docker compose` gains an `engine` service, so
the self-hosted deployment keeps working with one more container.

**D2 — The engine runs on `1c-2g` (1 CPU / 2 GB, $25/month); the API stays
on `free`.** The engine needs more than 512 MB (measured: 302 MB peak per
analysis) and therefore cannot run on the free plan. The API can stay on
`free` precisely because it no longer carries the engine.

**D3 — Region `oregon` for both services.** The API is in `oregon` today
(verified through the Render API). The blueprint pins it explicitly on both
services so a future Render default change cannot silently separate them
and leave the engine unreachable over the private network.

### The calls the builder should check while reading

These were settled by me, not by the operator, and each is a place where a
different reading would change the work:

| # | Call | Where | Why |
| --- | --- | --- | --- |
| C1 | The **engine** extracts findings; the API stores them. The raw REA JSON never reaches the API. | §8 | REA's raw output for a real Electron app is plausibly tens of MB; parsing it inside the API's 512 MB container is an out-of-memory waiting to happen. |
| C2 | The **engine unpacks** archives (with REA's own `extract-artifact`); the API's one-file upload contract does not change. | §8.4 | REA's JS analysis wants a directory or ASAR; the upload contract is a product decision that need not move. |
| C3 | The engine **serialises** (one analysis at a time) and answers `429`; the API's queue absorbs it, and `maxConcurrent` is clamped to 1 with the reason shown. | §7.5 | 302 MB × 4 on a 2 GB plan is an OOM, and Render restarts the service, killing every in-flight analysis at once. |
| C4 | The **engine owns the timeout** and the stdout limit; the API passes `jobTimeoutMs` and maps `timeout`→`failed`/`TIMEOUT` and `truncated`→`partial`, exactly as today. | §7.5 | The engine owns the child, so it must own the deadline. |
| C5 | A missing evidence file is a **`failed` job with the code `EVIDENCE_UNAVAILABLE`** — the outcome vocabulary does not grow. | §9 | A new outcome would ripple through the database, the export and the panel for no gain; the distinct error code and the panel's wording carry the meaning. |
| C6 | Artifact availability is **computed per request** (`fs.exists` on the page's twenty rows), not a persisted column. | §9 | A persisted boolean goes stale the moment the file is deleted — which is the exact condition it exists to detect. |
| C7 | The operation catalogue lives on the **Integrations** page, which already shows the engine's state. | §12 | The six stub sections are a Fase C non-goal; this avoids a new route, a new nav entry and a new i18n family. |
| C8 | Engine findings carry **no severity and no confidence of their own**; the panel's "Findings by Severity" becomes "Findings by kind". | §8.3 | REA establishes facts, not risks. A severity axis would be an invented metric, which the operator's brief forbids. |
| C9 | The engine service **duplicates** `safeCompare` and `redactSensitiveText` rather than importing them. | C11 | `helpers.ts` imports `bcryptjs` and `jsonwebtoken`; importing it would drag both into the engine image. |
| C10 | The engine's tests follow the repository's **standalone-assert** convention, not `node:test`. | C10 | The repository has no test runner; `node:test` appears nowhere in it. |
| C11 | `cyberlab_jobs` gains a `progress_detail JSONB` column, added by the repository's **first idempotent `ALTER TABLE`**, appended to the existing schema bootstrap. | §7.3 | The phase's text has to survive a restart, and the bootstrap already runs on every boot and is already idempotent. |


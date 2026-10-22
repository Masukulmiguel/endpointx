# Cyber Lab engine service — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Cyber Lab a real analysis engine: a separate service that owns REA, runs the 24 target kinds with their dependencies declared, and returns findings extracted from REA's real output contract — so the panel can show an analysis that happened, with the evidence and the limitations that came with it.

**Architecture:** A new `engine-service/` (a private Render service, `pserv`, `1c-2g`) owns the REA binary, the operation registry and the analysis lifecycle. The API keeps the artifact, the queue and the RBAC, and talks to the engine over Render's private network with a shared secret. The engine extracts findings; the API stores them. The raw REA JSON never enters the API's 512 MB container.

**Tech Stack:** Node 22, TypeScript run through `tsx` (the pattern `backend-api` already uses), Express, `rea-agents@6.7.0`, PostgreSQL (unchanged), Render private services.

**Spec:** `docs/superpowers/specs/2026-10-22-cyberlab-engine-service-design.md`

## Global Constraints

These apply to every task. Values are copied verbatim from the spec.

- **Zero new npm dependencies in `backend-api` and `admin-dashboard`.** The engine service is new and may depend on `rea-agents`; the API and the dashboard may not gain anything.
- **The engine image is `FROM node:22`.** REA requires Node `^22.19.0 || ^24.11.0 || >=26.0.0`; the API's image stays on `node:20`.
- **The API's image, plan and region do not change.** The API stays on Render `free`, region `oregon`.
- **The engine is `type: pserv`, `plan: 1c-2g`, `region: oregon`.** `type: private` is invalid in a Render blueprint and is rejected at apply time.
- **Machine-to-machine auth is a shared secret in the `X-Engine-Secret` header, compared with `safeCompare`.** No new auth scheme.
- **`safeCompare` and `redactSensitiveText` are copied into the engine service, not imported.** `backend-api/src/utils/helpers.ts` imports `bcryptjs` and `jsonwebtoken`; importing it would drag both into the engine image.
- **The engine service's tests follow the repository's standalone-assert convention** — plain `assert` plus a hand-rolled `checkAsync`, standalone `tsx` scripts chained with `&&` in `package.json`. `node:test` appears nowhere in this repository and must not be introduced.
- **The engine's image must `npm ci` from a committed `engine-service/package-lock.json`.** The root `.dockerignore` excludes `**/node_modules`, `docs` and `*.md`.
- **The `progress` column stores 1..100 for a measurement and 0 for "not measured".** A stored 0 is the schema's default, not a measurement.
- **Findings carry no severity and no confidence of their own.** REA establishes facts, not risks.
- **The engine refuses `executes-target` and `network` operations.** Uploaded bytes are read, never run.
- **The engine's raw REA output never crosses the network into the API.** The engine returns a bounded, shaped payload.

## Review Focus

Five failure modes the spec implies that no other requirement makes obvious. Each has a test, in the task that owns the code.

1. **The engine is unreachable** — wrong secret, wrong region, service down, or `ENGINE_URL` unset. The panel must say *unavailable*, never *not configured*; and `POST /jobs` must not create a job. → Task 8, Task 12.
2. **The artifact file is gone** — the API's disk is ephemeral, so a redeploy orphans every artifact row. The job must end `failed` with `EVIDENCE_UNAVAILABLE` and the panel must say the evidence is unavailable, not that the analysis failed. → Task 11.
3. **REA's output shape changes** — a version bump renames a field. The extractor must produce zero findings and the raw limitation, never a wrong count and never a crash. → Task 5.
4. **The engine is busy** — it serialises, so a second analysis gets `429`. The job must stay `queued` and be retried; it must never fail and never wedge the queue. → Task 6, Task 9.
5. **The engine restarts mid-analysis** — the in-flight analysis is lost. The job must fail and become re-queueable, not hang for ever. → Task 9.

---

## File Structure

```
engine-service/
  package.json              # scripts: dev, start, test; dependency: rea-agents
  package-lock.json         # committed (the root .dockerignore excludes node_modules)
  Dockerfile                # FROM node:22; npm ci; runs tsx
  tsconfig.json
  src/
    index.ts                # boots the HTTP server on 0.0.0.0:$PORT
    app.ts                  # builds the Express app and mounts the routes
    config.ts               # reads the environment into a typed config
    util/safeCompare.ts     # copied from backend-api/src/utils/helpers.ts:56-61
    util/redact.ts          # copied redactSensitiveText
    auth/requireEngineSecret.ts
    registry/types.ts       # Operation, OperationRequirement, OperationEffect
    registry/operations.ts  # the 24 static entries
    registry/availability.ts# maps a readiness snapshot onto an operation
    readiness/doctor.ts     # the parsed types of rea doctor --json
    readiness/snapshot.ts   # runs the two REA commands, normalises, caches 60s
    analysis/store.ts       # the in-memory analysis map
    analysis/progress.ts    # parses the rea_progress JSONL stream
    analysis/runner.ts      # spawns REA, enforces the deadline, tracks the child
    analysis/extract/types.ts
    analysis/extract/jsApplication.ts
    analysis/extract/goBinary.ts
    analysis/extract/rustBinary.ts
    analysis/extract/index.ts
    routes/health.ts
    routes/capabilities.ts
    routes/operations.ts
    routes/analyses.ts
  scripts/build-fixtures.mjs # builds the Go and Rust fixture binaries and captures their REA output
  tests/                    # standalone-assert scripts, one concern each
  fixtures/                 # captured from real REA runs; committed

backend-api/src/services/seefast/
  engineClient.ts           # NEW: the HTTP client for the engine service
  adapter.ts                # MODIFIED: the local spawn becomes the client
  capabilities.ts           # MODIFIED: probes the engine service
  jobsRunner.ts             # MODIFIED: the analysis lifecycle
  normalize.ts              # REMOVED: the extraction moves to the engine
backend-api/src/routes/cyberlab.ts   # MODIFIED: artifacts carry availability
backend-api/src/config/database.ts   # MODIFIED: progress_detail column + migration
admin-dashboard/src/pages/cyberlab/
  CyberLabIntegrations.tsx  # MODIFIED: the operation catalogue
  CyberLabJobDetail.tsx     # MODIFIED: the phase, the fraction, the limitations
  CyberLabFindings.tsx      # MODIFIED: findings by kind
render.yaml                 # MODIFIED: the pserv, the region, the fromService wiring
docker-compose.yml          # MODIFIED: the engine service
.github/workflows/ci.yml    # MODIFIED: the engine job
```

---

### Task 1: The engine service skeleton

**Files:**
- Create: `engine-service/package.json`, `engine-service/package-lock.json`, `engine-service/Dockerfile`, `engine-service/tsconfig.json`
- Create: `engine-service/src/index.ts`, `engine-service/src/app.ts`, `engine-service/src/config.ts`
- Create: `engine-service/src/util/safeCompare.ts`, `engine-service/src/util/redact.ts`
- Create: `engine-service/src/auth/requireEngineSecret.ts`, `engine-service/src/routes/health.ts`
- Test: `engine-service/tests/auth.test.ts`, `engine-service/tests/health.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `safeCompare(a: unknown, b: unknown): boolean` — SHA-256 both sides, then `crypto.timingSafeEqual`; non-string input returns `false`.
  - `redactSensitiveText(raw: string, maxChars?: number): string` — one line; strips `scheme://…` URLs, query strings, `Bearer …`, and `sk-`/`pk-`/`api-`/`key-`/`token-`/`secret-` credentials; caps at `maxChars` (default 200).
  - `requireEngineSecret(): (req: Request, res: Response, next: NextFunction) => void` — compares `req.headers['x-engine-secret']` with `config.engineSecret` using `safeCompare`; `401` with the body `{"error":"unauthorized"}` when absent or wrong; calls `next()` otherwise.
  - `loadConfig(): EngineConfig` — `{ port: number; engineSecret: string; maxArtifactBytes: number; maxStdoutBytes: number; jobTimeoutMs: number; snapshotTtlMs: number }`. `port` from `PORT` (default `10000`), `engineSecret` from `ENGINE_SECRET`, `maxArtifactBytes` from `ENGINE_MAX_ARTIFACT_MB` (default 28 → bytes), `maxStdoutBytes` from `ENGINE_MAX_STDOUT_MB` (default 5 → bytes), `jobTimeoutMs` from `ENGINE_JOB_TIMEOUT_MS` (default 120000), `snapshotTtlMs` from `ENGINE_SNAPSHOT_TTL_MS` (default 60000).
  - `createApp(): Express` — mounts `GET /health` behind `requireEngineSecret()`.

- [ ] **Step 1: Write the failing test**

`engine-service/tests/auth.test.ts`:

```ts
import './testEnv';
import assert from 'assert';
import { safeCompare } from '../src/util/safeCompare';

let failed = 0;
const checkAsync = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try { await fn(); console.log(`  ok  ${label}`); }
  catch (error) { failed++; console.error(`FAIL  ${label}`); console.error(`      ${(error as Error).message}`); }
};

async function main(): Promise<void> {
  await checkAsync('safeCompare accepts the same secret', async () => {
    assert.strictEqual(safeCompare('abc', 'abc'), true);
  });
  await checkAsync('safeCompare rejects a different secret', async () => {
    assert.strictEqual(safeCompare('abc', 'abd'), false);
  });
  await checkAsync('safeCompare rejects a non-string', async () => {
    assert.strictEqual(safeCompare(undefined, 'abc'), false);
    assert.strictEqual(safeCompare('abc', undefined), false);
  });
  if (failed > 0) { console.error(`\n${failed} test(s) FAILED`); process.exit(1); }
  console.log('\nALL PASS');
}
main().catch((error) => { console.error(error); process.exit(1); });
```

`engine-service/tests/health.test.ts` — an HTTP test that boots `createApp()` on port 0 and asserts:

- `GET /health` without `X-Engine-Secret` → `401` and body `{"error":"unauthorized"}`.
- `GET /health` with the correct secret → `200` and body `{ "status": "ok" }`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine-service; npx tsx tests/auth.test.ts` and `npx tsx tests/health.test.ts`
Expected: FAIL — `Cannot find module '../src/util/safeCompare'`.

- [ ] **Step 3: Implement the skeleton**

`engine-service/src/util/safeCompare.ts` — copy the implementation from `backend-api/src/utils/helpers.ts:56-61` verbatim, with this comment above it:

```ts
// Copied from backend-api/src/utils/helpers.ts (safeCompare). That module
// imports bcryptjs and jsonwebtoken; importing it here would drag both into
// the engine image. Keep the two copies in step.
```

`engine-service/src/util/redact.ts` — copy `redactSensitiveText` from `backend-api/src/utils/helpers.ts` (added in the Fase A commit) verbatim, with the same "copied from" comment.

`engine-service/src/config.ts`:

```ts
export type EngineConfig = {
  port: number;
  engineSecret: string;
  maxArtifactBytes: number;
  maxStdoutBytes: number;
  jobTimeoutMs: number;
  snapshotTtlMs: number;
};

export function loadConfig(): EngineConfig { /* reads the env, applies the defaults above */ }
```

`engine-service/src/auth/requireEngineSecret.ts` — the guard described in the Interfaces block.

`engine-service/src/routes/health.ts` — `router.get('/health', (req, res) => res.json({ status: 'ok' }))`.

`engine-service/src/app.ts` — `createApp()` builds the Express app, applies `express.json({ limit: '1mb' })` (the analyses route overrides it with a raw body parser), and mounts `requireEngineSecret()` in front of the health route.

`engine-service/src/index.ts` — `app.listen(config.port, '0.0.0.0', ...)`.

`engine-service/package.json`:

```json
{
  "name": "endpointx-engine",
  "private": true,
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "tsx tests/auth.test.ts && tsx tests/health.test.ts"
  },
  "dependencies": {
    "express": "^4.19.2",
    "rea-agents": "6.7.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.14.0",
    "tsx": "^4.16.2",
    "typescript": "5.9.3"
  }
}
```

`engine-service/Dockerfile`:

```dockerfile
FROM node:22

WORKDIR /app

# The root .dockerignore excludes node_modules, so the lockfile must be
# committed and the image installs from it.
COPY engine-service/package.json engine-service/package-lock.json ./
RUN npm ci

COPY engine-service/ ./

EXPOSE 10000
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
```

`engine-service/tsconfig.json` — copy `backend-api/tsconfig.json` and change nothing but the include path.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine-service; npm install; npx tsx tests/auth.test.ts && npx tsx tests/health.test.ts`
Expected: `ALL PASS` twice.

- [ ] **Step 5: Commit**

```bash
git add engine-service
git commit -m "feat(engine): esqueleto do servico de motor com segredo partilhado"
```

---

### Task 2: The operation registry

**Files:**
- Create: `engine-service/src/registry/types.ts`, `engine-service/src/registry/operations.ts`
- Test: `engine-service/tests/registry.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `type OperationEffect = 'static' | 'executes-target' | 'network'`
  - `type OperationRequirement = { name: string; kind: 'env' | 'tool' | 'licence'; check: string; detail: string }`
  - `type Operation = { id: string; label: Record<'pt' | 'en', string>; target: string; effect: OperationEffect; commands: string[]; requirements: OperationRequirement[] }`
  - `OPERATIONS: Operation[]` — exactly 24 entries, one per row of REA's "What you can analyze" table.
  - `getOperation(id: string): Operation | undefined`

- [ ] **Step 1: Write the failing test**

`engine-service/tests/registry.test.ts` asserts:

- `OPERATIONS.length === 24`.
- Every `id` is unique and matches `/^[a-z0-9_]+$/`.
- Every entry has a `label.pt` and a `label.en`, both non-empty.
- Every entry has at least one entry in `commands`, and **every command name appears in REA's real command list** — asserted against the committed fixture `engine-service/fixtures/rea-commands.txt` (one command name per line, captured from `rea --help`).
- The 24 ids are exactly: `native_binary`, `elf_layout`, `go_binary`, `rust_binary`, `wasm_artifact`, `evm_bytecode`, `sqlite_database`, `linux_crash`, `javascript_electron`, `website`, `web_capture`, `dotnet_assembly`, `android_apk`, `android_device`, `jeb_project`, `android_resources`, `flutter_app`, `firmware`, `packet_capture`, `packet_summary`, `signal_recording`, `packages_resources`, `process_behavior`, `cross_platform_binaries`.
- The three operations the API is allowed to request are present with these commands: `go_binary` → `['inspect-go-binary']`, `rust_binary` → `['inspect-rust-binary']`, `javascript_electron` → `['analyze-javascript-application', 'extract-artifact']`.
- `getOperation('go_binary')` returns that entry; `getOperation('nope')` returns `undefined`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine-service; npx tsx tests/registry.test.ts`
Expected: FAIL — `Cannot find module '../src/registry/operations'`.

- [ ] **Step 3: Implement the registry**

`engine-service/src/registry/types.ts` — the three types above.

`engine-service/src/registry/operations.ts` — the 24 entries. Each entry names:

- the REA command(s) that serve it, taken from the real `rea --help` list;
- the requirements, each naming the `check` in REA's `doctor` output that satisfies it and a one-sentence `detail`.

The requirement-to-check mapping, taken from the measured `rea doctor --json` output:

| Requirement name | `check` | `kind` |
| --- | --- | --- |
| `GHIDRA_INSTALL_DIR` | `ghidra` | `env` |
| `HOPPER_LAUNCHER_PATH` | `hopper` | `env` |
| `REA_IDA_MCP_CONFIG` | `ida-registration` | `env` |
| `REA_JADX_MCP_JAR` | `jadx` | `env` |
| `REA_KUNA_COMMAND` | `kuna-installation` | `env` |
| `adb` on PATH | `adb` | `tool` |
| `tshark` on PATH | `tshark` | `tool` |
| `sigrok-cli` on PATH | `sigrok` | `tool` |
| `binwalk` on PATH | `binwalk` | `tool` |
| `JADX` + a full JDK | `jadx` | `tool` |
| `pwntools` | `pwntools` | `tool` |
| `Hopper / Ghidra / IDA licence` | `hopper` | `licence` |
| `a Chrome-family browser` | `browser` | `tool` |

An operation with no requirements is available everywhere REA itself says it
is (`available: true`).

**The three operations the API may request carry `effect: 'static'`.** Every
other entry in the registry is declared with the effect REA's own
`capabilities --json` reports for its group: `executes-target` for
`capture-process`, `capture-electron-scenario`, `capture-native-ui-scenario`,
`capture-adb-screen`, `capture-browser-scenario`, `debug-with-gdb`,
`debug-with-rizin`, `execute-rizin-command`, `cutter-command`,
`observe-native-ui`; `network` for `analyze-web-bundle`,
`capture-web-screenshot`, `discover-webmcp-tools`, `export-web-scripts`,
`capture-adb-*`.

- [ ] **Step 4: Capture REA's real command list**

Run (the REA package is installed under `%TEMP%\opencode\rea`; if it is not
there, `npm install rea-agents@6.7.0` in a scratch directory first):

```
node <rea>/scripts/rea.mjs --help
```

Write the command names — one per line, the second column of the help
output — to `engine-service/fixtures/rea-commands.txt`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd engine-service; npx tsx tests/registry.test.ts`
Expected: `ALL PASS`.

- [ ] **Step 6: Commit**

```bash
git add engine-service/src/registry engine-service/tests/registry.test.ts engine-service/fixtures/rea-commands.txt
git commit -m "feat(engine): registo das 24 familias de alvo com as dependencias"
```

---

### Task 3: Readiness and availability

**Files:**
- Create: `engine-service/src/readiness/doctor.ts`, `engine-service/src/readiness/snapshot.ts`, `engine-service/src/registry/availability.ts`
- Create: `engine-service/fixtures/rea-doctor.json`, `engine-service/fixtures/rea-capabilities.json`
- Test: `engine-service/tests/availability.test.ts`

**Interfaces:**
- Consumes: `OPERATIONS`, `Operation`, `OperationRequirement` (Task 2).
- Produces:
  - `type DoctorCheck = { name: string; ok: boolean; classification: string; detail?: string; remediation?: string }`
  - `type ReadinessSnapshot = { capturedAt: number; reaVersion: string | null; checks: DoctorCheck[]; providerOperationHealth: Record<string, { available: boolean; reason: string | null }> }`
  - `loadSnapshot(): Promise<ReadinessSnapshot>` — runs `rea capabilities --json` and `rea doctor --json`, normalises, and **caches the result for `config.snapshotTtlMs`**. A second call inside the TTL returns the cached snapshot and does not spawn anything.
  - `computeAvailability(op: Operation, snapshot: ReadinessSnapshot): { state: 'available' | 'unavailable' | 'unsupported_host'; missing: Array<{ name: string; detail: string; remediation: string | null }> }`

- [ ] **Step 1: Write the failing test**

`engine-service/tests/availability.test.ts` loads the two committed fixtures
and asserts:

- `loadSnapshot()` returns a snapshot whose `reaVersion` is `6.7.0` — read from `identity.cli_package_version` **or** `server_identity.server.version`, never from a top-level `version` (REA's output has no top-level `version`; the old `extractVersion` in `backend-api/src/services/seefast/capabilities.ts:26-37` reads that key and therefore always returns `null`).
- The `ghidra` check is present with `ok: false`, `classification: 'missing_analysis_engine'`, and a `remediation` mentioning `GHIDRA_INSTALL_DIR`.
- `computeAvailability(goBinaryOperation, snapshot)` → `{ state: 'available', missing: [] }`.
- `computeAvailability(anOperationRequiringGhidra, snapshot)` → `{ state: 'unavailable', missing: [{ name: 'GHIDRA_INSTALL_DIR', remediation: 'Set GHIDRA_INSTALL_DIR to an extracted Ghidra 12.1.x release directory.' }] }` — the remediation is REA's own sentence, verbatim.
- An operation whose provider group reports `availability_code: 'unsupported_host'` → `{ state: 'unsupported_host', missing: [] }`.
- A snapshot with no `checks` at all → every operation is `unavailable` with the missing requirement named, never `available`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine-service; npx tsx tests/availability.test.ts`
Expected: FAIL — `Cannot find module '../src/readiness/snapshot'`.

- [ ] **Step 3: Implement**

`engine-service/src/readiness/doctor.ts` — the `DoctorCheck` type and
`parseDoctor(stdout: string): ReadinessSnapshot`. It must tolerate a
non-JSON payload (returns a snapshot with `reaVersion: null` and no checks,
never throws) and must not read a top-level `version`.

`engine-service/src/readiness/snapshot.ts` — `loadSnapshot()` spawns
`rea capabilities --json` and `rea doctor --json` through `execFile` with a
30 s timeout each, parses both, and caches the merged snapshot for
`config.snapshotTtlMs`. **The engine's `doctor` exits 1 when required checks
fail, so the exit code is not the success signal** — a non-zero exit with
parseable stdout is a valid snapshot.

`engine-service/src/registry/availability.ts` — `computeAvailability()`.

The rule, stated exactly:

- if any requirement's `check` is missing from the snapshot's checks, or is
  present with `ok: false` → the operation is `unavailable`, and `missing`
  lists each unmet requirement with REA's `detail` and `remediation`;
- else if the operation's provider group reports `unsupported_host` →
  `unsupported_host`;
- else → `available`.

- [ ] **Step 4: Capture the two fixtures**

Run, in a scratch directory where `rea-agents@6.7.0` is installed:

```
node <rea>/scripts/rea.mjs capabilities --json > engine-service/fixtures/rea-capabilities.json
node <rea>/scripts/rea.mjs doctor --json > engine-service/fixtures/rea-doctor.json
```

Both must be valid JSON. `doctor` exits 1 on this machine (Ghidra, Hopper,
IDA, JADX and Kuna are all absent) — that is expected and the fixture is
still valid.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd engine-service; npx tsx tests/availability.test.ts`
Expected: `ALL PASS`.

- [ ] **Step 6: Commit**

```bash
git add engine-service/src/readiness engine-service/src/registry/availability.ts engine-service/tests/availability.test.ts engine-service/fixtures
git commit -m "feat(engine): disponibilidade calculada a partir do relatorio do REA"
```

---

### Task 4: The analysis runner and the progress parser

**Files:**
- Create: `engine-service/src/analysis/store.ts`, `engine-service/src/analysis/progress.ts`, `engine-service/src/analysis/runner.ts`
- Create: `engine-service/fixtures/rea-progress-stream.txt`
- Test: `engine-service/tests/progress.test.ts`, `engine-service/tests/runner.test.ts`

**Interfaces:**
- Consumes: `loadConfig()` (Task 1), `getOperation()` (Task 2).
- Produces:
  - `type ProgressEvent = { phase: string; completed: number; total: number | null; message: string; sequence: number | null }`
  - `parseProgressChunk(chunk: string): ProgressEvent | null` — parses one line of REA's stderr JSONL. Returns `null` for a line that is not a `rea_progress` object, and never throws.
  - `type AnalysisStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'partial'`
  - `type Analysis = { id: string; operationId: string; status: AnalysisStatus; progress: ProgressEvent | null; result: unknown; limitations: string[]; error: string | null; truncated: boolean; createdAt: number; finishedAt: number | null }`
  - `startAnalysis(input: { operationId: string; artifactPath: string; timeoutMs: number }): { analysisId: string }` — starts the analysis and returns immediately.
  - `getAnalysis(id: string): Analysis | undefined`
  - `cancelAnalysis(id: string): boolean` — SIGTERMs the child; returns `false` when the analysis is not running.

- [ ] **Step 1: Write the failing test**

`engine-service/tests/progress.test.ts` asserts, against the committed
fixture `engine-service/fixtures/rea-progress-stream.txt` (the raw stderr of
a real `analyze-javascript-application` run):

- every line that parses yields a `ProgressEvent` with a non-empty `phase`
  and a `message`;
- at least one event has `total > 0` and `completed <= total`;
- a line of ordinary text yields `null` and does not throw;
- a line of malformed JSON yields `null` and does not throw;
- an empty string yields `null`.

`engine-service/tests/runner.test.ts` asserts, with a **fake** REA
executable (a small script written to a temp file by the test, chosen by an
environment variable the runner reads):

- a run whose child exits 0 with a JSON payload on stdout → status
  `completed`, `result` is the parsed payload;
- a run whose child exits 1 → status `failed`, `error` is a non-empty
  sanitised string;
- a run whose child is killed by a signal → status `failed`, `error`
  mentions the signal;
- a run whose stdout exceeds `maxStdoutBytes` → status `partial` and
  `truncated` is `true`;
- a run that exceeds `timeoutMs` → status `failed`, `error` is `TIMEOUT`;
- `cancelAnalysis()` on a running analysis → the child receives SIGTERM and
  the analysis ends `cancelled`;
- `cancelAnalysis()` on a finished analysis → returns `false`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine-service; npx tsx tests/progress.test.ts && npx tsx tests/runner.test.ts`
Expected: FAIL — `Cannot find module '../src/analysis/progress'`.

- [ ] **Step 3: Implement**

`engine-service/src/analysis/progress.ts` — `parseProgressChunk()` reads one
line, JSON-parses it, and returns the `rea_progress` object when present
and well-formed. **The stream is not documented by REA**, so the parser is
defensive: an absent, malformed or differently-shaped line yields `null`,
never a wrong number.

`engine-service/src/analysis/store.ts` — an in-memory `Map<string, Analysis>`
plus the map of running children.

`engine-service/src/analysis/runner.ts` — `startAnalysis()` spawns the
engine command for the operation with `execFile` and an **argv array, never
a shell**, with `timeout`, `killSignal: 'SIGTERM'` and
`maxBuffer: config.maxStdoutBytes`; it pipes stderr through
`parseProgressChunk` and keeps the latest event. The argv for
`javascript_electron` is `['analyze-javascript-application', <dir>, '--json']`;
for `go_binary` it is `['inspect-go-binary', <file>, '--json']`; for
`rust_binary` it is `['inspect-rust-binary', <file>, '--json']`.

- [ ] **Step 4: Capture the progress fixture**

Run a real analysis against a small sample application and keep its stderr:

```
node <rea>/scripts/rea.mjs analyze-javascript-application <sample-app-dir> --json 2> engine-service/fixtures/rea-progress-stream.txt
```

The fixture must contain at least ten `rea_progress` lines.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd engine-service; npx tsx tests/progress.test.ts && npx tsx tests/runner.test.ts`
Expected: `ALL PASS` twice.

- [ ] **Step 6: Commit**

```bash
git add engine-service/src/analysis engine-service/tests/progress.test.ts engine-service/tests/runner.test.ts engine-service/fixtures/rea-progress-stream.txt
git commit -m "feat(engine): runner de analises com progresso real do REA"
```

---

### Task 5: The extractors

**Files:**
- Create: `engine-service/src/analysis/extract/types.ts`, `engine-service/src/analysis/extract/jsApplication.ts`, `engine-service/src/analysis/extract/goBinary.ts`, `engine-service/src/analysis/extract/rustBinary.ts`, `engine-service/src/analysis/extract/index.ts`
- Create: `engine-service/fixtures/rea-js-output.json`, `engine-service/fixtures/rea-go-output.json`, `engine-service/fixtures/rea-rust-output.json`
- Create: `engine-service/scripts/build-fixtures.mjs`
- Test: `engine-service/tests/extract.test.ts`

**Interfaces:**
- Consumes: `Operation` (Task 2).
- Produces:
  - `type ExtractedFinding = { kind: string; title: string; detail: string; evidence: string; limitation: string | null }`
  - `type Extracted = { summary: Record<string, number | string | null>; findings: ExtractedFinding[]; limitations: string[] }`
  - `extract(operationId: string, envelope: unknown): Extracted` — reads the REA **Evidence envelope** and returns the bounded payload the API stores. The envelope's domain object is at `normalized_result` for all three operations (confirmed against REA's own schemas: `goBinarySchema`, `rustBinarySchema`, and the measured JavaScript output).

- [ ] **Step 1: Write the failing test**

`engine-service/tests/extract.test.ts` asserts against the three committed
fixtures:

- `extract('javascript_electron', jsFixture)` returns a summary containing
  `parsed_javascript_files`, `modules`, `context_bridge_apis` and
  `ipc_main_handlers`, taken from `normalized_result.statistics` and
  `normalized_result.summary` — **not** from a top-level `module_count`;
- `extract('go_binary', goFixture)` returns a summary with `go_version` from
  `normalized_result.build_info.go_version` and `dependency_count` from
  `normalized_result.build_info.module.dependencies.length`;
- `extract('rust_binary', rustFixture)` returns a summary with `package_count`
  from `normalized_result.auditable_metadata.packages.length`;
- every extractor's `limitations` array equals the envelope's top-level
  `limitations` verbatim;
- **a malformed envelope yields `{ summary: {}, findings: [], limitations: [] }`
  and does not throw** — the Review Focus case 3;
- an envelope with an unknown field shape yields zero findings rather than a
  fabricated count;
- every finding has a non-empty `kind`, `title`, `detail` and `evidence`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine-service; npx tsx tests/extract.test.ts`
Expected: FAIL — `Cannot find module '../src/analysis/extract'`.

- [ ] **Step 3: Implement the extractors**

`engine-service/src/analysis/extract/types.ts` — the two types above.

`engine-service/src/analysis/extract/jsApplication.ts` — reads
`normalized_result.statistics` and `normalized_result.summary` and produces
one finding per meaningful count. The field names are the ones measured in
the fixture; the exact list is in the spec's §8.1.

`engine-service/src/analysis/extract/goBinary.ts` — reads
`normalized_result.build_info`. The shape comes from REA's own zod schema
(`src/domain/go/goBinary.ts`): `build_info.go_version`,
`build_info.module.path`, `build_info.module.main`,
`build_info.module.dependencies[]`, `build_info.module.settings[]`,
`build_info.module.complete`, `build_info.module.unparsed_lines[]`.

`engine-service/src/analysis/extract/rustBinary.ts` — reads
`normalized_result.auditable_metadata` and `normalized_result.rustc_commit`.
The shape comes from REA's own zod schema (`src/domain/rust/rustBinary.ts`):
`auditable_metadata.packages[]` (`name`, `version`, `source`, `kind`,
`dependencies[]`, `root`), `auditable_metadata.root_package_index`,
`auditable_metadata.dependency_edges[]`, `auditable_metadata.cyclic_dependency_indices[]`,
`rustc_commit.hashes[]`.

`engine-service/src/analysis/extract/index.ts` — dispatches on the operation
id and returns the empty extraction for an unknown id.

- [ ] **Step 4: Build the fixtures**

`engine-service/scripts/build-fixtures.mjs`:

- builds the JavaScript sample application in a temp directory (a
  `package.json`, a `main.js` that calls `ipcMain.handle`, a `preload.js`
  that calls `contextBridge.exposeInMainWorld`, and a `renderer/` folder),
  runs `analyze-javascript-application` on it, and writes
  `fixtures/rea-js-output.json`;
- builds the Go fixture using REA's own recipe (from
  `scripts/verify-go-binary.mjs` in the REA repository): a `go.mod` with
  `module example.test/rea-go-fixture`, a local `replace` dependency, and
  `go build -trimpath -buildvcs=false -ldflags="-s -w"`; runs
  `inspect-go-binary` on the result and writes `fixtures/rea-go-output.json`;
- builds the Rust fixture with the **cargo-auditable** format, so the
  `.dep-v0` section exists at all — a plain `cargo build` produces a binary
  REA reports as "null metadata", not as an empty dependency list. REA's
  `docs/rust-binaries.md` documents the requirement; the `cargo-auditable`
  tool is the producer. Runs `inspect-rust-binary` on the result and writes
  `fixtures/rea-rust-output.json`.

The Go and Rust toolchains are required for the second and third fixtures.
On Windows they install without virtualisation: Go is a zip
(`https://go.dev/dl/go1.23.4.windows-amd64.zip`, extract and put `go\bin`
on PATH) and Rust is `rustup-init.exe`. **If a toolchain is unavailable, that
fixture is not captured and the corresponding extractor is not written** —
the plan does not proceed to a guessed shape. REA's own zod schemas
(`src/domain/go/goBinary.ts`, `src/domain/rust/rustBinary.ts`) are the
fallback reference for the field names, and the captured fixture is the
authority when it exists.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd engine-service; npx tsx tests/extract.test.ts`
Expected: `ALL PASS`.

- [ ] **Step 6: Commit**

```bash
git add engine-service/src/analysis/extract engine-service/scripts engine-service/tests/extract.test.ts engine-service/fixtures
git commit -m "feat(engine): extracao de findings a partir da saida real do REA"
```

---

### Task 6: The engine's HTTP surface

**Files:**
- Create: `engine-service/src/routes/capabilities.ts`, `engine-service/src/routes/operations.ts`, `engine-service/src/routes/analyses.ts`
- Modify: `engine-service/src/app.ts`
- Test: `engine-service/tests/analyses.test.ts`

**Interfaces:**
- Consumes: `loadSnapshot()`, `computeAvailability()` (Task 3);
  `startAnalysis()`, `getAnalysis()`, `cancelAnalysis()` (Task 4);
  `extract()` (Task 5); `OPERATIONS` (Task 2).
- Produces:
  - `GET /capabilities` → `{ reaVersion, capturedAt, checks, operations: Array<Operation & { availability }> }`
  - `GET /operations` → `{ operations: Array<Operation & { availability }> }`
  - `POST /analyses` → `202` `{ analysis_id }`; the operation id comes from the
    `X-Engine-Operation` header, the raw artifact bytes are the body, the
    deadline comes from `X-Engine-Timeout-Ms`.
  - `GET /analyses/:id` → `200` `{ status, progress, phase, message, result, limitations, error, truncated, duration_ms }`
  - `POST /analyses/:id/cancel` → `202` `{ cancelled: boolean }`
  - `DELETE /analyses/:id` → `204`
  - `POST /analyses` answers `429` with `{"error":"engine_busy"}` when another
    analysis is running, and `403` with `{"error":"operation_refused"}` when
    the operation's effect is not `static`.
  - `POST /analyses` answers `413` when the body exceeds
    `config.maxArtifactBytes`.
  - The artifact arrives as **one file**. When the operation needs a tree —
    the JavaScript operation does — the engine unpacks it with REA's own
    `extract-artifact` command and hands the extracted directory to the
    analysis command. The API's one-file upload contract does not change.

- [ ] **Step 1: Write the failing test**

`engine-service/tests/analyses.test.ts` boots the app on port 0 with a fake
REA executable and asserts:

- without `X-Engine-Secret`, every route answers `401`;
- `GET /operations` answers `200` and its `operations` array has 24 entries,
  each with an `availability.state` of `available`, `unavailable` or
  `unsupported_host`;
- `POST /analyses` for a `static` operation answers `202` with an
  `analysis_id`;
- `POST /analyses` for an operation whose effect is `executes-target` answers
  `403` with `{"error":"operation_refused"}` — **the safety boundary**;
- `POST /analyses` while another analysis is running answers `429` with
  `{"error":"engine_busy"}` — the Review Focus case 4;
- `POST /analyses` with a body larger than `config.maxArtifactBytes` answers
  `413`;
- `GET /analyses/:id` for an unknown id answers `404`;
- `GET /analyses/:id` for a finished analysis answers `200` with
  `status: 'completed'` and a `result` carrying the extracted summary and
  the limitations;
- `POST /analyses/:id/cancel` for an unknown id answers `404`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine-service; npx tsx tests/analyses.test.ts`
Expected: FAIL — the routes are not mounted.

- [ ] **Step 3: Implement the routes**

`engine-service/src/routes/analyses.ts` mounts a **raw** body parser
(`express.raw({ type: 'application/octet-stream', limit: config.maxArtifactBytes })`)
for `POST /analyses`, and the JSON parser everywhere else.

`POST /analyses`:

1. resolve the operation; unknown → `404`;
2. `operation.effect !== 'static'` → `403`;
3. an analysis is already running → `429`;
4. the body is larger than `config.maxArtifactBytes` → `413`;
5. write the body to a temp file;
6. **if the operation needs a tree, unpack the file** with REA's own
   `extract-artifact` command into a temp directory and pass that directory
   to the analysis command; otherwise pass the file itself;
7. call `startAnalysis()` and answer `202`.

The unpack is the engine's job, not the API's: the API's upload contract is
one file (`routes/cyberlab.ts:98-104`), and REA's JavaScript analysis takes
an extracted directory or an ASAR. REA's own `extract-artifact` does the
unpacking safely and is the command the engine already has.

`GET /analyses/:id` returns the analysis with the extracted payload: when
the analysis finished, `result` is the `Extracted` from Task 5 and
`limitations` is the extractor's limitations.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine-service; npx tsx tests/analyses.test.ts`
Expected: `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add engine-service/src/routes engine-service/src/app.ts engine-service/tests/analyses.test.ts
git commit -m "feat(engine): superficie HTTP do servico de motor"
```

---

### Task 7: The API's engine client

**Files:**
- Create: `backend-api/src/services/seefast/engineClient.ts`
- Test: `backend-api/tests/engineClient.test.ts`

**Interfaces:**
- Consumes: `redactSensitiveText` (Task 1's copy, already in
  `backend-api/src/utils/helpers.ts`), `safeCompare` (already in
  `backend-api/src/utils/helpers.ts`).
- Produces:
  - `type EngineClientOptions = { baseUrl: string; secret: string; timeoutMs: number }`
  - `class EngineClient { constructor(options: EngineClientOptions); capabilities(): Promise<EngineCapabilities>; operations(): Promise<EngineOperations>; startAnalysis(input: { operationId: string; artifactPath: string; timeoutMs: number }): Promise<{ analysisId: string }>; getAnalysis(id: string): Promise<EngineAnalysis>; cancelAnalysis(id: string): Promise<boolean> }`
  - `type EngineError = { status: number; code: string; message: string }` — thrown
    as an `Error` carrying `status` and `code` properties.

- [ ] **Step 1: Write the failing test**

`backend-api/tests/engineClient.test.ts` starts a local HTTP server that
answers the engine's routes, and asserts:

- every request carries the `X-Engine-Secret` header;
- `capabilities()` returns the parsed body;
- a `429` from the engine throws an error with `status === 429` and
  `code === 'engine_busy'`;
- a `403` throws with `code === 'operation_refused'`;
- a `401` throws with `status === 401` and a message that does **not** contain
  the secret;
- `startAnalysis()` sends the operation id in `X-Engine-Operation` and the
  deadline in `X-Engine-Timeout-Ms`;
- a non-JSON body yields an error whose message is the sanitised body, with
  no URL and no credential.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-api; npx tsx tests/engineClient.test.ts`
Expected: FAIL — `Cannot find module '../src/services/seefast/engineClient'`.

- [ ] **Step 3: Implement the client**

`backend-api/src/services/seefast/engineClient.ts` uses Node's built-in
`fetch` (the API already uses it in `src/services/opencode.ts`), with
`AbortSignal.timeout(options.timeoutMs)`. The engine's address comes from
`ENGINE_URL` and the secret from `ENGINE_SECRET`; both are read at call
time, not at import time, so a test can change them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-api; npx tsx tests/engineClient.test.ts`
Expected: `ALL PASS`.

- [ ] **Step 5: Register the test in the suite**

Add `tsx tests/engineClient.test.ts` to the `test` script in
`backend-api/package.json`, after `tsx tests/reportsCsv.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add backend-api/src/services/seefast/engineClient.ts backend-api/tests/engineClient.test.ts backend-api/package.json
git commit -m "feat(cyberlab): cliente HTTP do servico de motor"
```

---

### Task 8: The API's capability probe

**Files:**
- Modify: `backend-api/src/services/seefast/capabilities.ts`
- Modify: `admin-dashboard/src/pages/cyberlab/CyberLabOverview.tsx` (the
  `ProviderStatus` type at lines 15-20 gains the new `reason` value and the
  `operationsAvailable` field)
- Modify: `admin-dashboard/src/pages/cyberlab/CyberLabIntegrations.tsx` (the
  same type, at lines 8-13)
- Test: `backend-api/tests/cyberlabSeefastCore.test.ts` (extend)

**Interfaces:**
- Consumes: `EngineClient` (Task 7).
- Produces: the existing `ProviderStatus`, extended with
  `reason: 'not_configured' | 'probe_failed' | 'unavailable' | null` and
  `operationsAvailable: number | null`.

- [ ] **Step 1: Write the failing test**

Extend `backend-api/tests/cyberlabSeefastCore.test.ts` with:

- `probeCapabilities()` with `ENGINE_URL` unset → `{ available: false, reason: 'not_configured', version: null }` and **no request is made**;
- with `ENGINE_URL` set but the engine unreachable → `{ available: false, reason: 'probe_failed', version: null, detail: <the engine's error> }`;
- with the engine answering `401` → `reason: 'probe_failed'`, and the detail
  does not contain the secret;
- with the engine answering `200` → `{ available: true, reason: null, version: '6.7.0' }` — the version read from `server_identity.server.version` or `identity.cli_package_version`, **not** from a top-level `version`;
- with the engine answering `200` but reporting that no operation is
  available → `available: true` with `operationsAvailable: 0` (the engine
  itself is fine; its providers are missing).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-api; npx tsx tests/cyberlabSeefastCore.test.ts`
Expected: FAIL — the current probe spawns a local binary and never asks the
engine.

- [ ] **Step 3: Implement**

Rewrite `probeCapabilities()` to use the `EngineClient`. **Remove**
`isRunnablePath` (lines 48-57) and the `child_process` import (line 1), and
correct `extractVersion` (lines 26-37) to read the version from the
engine's payload rather than a top-level `version`.

The dashboard's two `ProviderStatus` types must accept the new `reason`
value `'unavailable'` and the new `operationsAvailable` field, or the
TypeScript build fails.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-api; npx tsx tests/cyberlabSeefastCore.test.ts`
Expected: `ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add backend-api/src/services/seefast/capabilities.ts backend-api/tests/cyberlabSeefastCore.test.ts
git commit -m "feat(cyberlab): a sonda do motor passa a perguntar ao servico"
```

---

### Task 9: The API's runner

**Files:**
- Modify: `backend-api/src/services/seefast/adapter.ts`, `backend-api/src/services/seefast/jobsRunner.ts`
- Delete: `backend-api/src/services/seefast/normalize.ts`
- Test: `backend-api/tests/cyberlabJobs.test.ts` (extend)

**Interfaces:**
- Consumes: `EngineClient` (Task 7), `probeCapabilities` (Task 8).
- Produces:
  - `adapter.ts` keeps `JOB_OPS` (the three-operation allowlist, unchanged)
    and exports `startRemoteAnalysis(operationId: string, artifactPath: string, timeoutMs: number): Promise<{ analysisId: string }>`.
  - `jobsRunner.ts` keeps `createJob`, `cancelJob`, `promoteQueued` and
    `recoverInterruptedJobs`, and their signatures are unchanged.

- [ ] **Step 1: Write the failing test**

Extend `backend-api/tests/cyberlabJobs.test.ts` with:

- a job whose engine call returns `429` → the job stays `queued`, no row
  becomes `running`, and the queue is promoted later — the Review Focus
  case 4;
- a job whose engine call fails with a network error → the job ends
  `failed` with a non-empty error, and the **queue is not wedged**: the next
  queued job is promoted — the Review Focus case 5;
- a job that is cancelled → the API calls the engine's cancel endpoint and
  the job ends `cancelled`;
- a job whose engine reports `timeout` → the job ends `failed` with the
  error `TIMEOUT`;
- a job whose engine reports `truncated` → the job ends `partial`;
- a job whose engine reports `completed` → the job ends `completed` and
  `result` carries the engine's extracted summary and limitations.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-api; npx tsx tests/cyberlabJobs.test.ts`
Expected: FAIL — the runner still spawns a local child.

- [ ] **Step 3: Implement**

`adapter.ts`: remove the `child_process` import (line 1) and `runOperation`
(lines 74-103) and `toRawRun` (lines 39-71). Keep `JOB_OPS` (lines 14-18)
and add `startRemoteAnalysis()`.

`jobsRunner.ts`: replace the `runningProcesses` map (lines 78-79) with a map
of `analysisId` per job; replace the `execFile` monkey-patch in `startRun`
(lines 101-130) with the engine call; replace the `child.kill('SIGTERM')` in
`cancelJob` (line 358) with `engineClient.cancelAnalysis()`; replace
`mapRunToOutcome` (lines 142-153) with a mapping of the engine's status
vocabulary onto the existing outcome vocabulary.

**The `429` path must not fail the job.** A busy engine leaves the job
`queued`; the promotion path retries it.

**The finalisation must not wedge the queue.** Today a failed finalisation
is swallowed (lines 207-212) and the row stays `running` for ever. The
finalisation is now retried once and, on a second failure, the row is failed
explicitly so the slot is released.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-api; npx tsx tests/cyberlabJobs.test.ts`
Expected: `ALL PASS`.

- [ ] **Step 5: Delete the old normaliser and the local provisioning hook**

Delete `backend-api/src/services/seefast/normalize.ts`,
`backend-api/docker/install-engine.cjs` and `backend-api/tests/engineInstall.test.ts`.
Remove the `SEEFAST_ENGINE_PKG`, `SEEFAST_ENGINE_PKG_SHA256` and
`SEEFAST_CLI` entries from `render.yaml` (lines 64-76) and from
`backend-api/Dockerfile` (the `ENTRYPOINT` wrapper on line 31 becomes
`CMD ["./node_modules/.bin/tsx", "src/index.ts"]`).

The `engineInstall` test must also be removed from the `test` script in
`backend-api/package.json`.

- [ ] **Step 6: Run the whole backend suite**

Run: `cd backend-api; npm test`
Expected: every file passes. `tests/authSession.test.ts` needs a live
PostgreSQL and is covered by CI.

- [ ] **Step 7: Commit**

```bash
git add backend-api/src/services/seefast backend-api/docker backend-api/tests backend-api/package.json backend-api/Dockerfile render.yaml
git commit -m "refactor(cyberlab): o motor passa a ser um servico remoto"
```

---

### Task 10: Progress, end to end

**Files:**
- Modify: `backend-api/src/config/database.ts`, `backend-api/src/services/seefast/jobsRunner.ts`
- Modify: `admin-dashboard/src/pages/cyberlab/CyberLabJobDetail.tsx`
- Test: `backend-api/tests/cyberlabJobs.test.ts` (extend)

**Interfaces:**
- Consumes: the engine's `progress` event (Task 4).
- Produces:
  - `cyberlab_jobs.progress_detail JSONB` — `{ phase, completed, total, message, sequence } | null`.
  - `publicJob()` (in `backend-api/src/routes/cyberlab.ts:165-179`) gains
    `progress_detail`.

- [ ] **Step 1: Write the failing test**

Extend `backend-api/tests/cyberlabJobs.test.ts` with:

- while a job runs, the API writes the engine's latest progress event into
  `progress_detail`, and `progress` becomes the phase's fraction
  (`round(completed / total * 100)`) when `total > 0`;
- when the event has no `total`, `progress` stays `0` (which the public
  payload reports as `null` — "not measured") and `progress_detail` still
  carries the phase and the message;
- a finished job's `progress_detail` keeps the last event it saw.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-api; npx tsx tests/cyberlabJobs.test.ts`
Expected: FAIL — nothing writes `progress_detail`.

- [ ] **Step 3: Implement**

`backend-api/src/config/database.ts` — add the column to the
`CREATE TABLE IF NOT EXISTS cyberlab_jobs` block (after line 1240) and
append the idempotent migration to the same bootstrap:

```sql
ALTER TABLE cyberlab_jobs ADD COLUMN IF NOT EXISTS progress_detail JSONB;
```

The bootstrap already runs on every boot and is already idempotent; this is
the repository's first `ALTER TABLE` and it follows the same rule.

`backend-api/src/services/seefast/jobsRunner.ts` — while the job is running,
the API polls the engine's analysis and writes the latest progress event.

`backend-api/src/routes/cyberlab.ts` — `publicJob()` returns
`progress_detail: row.progress_detail ?? null`.

`admin-dashboard/src/pages/cyberlab/CyberLabJobDetail.tsx` — render the
phase and the message, and the fraction only when the phase has a total.
The existing "Progress: 0%" block (lines 244-248) must not render when
`progress` is `null`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-api; npx tsx tests/cyberlabJobs.test.ts` and
`npm --prefix admin-dashboard run build`
Expected: `ALL PASS` and a clean build.

- [ ] **Step 5: Commit**

```bash
git add backend-api/src/config/database.ts backend-api/src/routes/cyberlab.ts backend-api/src/services/seefast/jobsRunner.ts backend-api/tests/cyberlabJobs.test.ts admin-dashboard/src/pages/cyberlab/CyberLabJobDetail.tsx
git commit -m "feat(cyberlab): progresso real do motor, do REA ao painel"
```

---

### Task 11: Evidence availability

**Files:**
- Modify: `backend-api/src/routes/cyberlab.ts`, `backend-api/src/services/seefast/jobsRunner.ts`
- Modify: `admin-dashboard/src/pages/cyberlab/CyberLabEvidence.tsx` (the
  `Artifact` type at lines 11-20 gains `available: boolean`)
- Test: `backend-api/tests/cyberlabArtifacts.test.ts`, `backend-api/tests/cyberlabJobs.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `GET /artifacts` rows gain `available: boolean` — computed per request
    with `fs.stat`, **not** a stored column.
  - The job outcome vocabulary is unchanged; a missing evidence file yields
    `status: 'failed'` with `error: 'EVIDENCE_UNAVAILABLE'`.

- [ ] **Step 1: Write the failing test**

Extend `backend-api/tests/cyberlabArtifacts.test.ts` with:

- an artifact whose file exists → `available: true`;
- an artifact whose file is absent → `available: false`;
- the artifacts payload never contains a path that the API did not already
  expose (`storage_path` stays out).

Extend `backend-api/tests/cyberlabJobs.test.ts` with:

- a job whose artifact file is absent → the job ends `failed` with
  `error: 'EVIDENCE_UNAVAILABLE'` — the Review Focus case 2.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend-api; npx tsx tests/cyberlabArtifacts.test.ts && npx tsx tests/cyberlabJobs.test.ts`
Expected: FAIL — `available` is absent and the job fails with the wrong error.

- [ ] **Step 3: Implement**

`backend-api/src/routes/cyberlab.ts` — the artifacts list query (lines
139-152) already selects the rows; add an `fs.stat` per row and set
`available`.

`backend-api/src/services/seefast/jobsRunner.ts` — the missing-artifact
branch (lines 236-240) fails the job with `EVIDENCE_UNAVAILABLE` instead of
the generic message.

`admin-dashboard/src/pages/cyberlab/CyberLabEvidence.tsx` — the `Artifact`
type gains `available: boolean`, and the row shows the evidence is
unavailable when it is `false`, instead of offering a link to a job that
cannot run.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend-api; npx tsx tests/cyberlabArtifacts.test.ts && npx tsx tests/cyberlabJobs.test.ts`
Expected: `ALL PASS` twice.

- [ ] **Step 5: Commit**

```bash
git add backend-api/src/routes/cyberlab.ts backend-api/src/services/seefast/jobsRunner.ts backend-api/tests
git commit -m "fix(cyberlab): a evidencia ausente diz que a evidencia desapareceu"
```

---

### Task 12: The operation catalogue in the panel

**Files:**
- Modify: `admin-dashboard/src/pages/cyberlab/CyberLabIntegrations.tsx`
- Modify: `admin-dashboard/src/i18n/index.tsx`
- Modify: `backend-api/src/routes/cyberlab.ts` (the `providers` response gains
  the operation catalogue)
- Test: the Playwright script in `%TEMP%\opencode\verify_honesty.py` (extend
  with a check for the catalogue)

**Interfaces:**
- Consumes: the engine's `GET /operations` (Task 6), relayed by
  `GET /api/cyberlab/providers`.
- Produces: `GET /api/cyberlab/providers` gains
  `operations: Array<{ id, label, target, state, missing: Array<{ name, detail, remediation }> }>`.
  The **panel owns the wording**: the API relays the engine's `id`,
  `availability.state` and `missing` entries, and the dashboard maps the id
  to its own i18n label.

- [ ] **Step 1: Write the failing check**

Extend the Playwright script with a check that `/cyberlab/integrations` shows
the 24 operations, each with its state, and that an unavailable operation
shows the engine's remediation text.

- [ ] **Step 2: Run it to verify it fails**

Run: `python %TEMP%\opencode\verify_honesty.py`
Expected: FAIL — the catalogue is not rendered.

- [ ] **Step 3: Implement**

`backend-api/src/routes/cyberlab.ts` — the providers route adds the
operations array.

`admin-dashboard/src/pages/cyberlab/CyberLabIntegrations.tsx` — render the
catalogue: one row per operation with its label, its state badge, and the
missing requirement's name and remediation.

`admin-dashboard/src/i18n/index.tsx` — add the labels for the 24 operation
ids in **both** dictionaries, and the strings for the three states. The
parity check (every key present in PT and in EN) must hold.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm --prefix admin-dashboard run build` then
`python %TEMP%\opencode\verify_honesty.py`
Expected: a clean build and the check passing.

- [ ] **Step 5: Commit**

```bash
git add admin-dashboard/src backend-api/src/routes/cyberlab.ts
git commit -m "feat(cyberlab): o catalogo de operacoes do motor no painel"
```

---

### Task 13: The panel shows the engine's truth

**Files:**
- Modify: `admin-dashboard/src/pages/cyberlab/CyberLabJobDetail.tsx`, `admin-dashboard/src/pages/cyberlab/CyberLabFindings.tsx`
- Modify: `admin-dashboard/src/i18n/index.tsx`

**Interfaces:**
- Consumes: `progress_detail` and the extracted `limitations` (Tasks 9, 10).
- Produces: the job detail shows the engine's limitations next to the
  result; the findings view groups by `kind` instead of by `severity`.

- [ ] **Step 1: Write the failing check**

Extend the Playwright script with a check that a job detail with
`limitations` shows them, and that the findings view is grouped by kind.

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

`CyberLabJobDetail.tsx` — render the limitations, each as a sentence the
engine wrote. **They are not warnings to be styled away: they are the
boundary of what the analysis established.**

`CyberLabFindings.tsx` — replace the severity grouping with a kind
grouping. The findings carry no severity of their own (spec C8).

`i18n/index.tsx` — the new strings, in both dictionaries.

- [ ] **Step 4: Run it to verify it passes**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add admin-dashboard/src
git commit -m "feat(cyberlab): o painel mostra as limitacoes que o motor declarou"
```

---

### Task 14: Deployment

**Files:**
- Modify: `render.yaml`, `docker-compose.yml`, `docs/deployment.md`,
  `docs/cyberlab.md`, `docs/RENDER-DEPLOY.md`

**Interfaces:**
- Consumes: the engine service (Tasks 1-6).
- Produces: the `endpointx-engine` service and the wiring.

- [ ] **Step 1: Write the blueprint**

In `render.yaml`, add the engine service and pin the regions:

```yaml
  - type: pserv
    name: endpointx-engine
    runtime: docker
    region: oregon
    plan: 1c-2g
    dockerfilePath: ./engine-service/Dockerfile
    envVars:
      - key: PORT
        value: "10000"
      - key: ENGINE_SECRET
        generateValue: true
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

In the `endpointx-api` service, add `region: oregon` and:

```yaml
      - key: ENGINE_URL
        fromService:
          name: endpointx-engine
          type: pserv
          property: hostport
      - key: ENGINE_SECRET
        fromService:
          name: endpointx-engine
          type: pserv
          envVarKey: ENGINE_SECRET
```

**`type: pserv`, not `type: private`** — the blueprint validator rejects
`private`. **`healthCheckPath` is not set on the engine** — that field is
web services only, and a private service has no Render health check.

- [ ] **Step 2: Validate the blueprint**

Run: `render blueprint validate render.yaml` (the Render CLI) or POST the
file to `https://api.render.com/v1/blueprints/validate` with the API key.
Expected: `valid: true`.

- [ ] **Step 3: Add the engine to the compose file**

In `docker-compose.yml`, add a service built from
`engine-service/Dockerfile`, publishing `10000:10000`, with
`ENGINE_SECRET` shared with the `backend` service through an environment
variable, and give `backend` an `ENGINE_URL` pointing at it.

- [ ] **Step 4: Fix the deployment documentation's drift**

`docs/deployment.md:125-198` quotes a compose file whose service names do
not match the real `docker-compose.yml` (`backend` and `frontend`), and
references a `docker-compose.prod.yml` that does not exist. Correct it, and
add the engine service to the self-hosted instructions.

`docs/cyberlab.md` — replace the `SEEFAST_*` provisioning section with the
engine service's description, and add the operation catalogue's contract.

`docs/RENDER-DEPLOY.md` — add the engine service's steps and the `$25/month`
plan.

- [ ] **Step 5: Commit**

```bash
git add render.yaml docker-compose.yml docs
git commit -m "feat(deploy): servico de motor no Render e no compose"
```

---

### Task 15: CI

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `engine-service/scripts/verify-fixtures.mjs`

**Interfaces:**
- Consumes: the engine service (Task 5's fixtures).
- Produces: a second CI job, `engine`, that runs the engine's own tests
  against the real REA, and verifies the committed fixtures still match.

- [ ] **Step 1: Write the fixture verification script**

`engine-service/scripts/verify-fixtures.mjs` rebuilds the Go and Rust
fixture binaries, re-runs REA against them, and compares the result with the
committed fixture on the fields the extractor reads. It exits non-zero when
they differ.

- [ ] **Step 2: Add the CI job**

```yaml
  engine:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: engine-service
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: actions/setup-go@v5
        with:
          go-version: '1.23'
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
      - run: npm test
      - run: node scripts/verify-fixtures.mjs
```

The `backend` job keeps its `postgres:16` service: `tests/authSession.test.ts`
needs a real database.

- [ ] **Step 3: Run the engine's suite locally**

Run: `cd engine-service; npm test`
Expected: every file passes.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml engine-service/scripts
git commit -m "ci(engine): job do servico de motor com as toolchains do REA"
```

---

## Execution order and dependencies

```
Task 1  (engine skeleton)
   ↓
Task 2  (registry) ──→ Task 3 (readiness) ──┐
   ↓                                        │
Task 4  (runner + progress) ─────────────────┤
   ↓                                        ↓
Task 5  (extractors) ─────────────────→ Task 6 (engine HTTP)
                                              ↓
                                     Task 7  (API engine client)
                                              ↓
                                     Task 8  (API probe)
                                              ↓
                                     Task 9  (API runner)
                                              ↓
                       Task 10 (progress) ─┬→ Task 12 (catalogue)
                       Task 11 (evidence) ┘→ Task 13 (panel truth)
                                              ↓
                                     Task 14 (deployment)
                                     Task 15 (CI)
```

Tasks 2, 3, 4 and 5 are independent of each other and can be done in
parallel once Task 1 is in place. Task 6 needs 3, 4 and 5. Everything from
Task 7 on needs Task 6.

## Verification before the branch is merged

Run all of these and record the output:

```bash
cd backend-api && npm test          # every file passes
cd engine-service && npm test       # every file passes
npm --prefix admin-dashboard run build
```

Then, against the **deployed** services:

- `GET https://endpointx-api-5ypc.onrender.com/health` answers `200`;
- `GET /api/cyberlab/providers` (authenticated) reports the engine's version
  and a non-zero count of available operations;
- the dashboard's bundle contains the catalogue's i18n strings;
- a job created against the live engine produces a finding and a limitation.

The panel checks run with the Playwright scripts in `%TEMP%\opencode\` —
`verify_navigation.py`, `verify_motion.py`, `verify_honesty.py` — plus the
new catalogue check from Task 12.

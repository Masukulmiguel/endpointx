/**
 * Generic engine provisioning hook.
 *
 * A production host may need an external analysis engine that is not part of
 * this image. The operator supplies it as a package (an HTTP(S) URL or a
 * path already on the host) through the SEEFAST_ENGINE_PKG environment
 * variable, and names the location the engine must occupy through
 * SEEFAST_CLI. This hook fetches the package and puts it there, silently,
 * before the API starts.
 *
 * The rules that make it safe to run unattended:
 *
 *  - Nothing configured -> nothing happens. The service boots exactly as it
 *    did before the hook existed, and the subsystem reports "not configured".
 *  - The package is never executed by this script. It is written to disk and
 *    made executable; the API runs it later, under its own allowlist.
 *  - The write is atomic (exclusive temporary file + rename), so an
 *    interrupted boot can never leave a half-written binary at the target
 *    path, and two writers can never share a temporary name.
 *  - The target is left alone only when it is a non-empty executable file.
 *    Anything else is replaced.
 *  - An optional SHA-256 pins the bytes. A mismatch installs nothing, and
 *    without it the log says the bytes were not verified.
 *  - A failure is reported and swallowed: a host whose engine cannot be
 *    provisioned must still serve the rest of the API.
 *
 * Nothing here names or identifies the engine — the hook is deliberately
 * generic, and the package's origin and name stay with the operator.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/** Reasons returned when nothing was installed. */
const NOT_CONFIGURED = 'not_configured';
const NO_TARGET = 'no_target';
const ALREADY_PRESENT = 'already_present';
const INSTALLED = 'installed';

/** A remote package larger than this is refused: the boot must not OOM. */
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

/** A download that stalls longer than this is abandoned. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

const isHttpUrl = (value) => /^https?:\/\//i.test(value);
const isHttpsUrl = (value) => /^https:\/\//i.test(value);
/** Loopback: the package comes from the host itself, not from the network. */
const isLoopbackUrl = (value) =>
  /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(value);

/** A 64-character hex digest. Anything else is a configuration mistake. */
const isSha256 = (value) => /^[0-9a-f]{64}$/i.test(value.trim());

/**
 * Whether a file at the target path is a usable engine.
 *
 * On POSIX a file must carry an execute bit. Windows has no execute bit —
 * executability there follows from the extension — so a non-empty file
 * counts. The hook itself runs on Linux in the container; the Windows
 * branch exists so the behaviour is the same under test.
 *
 * @param {fs.Stats} stats
 * @returns {boolean}
 */
function isUsableEngine(stats) {
  if (!stats.isFile() || stats.size === 0) return false;
  if (process.platform === 'win32') return true;
  return (stats.mode & 0o111) !== 0;
}

/**
 * Reduce an error to a message that cannot carry the operator's package
 * specification. A package URL may embed a signed token in its query
 * string, and Node's own error messages quote the URL verbatim.
 *
 * @param {unknown} error
 * @returns {string}
 */
function safeReason(error) {
  const raw = error && error.message ? String(error.message) : 'unknown error';
  // Drop anything that looks like a URL or a path with a scheme.
  const cleaned = raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<redacted>')
    .replace(/\b\S*\?\S*/g, '<redacted>')
    .slice(0, 200);
  return cleaned || 'unknown error';
}

/**
 * Fetch the package bytes.
 *
 * @param {string} pkg package URL or local path
 * @param {typeof fetch} fetchImpl injectable for tests
 * @returns {Promise<Buffer>}
 */
async function readPackage(pkg, fetchImpl) {
  if (isHttpUrl(pkg)) {
    const doFetch = fetchImpl || fetch;
    const response = await doFetch(pkg, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!response.ok) {
      throw new Error(`package download failed with status ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_PACKAGE_BYTES) {
      throw new Error('package is larger than the allowed size');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error('package download returned an empty body');
    }
    if (buffer.length > MAX_PACKAGE_BYTES) {
      throw new Error('package is larger than the allowed size');
    }
    return buffer;
  }

  // A path already on the host (a mounted volume, a pre-baked file).
  const data = await fsp.readFile(pkg);
  if (data.length === 0) {
    throw new Error('package file is empty');
  }
  return data;
}

/**
 * Write the bytes to the target path, atomically, and make it executable.
 *
 * @param {string} target absolute path of the engine binary
 * @param {Buffer} data package bytes
 */
async function writeTarget(target, data) {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true });

  // Same directory as the target, so the rename is atomic (same filesystem).
  // A random suffix plus the exclusive flag means two writers never share a
  // name and an existing path (a symlink, say) is never followed.
  const temporary = path.join(
    dir,
    `.${path.basename(target)}.install-${process.pid}-${crypto.randomUUID()}`
  );
  try {
    const handle = await fsp.open(temporary, 'wx', 0o755);
    try {
      await handle.writeFile(data);
      // Flush before the rename: a host crash right after the rename must not
      // be able to leave an empty file at the target.
      await handle.sync();
    } finally {
      await handle.close();
    }
    // writeFile only applies the mode when it creates the file; force it.
    await fsp.chmod(temporary, 0o755);
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Install the engine package at the target path.
 *
 * @param {object} options
 * @param {string} [options.pkg] package URL or local path
 * @param {string} [options.cli] absolute path the engine must occupy
 * @param {string} [options.sha256] expected SHA-256 of the package, in hex
 * @param {typeof fetch} [options.fetchImpl] injectable for tests
 * @param {(message: string) => void} [options.log] boot log sink
 * @returns {Promise<{installed: boolean, reason: string}>}
 */
async function installEngine(options) {
  const { pkg, cli, sha256, fetchImpl, log } = options || {};
  const say = typeof log === 'function' ? log : () => undefined;

  const packageSpec = (pkg || '').trim();
  const target = (cli || '').trim();

  if (!packageSpec) {
    return { installed: false, reason: NOT_CONFIGURED };
  }
  if (!target) {
    return { installed: false, reason: NO_TARGET };
  }
  if (!path.isAbsolute(target)) {
    // A relative path would be resolved against the process working
    // directory, which is not what the operator means.
    throw new Error('target path must be absolute');
  }

  const expected = (sha256 || '').trim();
  if (expected && !isSha256(expected)) {
    throw new Error('expected checksum is not a sha-256 digest');
  }

  // A remote package over plain http is only acceptable when the bytes are
  // pinned: otherwise anyone on the path could replace the binary the API
  // is about to execute. A package served by the host itself (loopback) is
  // not on the network and needs no pinning.
  if (
    isHttpUrl(packageSpec) &&
    !isHttpsUrl(packageSpec) &&
    !isLoopbackUrl(packageSpec) &&
    !expected
  ) {
    throw new Error('a remote package over plain http requires a checksum');
  }

  // Idempotence: a usable engine is left alone, so a restart never
  // re-downloads and never risks replacing a working engine. A file that is
  // empty, or that is not executable, is replaced.
  try {
    const stats = await fsp.stat(target);
    if (isUsableEngine(stats)) {
      return { installed: false, reason: ALREADY_PRESENT };
    }
  } catch {
    // Not there yet — the normal path.
  }

  const data = await readPackage(packageSpec, fetchImpl);

  if (expected) {
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    if (actual !== expected.toLowerCase()) {
      throw new Error('package checksum mismatch');
    }
  } else {
    say('package bytes are not verified (no checksum configured)');
  }

  await writeTarget(target, data);
  return { installed: true, reason: INSTALLED };
}

/**
 * Boot entry point. Never fails the boot: a provisioning problem is
 * reported and the service continues without an engine.
 */
async function main() {
  const pkg = process.env.SEEFAST_ENGINE_PKG || '';
  const cli = process.env.SEEFAST_CLI || '';
  const sha256 = process.env.SEEFAST_ENGINE_PKG_SHA256 || '';

  if (!pkg.trim() || !cli.trim()) {
    return 0;
  }

  try {
    const result = await installEngine({
      pkg,
      cli,
      sha256,
      log: (message) => console.log(`[engine-provision] ${message}`),
    });
    if (result.installed) {
      console.log('[engine-provision] engine package provisioned');
    }
  } catch (error) {
    // The service must still come up: the subsystem reports that the engine
    // is not available, and the rest of the API is unaffected.
    console.error(`[engine-provision] engine package not provisioned: ${safeReason(error)}`);
  }
  return 0;
}

module.exports = { installEngine, main, safeReason, NOT_CONFIGURED, NO_TARGET, ALREADY_PRESENT, INSTALLED };

if (require.main === module) {
  main().then(
    (code) => {
      // process.exitCode lets the process drain its streams before ending.
      process.exitCode = code;
    },
    (error) => {
      console.error(`[engine-provision] unexpected failure: ${safeReason(error)}`);
      process.exitCode = 0;
    }
  );
}

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
 *  - The write is atomic (temporary file + rename), so an interrupted boot
 *    can never leave a half-written binary at the target path.
 *  - An optional SHA-256 pins the bytes. A mismatch installs nothing.
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
const os = require('os');
const path = require('path');

/** Reasons returned when nothing was installed. */
const NOT_CONFIGURED = 'not_configured';
const NO_TARGET = 'no_target';
const ALREADY_PRESENT = 'already_present';
const INSTALLED = 'installed';

const isHttpUrl = (value) => /^https?:\/\//i.test(value);

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
    const response = await doFetch(pkg);
    if (!response.ok) {
      throw new Error(`package download failed with status ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error('package download returned an empty body');
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
  const temporary = path.join(dir, `.${path.basename(target)}.install-${process.pid}`);
  try {
    await fsp.writeFile(temporary, data, { mode: 0o755 });
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

  // Idempotence: a present, executable engine is left alone, so a restart
  // never re-downloads and never risks replacing a working engine.
  try {
    const stats = await fsp.stat(target);
    if (stats.isFile() && stats.size > 0) {
      return { installed: false, reason: ALREADY_PRESENT };
    }
  } catch {
    // Not there yet — the normal path.
  }

  const data = await readPackage(packageSpec, fetchImpl);

  const expected = (sha256 || '').trim().toLowerCase();
  if (expected) {
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    if (actual !== expected) {
      throw new Error('package checksum mismatch');
    }
  }

  await writeTarget(target, data);
  say(`engine package installed at the configured path`);
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
    // The service must still come up: Cyber Lab reports "not configured"
    // and the rest of the API is unaffected.
    console.error(`[engine-provision] engine package not provisioned: ${error.message}`);
  }
  return 0;
}

module.exports = { installEngine, main, NOT_CONFIGURED, NO_TARGET, ALREADY_PRESENT, INSTALLED };

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[engine-provision] unexpected failure: ${error.message}`);
      process.exit(0);
    }
  );
}

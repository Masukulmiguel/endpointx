/**
 * RED->GREEN gate for Task 13 — the generic engine provisioning hook.
 *
 * The hook is the only thing that puts an external engine binary on a
 * production host. It must therefore be boring and auditable:
 *
 *  - No environment variable -> nothing happens, the service boots exactly as
 *    it did before. That is the behaviour every other deployment depends on.
 *  - The package is fetched over HTTP(S) and written atomically to the path
 *    named by SEEFAST_CLI, never executed by this script.
 *  - An optional SHA-256 pins the bytes; a mismatch installs nothing.
 *  - Any failure is reported, never thrown at the boot: a host whose engine
 *    cannot be provisioned must still serve the rest of the API, with Cyber
 *    Lab honestly reporting "not configured".
 *
 * Run: npx tsx tests/engineInstall.test.ts
 */
import './testEnv';
import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const HOOK = path.join(__dirname, '..', 'docker', 'install-engine.cjs');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { installEngine } = require(HOOK) as {
  installEngine: (options: {
    pkg?: string;
    cli?: string;
    sha256?: string;
    fetchImpl?: typeof fetch;
    log?: (message: string) => void;
  }) => Promise<{ installed: boolean; reason: string }>;
};

let failed = 0;
const checkAsync = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${(error as Error).message}`);
  }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-install-'));

/** Serve fixed bytes over HTTP and count the requests. */
const startServer = async (body: Buffer, status = 200): Promise<{ url: string; requests: number; close: () => void }> => {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    if (status !== 200) {
      res.writeHead(status).end('nope');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/engine.bin`,
    requests: () => state.requests,
    close: () => server.close(),
  } as never;
};

const sha256 = (data: Buffer): string => crypto.createHash('sha256').update(data).digest('hex');

async function main(): Promise<void> {
  const payload = Buffer.from('#!/bin/sh\necho engine\n');

  // ---- (a) no package configured -> nothing happens ----------------------
  await checkAsync('test_no_package_configured_installs_nothing', async () => {
    const target = path.join(tmpRoot, 'a', 'engine');
    const result = await installEngine({ pkg: '', cli: target });
    assert.strictEqual(result.installed, false, 'nothing may be installed without a package');
    assert.strictEqual(result.reason, 'not_configured');
    assert.strictEqual(fs.existsSync(target), false, 'no file may be created');
  });

  // ---- (b) package but no target path -> nothing happens ------------------
  await checkAsync('test_no_target_path_installs_nothing', async () => {
    const server = await startServer(payload);
    try {
      const result = await installEngine({ pkg: server.url, cli: '' });
      assert.strictEqual(result.installed, false);
      assert.strictEqual(result.reason, 'no_target');
      assert.strictEqual(server.requests(), 0, 'the package must not even be fetched');
    } finally {
      server.close();
    }
  });

  // ---- (c) the package is fetched and written atomically ----------------
  await checkAsync('test_package_is_downloaded_to_the_target_path', async () => {
    const server = await startServer(payload);
    const target = path.join(tmpRoot, 'c', 'engine');
    try {
      const result = await installEngine({ pkg: server.url, cli: target });
      assert.strictEqual(result.installed, true, 'the engine must be installed');
      assert.strictEqual(result.reason, 'installed');
      assert.ok(fs.existsSync(target), 'the target file must exist');
      assert.deepStrictEqual(fs.readFileSync(target), payload, 'the bytes must match the package');
      if (process.platform !== 'win32') {
        const mode = fs.statSync(target).mode & 0o777;
        assert.ok(mode & 0o111, `the target must be executable, mode was ${mode.toString(8)}`);
      }
    } finally {
      server.close();
    }
  });

  // ---- (d) already present -> idempotent, no second download ------------
  await checkAsync('test_already_present_is_idempotent', async () => {
    const server = await startServer(payload);
    const target = path.join(tmpRoot, 'd', 'engine');
    try {
      await installEngine({ pkg: server.url, cli: target });
      const before = server.requests();
      const second = await installEngine({ pkg: server.url, cli: target });
      assert.strictEqual(second.installed, false, 'a present engine must not be reinstalled');
      assert.strictEqual(second.reason, 'already_present');
      assert.strictEqual(server.requests(), before, 'no second download may happen');
    } finally {
      server.close();
    }
  });

  // ---- (e) checksum mismatch -> nothing is written -----------------------
  await checkAsync('test_checksum_mismatch_installs_nothing', async () => {
    const server = await startServer(payload);
    const target = path.join(tmpRoot, 'e', 'engine');
    try {
      let threw = false;
      try {
        await installEngine({ pkg: server.url, cli: target, sha256: sha256(Buffer.from('other')) });
      } catch {
        threw = true;
      }
      assert.ok(threw, 'a checksum mismatch must be an error');
      assert.strictEqual(fs.existsSync(target), false, 'a mismatching package must not be written');
    } finally {
      server.close();
    }
  });

  // ---- (f) a matching checksum installs ----------------------------------
  await checkAsync('test_matching_checksum_installs', async () => {
    const server = await startServer(payload);
    const target = path.join(tmpRoot, 'f', 'engine');
    try {
      const result = await installEngine({ pkg: server.url, cli: target, sha256: sha256(payload) });
      assert.strictEqual(result.installed, true);
      assert.deepStrictEqual(fs.readFileSync(target), payload);
    } finally {
      server.close();
    }
  });

  // ---- (g) a failed download installs nothing ---------------------------
  await checkAsync('test_failed_download_installs_nothing', async () => {
    const server = await startServer(payload, 404);
    const target = path.join(tmpRoot, 'g', 'engine');
    try {
      let threw = false;
      try {
        await installEngine({ pkg: server.url, cli: target });
      } catch {
        threw = true;
      }
      assert.ok(threw, 'a failed download must be an error');
      assert.strictEqual(fs.existsSync(target), false, 'a failed download must not be written');
    } finally {
      server.close();
    }
  });

  // ---- (h) a local path is copied ---------------------------------------
  await checkAsync('test_local_package_path_is_copied', async () => {
    const source = path.join(tmpRoot, 'source-engine');
    fs.writeFileSync(source, payload);
    const target = path.join(tmpRoot, 'h', 'engine');
    const result = await installEngine({ pkg: source, cli: target });
    assert.strictEqual(result.installed, true);
    assert.deepStrictEqual(fs.readFileSync(target), payload);
  });

  // ---- (i) the boot must never be blocked by a failed install -----------
  await checkAsync('test_boot_hook_exits_zero_even_when_the_install_fails', async () => {
    const target = path.join(tmpRoot, 'i', 'engine');
    const result = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SEEFAST_ENGINE_PKG: 'http://127.0.0.1:1/does-not-exist',
        SEEFAST_CLI: target,
        SEEFAST_ENGINE_PKG_SHA256: '',
      },
    });
    assert.strictEqual(result.status, 0, 'the boot hook must exit 0 even when the install fails');
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(
      /engine/i.test(output),
      `the failure must be reported in the boot log, got: ${JSON.stringify(output)}`
    );
    assert.strictEqual(fs.existsSync(target), false, 'a failed install must not leave a file behind');
  });

  // ---- (j) the boot hook with nothing configured is silent and harmless -
  await checkAsync('test_boot_hook_with_nothing_configured_exits_zero', async () => {
    const result = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SEEFAST_ENGINE_PKG: '',
        SEEFAST_CLI: '',
        SEEFAST_ENGINE_PKG_SHA256: '',
      },
    });
    assert.strictEqual(result.status, 0, 'the boot hook must exit 0');
    assert.strictEqual(
      `${result.stdout}${result.stderr}`.trim(),
      '',
      'with nothing configured the hook must say nothing on either stream'
    );
  });

  // ---- (k) the write is atomic: the target is never a partial file -------
  await checkAsync('test_target_is_never_partially_written', async () => {
    const server = await startServer(payload);
    const target = path.join(tmpRoot, 'k', 'engine');
    try {
      await installEngine({ pkg: server.url, cli: target });
      // Whatever is at the target must be the complete package — never a
      // truncated or empty file.
      const written = fs.readFileSync(target);
      assert.deepStrictEqual(written, payload, 'the target must hold the complete package');
    } finally {
      server.close();
    }
  });

  // ---- (k2) a target that is not usable is replaced wholesale ------------
  await checkAsync('test_unusable_target_is_replaced_wholesale', async () => {
    const server = await startServer(payload);
    const target = path.join(tmpRoot, 'k2', 'engine');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // An empty file at the target is not a usable engine.
    fs.writeFileSync(target, '');
    try {
      const result = await installEngine({ pkg: server.url, cli: target });
      assert.strictEqual(result.installed, true, 'an empty target must be replaced');
      assert.deepStrictEqual(
        fs.readFileSync(target),
        payload,
        'the target must be replaced wholesale, never appended to'
      );
    } finally {
      server.close();
    }
  });

  // ---- (k3) a target that exists but is not executable is replaced -------
  await checkAsync('test_non_executable_target_is_replaced', async () => {
    if (process.platform === 'win32') return; // no execute bit on Windows
    const server = await startServer(payload);
    const target = path.join(tmpRoot, 'k3', 'engine');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, payload, { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    try {
      const result = await installEngine({ pkg: server.url, cli: target });
      assert.strictEqual(result.installed, true, 'a non-executable target must be replaced');
      const mode = fs.statSync(target).mode & 0o777;
      assert.strictEqual(mode, 0o755, `the replacement must be executable, got ${mode.toString(8)}`);
    } finally {
      server.close();
    }
  });

  // ---- (l) a failed install leaves no temporary file behind --------------
  await checkAsync('test_failed_install_leaves_no_temporary_file', async () => {
    const server = await startServer(payload, 500);
    const dir = path.join(tmpRoot, 'l');
    const target = path.join(dir, 'engine');
    try {
      await installEngine({ pkg: server.url, cli: target }).catch(() => undefined);
      const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      assert.deepStrictEqual(
        leftovers,
        [],
        `no temporary file may survive a failed install, found: ${leftovers.join(', ')}`
      );
    } finally {
      server.close();
    }
  });

  // ---- (m) the installed file is executable even under a strict umask ----
  await checkAsync('test_installed_file_is_executable_under_a_strict_umask', async () => {
    if (process.platform === 'win32') {
      // Windows has no execute bit; the CI job (ubuntu) covers this.
      return;
    }
    const server = await startServer(payload);
    const target = path.join(tmpRoot, 'm', 'engine');
    const previous = process.umask(0o077);
    try {
      await installEngine({ pkg: server.url, cli: target });
      const mode = fs.statSync(target).mode & 0o777;
      assert.strictEqual(mode, 0o755, `the file must be 0755, got ${mode.toString(8)}`);
    } finally {
      process.umask(previous);
      server.close();
    }
  });

  // ---- (n) the checksum comparison is case-insensitive -------------------
  await checkAsync('test_checksum_is_compared_case_insensitively', async () => {
    const server = await startServer(payload);
    const target = path.join(tmpRoot, 'n', 'engine');
    try {
      const result = await installEngine({
        pkg: server.url,
        cli: target,
        sha256: sha256(payload).toUpperCase(),
      });
      assert.strictEqual(result.installed, true, 'an uppercase digest must still match');
    } finally {
      server.close();
    }
  });

  // ---- (o) the hook never executes the package ---------------------------
  await checkAsync('test_hook_never_executes_the_package', async () => {
    const source = fs.readFileSync(HOOK, 'utf8');
    // The hook writes the package; the API runs it later, under its own
    // allowlist. Anything that spawns a process here would break that
    // separation — and would be a remote-code-execution path.
    assert.ok(
      !/require\(['"]child_process['"]\)/.test(source),
      'the hook must not load child_process'
    );
    assert.ok(!/\bexecFileSync\b|\bspawnSync\b|\bexecSync\b/.test(source),
      'the hook must not spawn any process');
    assert.ok(!/\beval\s*\(/.test(source), 'the hook must not eval');
  });

  // ---- (p) the Dockerfile still starts the API after the hook ------------
  await checkAsync('test_dockerfile_runs_the_hook_and_then_the_api', async () => {
    const dockerfile = fs.readFileSync(
      path.join(__dirname, '..', 'Dockerfile'),
      'utf8'
    );
    const entrypoint = dockerfile.match(/^ENTRYPOINT\s+(.+)$/m);
    const cmd = dockerfile.match(/^CMD\s+(.+)$/m);
    assert.ok(entrypoint, 'the image must declare an ENTRYPOINT');
    assert.ok(cmd, 'the image must declare a CMD');

    // The shell escapes in the exec form arrive here as \" — compare
    // against the unescaped text.
    const entry = entrypoint[1].replace(/\\/g, '');

    // A plain ENTRYPOINT makes Docker APPEND the CMD's arguments to it, so
    // the hook would run instead of the API and the container would exit
    // before serving anything. The CMD must therefore be consumed by the
    // entrypoint.
    assert.ok(
      /exec\s+"\$@"/.test(entry),
      `the ENTRYPOINT must exec the CMD, got: ${entrypoint[1]}`
    );
    assert.ok(
      /install-engine\.cjs/.test(entry),
      `the ENTRYPOINT must run the provisioning hook, got: ${entrypoint[1]}`
    );
    // The API must start even when the hook fails, so the separator is ";"
    // and not "&&".
    assert.ok(
      /;\s*exec/.test(entry),
      `the API must start regardless of the hook outcome, got: ${entrypoint[1]}`
    );
  });

  // ---- (q) a remote package over plain http needs a checksum ------------
  await checkAsync('test_plain_http_package_requires_a_checksum', async () => {
    const server = await startServer(payload);
    const target = path.join(tmpRoot, 'q', 'engine');
    try {
      // A non-loopback plain http URL: the refusal must happen before any
      // request is made, so the host does not even have to resolve.
      let threw = false;
      try {
        await installEngine({ pkg: 'http://cdn.example.com/engine.bin', cli: target });
      } catch {
        threw = true;
      }
      assert.ok(threw, 'a plain http package without a checksum must be refused');
      assert.strictEqual(fs.existsSync(target), false, 'nothing may be written');

      // With a checksum the same package installs — here served from
      // loopback, which is on the host and not on the network.
      const ok = await installEngine({
        pkg: server.url,
        cli: target,
        sha256: sha256(payload),
      });
      assert.strictEqual(ok.installed, true, 'with a checksum the same package must install');
    } finally {
      server.close();
    }
  });

  // ---- (r) a package served by the host itself needs no pinning ---------
  await checkAsync('test_loopback_package_needs_no_checksum', async () => {
    const server = await startServer(payload);
    const target = path.join(tmpRoot, 'r2', 'engine');
    try {
      const result = await installEngine({ pkg: server.url, cli: target });
      assert.strictEqual(result.installed, true, 'a loopback package must install without a checksum');
    } finally {
      server.close();
    }
  });

  // ---- (r) a relative target path is refused ----------------------------
  await checkAsync('test_relative_target_path_is_refused', async () => {
    const server = await startServer(payload);
    try {
      let threw = false;
      try {
        await installEngine({ pkg: server.url, cli: 'relative/engine' });
      } catch {
        threw = true;
      }
      assert.ok(threw, 'a relative target path must be refused');
    } finally {
      server.close();
    }
  });

  // ---- (s) the failure reason never carries the package specification ---
  await checkAsync('test_failure_log_does_not_leak_the_package_spec', async () => {
    const secret = 'tok_ABCDEF0123456789';
    const result = spawnSync(process.execPath, [HOOK], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SEEFAST_ENGINE_PKG: `s3://bucket/engine.bin?token=${secret}`,
        SEEFAST_CLI: path.join(tmpRoot, 's', 'engine'),
        SEEFAST_ENGINE_PKG_SHA256: '',
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    assert.ok(
      !output.includes(secret),
      `the package specification must never reach the boot log: ${JSON.stringify(output)}`
    );
    assert.ok(
      /engine-provision/.test(output),
      `the failure must still be reported: ${JSON.stringify(output)}`
    );
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log(failed === 0 ? '\nALL PASS\n' : `\n${failed} test(s) FAILED\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * RED->GREEN gate for Task 3: Network Discovery v1.2.3 backend schema,
 * netsentinel_enabled flag default, and the network_discovery command type.
 *
 * Design notes: same FakePool harness as tests/networkStats.test.ts - a stubbed
 * pg.Pool installed in require.cache before config/database loads, then
 * initDatabase() run against it with capturing on so every statement of the
 * inline schema + seed passes through record().
 * Run: npx tsx tests/networkDiscovery.test.ts
 */
import './testEnv';
import assert from 'assert';

let failed = 0;
const check = (label: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}`);
    console.error(`      ${(error as Error).message}`);
  }
};

// ---- Fake pg (installed before config/database is first required) --------
let capturing = false;
const calls: Array<{ sql: string; params: unknown[] }> = [];

const respond = (sql: string) =>
  sql.includes('FROM permissions')
    ? { rows: [{ code: 'network.view' }, { code: 'devices.view' }], rowCount: 2 }
    : { rows: [], rowCount: 0 };

const record = (sql: string, params?: unknown[]) => {
  if (capturing) calls.push({ sql, params: params ?? [] });
  return respond(sql);
};

class FakeClient {
  query(sql: string, params?: unknown[]) {
    return Promise.resolve(record(sql, params));
  }
  release(): void {
    /* noop */
  }
}

class FakePool {
  constructor(_cfg: unknown) {}
  query(sql: string, params?: unknown[]) {
    return Promise.resolve(record(sql, params));
  }
  connect(): Promise<FakeClient> {
    return Promise.resolve(new FakeClient());
  }
  on(): this {
    return this;
  }
  end(): Promise<void> {
    return Promise.resolve();
  }
}

const pgPath = require.resolve('pg');
const realPg = require(pgPath) as Record<string, unknown>;
require.cache[pgPath]!.exports = { ...realPg, Pool: FakePool };

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { initDatabase } = require('../src/config/database') as {
  initDatabase: () => Promise<void>;
};

async function main(): Promise<void> {
  capturing = true;
  await initDatabase();
  capturing = false;

  const statements = calls.map((c) => c.sql);

  check('test_inline_schema_adds_network_nodes_columns', () => {
    const createdBy = statements.filter((s) =>
      /ALTER TABLE network_nodes[\s\S]*ADD COLUMN IF NOT EXISTS created_by/.test(s)
    );
    assert.strictEqual(
      createdBy.length,
      1,
      `expected exactly 1 statement with the network_nodes created_by ALTER, got ${createdBy.length}`
    );
    assert.ok(
      statements.some((s) => /ALTER TABLE network_nodes\s+ADD COLUMN IF NOT EXISTS review_status/.test(s)),
      'missing ALTER TABLE network_nodes ADD COLUMN IF NOT EXISTS review_status'
    );
    assert.ok(
      statements.some((s) => /ALTER TABLE network_nodes\s+ADD COLUMN IF NOT EXISTS enrollment_requested_at/.test(s)),
      'missing ALTER TABLE network_nodes ADD COLUMN IF NOT EXISTS enrollment_requested_at'
    );
    assert.ok(
      statements.some((s) => s.includes('CREATE INDEX IF NOT EXISTS idx_network_nodes_created_by ON network_nodes(created_by)')),
      'missing idx_network_nodes_created_by index'
    );
    assert.ok(
      statements.some((s) => s.includes('CREATE INDEX IF NOT EXISTS idx_network_nodes_review_status ON network_nodes(review_status)')),
      'missing idx_network_nodes_review_status index'
    );
  });

  check('test_flag_default_flip_is_idempotent', () => {
    const flagStatements = statements.filter((s) => s.includes('netsentinel_enabled'));
    assert.strictEqual(
      flagStatements.length,
      1,
      `netsentinel_enabled must be seeded by exactly one statement (no duplicate seed row insert), got ${flagStatements.length}`
    );
    const upsert = flagStatements[0];
    assert.ok(upsert.includes('INSERT INTO app_settings'), 'expected an app_settings insert');
    assert.ok(
      upsert.includes('ON CONFLICT (key) DO UPDATE'),
      'expected an upsert so the flip is idempotent across boots'
    );
    assert.ok(
      /'netsentinel_enabled'\s*,\s*'true'/.test(upsert),
      "flag must default to 'true'"
    );
    assert.ok(
      upsert.includes("WHERE app_settings.value = 'false'"),
      "must only flip legacy 'false' rows - never downgrade an explicit 'true'"
    );
  });

  const { ALLOWED_COMMAND_TYPES } = await import('../src/routes/commands');
  check('test_commands_allowlist_contains_network_discovery', () => {
    assert.ok(Array.isArray(ALLOWED_COMMAND_TYPES), 'commands.ts must export ALLOWED_COMMAND_TYPES');
    assert.ok(
      ALLOWED_COMMAND_TYPES.includes('network_discovery'),
      `network_discovery missing from allowlist: ${JSON.stringify(ALLOWED_COMMAND_TYPES)}`
    );
  });

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

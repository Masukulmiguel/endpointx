/**
 * RED->GREEN gate for the outgoing-webhook URL safety check (SSRF guard).
 * Run: npx tsx tests/webhookUrl.test.ts
 * Exit code 0 = every assertion held, 1 = at least one failed.
 */
import { checkWebhookUrlSyntax } from '../src/utils/webhookUrl';

const NODE_ENV = process.env.NODE_ENV;

const cases: Array<[string, string, boolean]> = [
  ['https slack', 'https://hooks.slack.com/services/T00/B00/XXXX', true],
  ['https discord', 'https://discord.com/api/webhooks/1/abc', true],
  ['http plain', 'http://example.com/hooks/1', true],
  ['custom port', 'https://example.com:8443/hooks/1', true],

  ['ftp rejected', 'ftp://example.com/x', false],
  ['file rejected', 'file:///etc/passwd', false],
  ['gopher rejected', 'gopher://example.com/x', false],
  ['javascript rejected', 'javascript:alert(1)', false],
  ['credentials in url rejected', 'https://user:pass@example.com/x', false],
  ['empty string rejected', '', false],
  ['not a url rejected', 'not a url', false],
  ['undefined rejected', undefined as unknown as string, false],

  ['localhost rejected', 'http://localhost:8080/x', false],
  ['localhost suffix rejected', 'http://api.localhost/x', false],
  ['.local host rejected', 'http://printer.local/x', false],
  ['.internal host rejected', 'http://metadata.google.internal/x', false],
  ['instance-data rejected', 'http://instance-data/x', false],

  ['loopback 127.0.0.1 rejected', 'http://127.0.0.1/x', false],
  ['loopback 127.0.0.55 rejected', 'http://127.0.0.55:9200/_cat/indices', false],
  ['private 10.x rejected', 'http://10.0.0.1/x', false],
  ['private 172.16 rejected', 'http://172.16.0.1/x', false],
  ['private 172.31 rejected', 'http://172.31.255.255/x', false],
  ['private 192.168 rejected', 'http://192.168.1.1/x', false],
  ['cloud metadata rejected', 'http://169.254.169.254/latest/meta-data/', false],
  ['cgnat 100.64 rejected', 'http://100.64.0.1/x', false],
  ['multicast rejected', 'http://224.0.0.1/x', false],
  ['ipv6 loopback rejected', 'http://[::1]/x', false],
  ['ipv6 unique local rejected', 'http://[fd00::1]/x', false],
  ['ipv6 link local rejected', 'http://[fe80::1]/x', false],
  ['ipv6 mapped loopback rejected', 'http://[::ffff:127.0.0.1]/x', false],
  ['ipv6 mapped private rejected', 'http://[::ffff:192.168.0.1]/x', false],

  // 172.16-31 is private, but 172.32 is a normal public address.
  ['public 172.32 allowed', 'http://172.32.0.1/x', true],
];

let failed = 0;
const check = (label: string, raw: string, expected: boolean) => {
  let actual: unknown;
  try {
    actual = checkWebhookUrlSyntax(raw).ok;
  } catch (error) {
    actual = `threw: ${(error as Error).message}`;
  }
  if (actual !== expected) {
    failed += 1;
    console.error(`FAIL ${label}: url=${JSON.stringify(raw)} expected=${expected} got=${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
};

process.env.NODE_ENV = 'production';
for (const [label, raw, expected] of cases) {
  check(label, raw, expected);
}

// In local development a loopback receiver is a legitimate webhook target.
process.env.NODE_ENV = 'development';
check('dev: loopback allowed', 'http://127.0.0.1:4000/hook', true);
check('dev: private allowed', 'http://192.168.1.10/hook', true);
check('dev: metadata still rejected', 'http://169.254.169.254/latest/meta-data/', false);
check('dev: localhost still rejected', 'http://localhost:4000/hook', false);

if (NODE_ENV === undefined) {
  delete process.env.NODE_ENV;
} else {
  process.env.NODE_ENV = NODE_ENV;
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nPASS');

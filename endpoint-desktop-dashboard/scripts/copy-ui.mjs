/**
 * Copies the built dashboard SPA into the Electron app folder.
 * Fails loudly when admin-dashboard/dist is missing or stale-looking, so the
 * installer can never ship without a UI.
 */
import { cp, rm, stat, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const source = path.resolve(appRoot, '..', 'admin-dashboard', 'dist');
const target = path.join(appRoot, 'ui');

const fail = (message) => {
  console.error(`copy-ui: ${message}`);
  process.exit(1);
};

try {
  await access(path.join(source, 'index.html'));
} catch {
  fail(
    `dashboard build not found at ${source}\n` +
      'Run "npm run build" inside admin-dashboard/ first.'
  );
}

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });

const index = path.join(target, 'index.html');
const { size } = await stat(index);
if (size < 100) fail(`copied ${index} looks empty (${size} bytes)`);

if (!existsSync(path.join(target, 'assets'))) fail('copied ui/ has no assets folder');

console.log(`copy-ui: ${source} -> ${target}`);

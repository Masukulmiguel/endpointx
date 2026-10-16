import { defineConfig } from 'vite';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'scripts' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.html')) out.push(full);
  }
  return out;
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

export default defineConfig({
  appType: 'mpa',
  publicDir: 'public',
  build: {
    outDir: resolve(root, '..', 'backend-api', 'public', 'site'),
    emptyOutDir: true,
    sourcemap: false,
    assetsDir: 'assets',
    rollupOptions: {
      input: walk(root, []).map((f) => relative(root, f).split(sep).join('/')),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  define: {
    __SITE_VERSION__: JSON.stringify(pkg.version),
  },
});

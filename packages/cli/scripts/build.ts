// Bundles src/baton.ts into the one file the package publishes, dist/baton.mjs: no dependencies to install, so
// `npx @andrewchemis/baton-cli` starts at once in a bare session.
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
const out = join(root, 'dist', 'baton.mjs');
await build({
  entryPoints: [join(root, 'src', 'baton.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node' },
  define: { __BATON_VERSION__: JSON.stringify(version) },
  legalComments: 'none',
  logLevel: 'warning',
});
await chmod(out, 0o755);
console.log(`cli: dist/baton.mjs ${version}`);

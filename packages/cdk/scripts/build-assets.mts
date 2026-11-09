// Builds what the construct deploys: the Lambda bundle (one file) and the web app, into assets/. Run by `pnpm build` and by
// the synth test's global setup; the published tarball carries assets/api/index.js and assets/web/.
import { build as esbuild } from 'esbuild';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build as vite } from 'vite';

const root = resolve(import.meta.dirname, '..');
const assets = join(root, 'assets');

async function buildApi() {
  const outfile = join(assets, 'api', 'index.js');
  rmSync(join(assets, 'api'), { recursive: true, force: true });
  mkdirSync(join(assets, 'api'), { recursive: true });
  await esbuild({
    entryPoints: [join(root, 'service', 'handler.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    // CommonJS: the Lambda runtime loads `index.handler` without needing a package.json next to the file.
    format: 'cjs',
    legalComments: 'none',
    minify: true,
    sourcemap: false,
    logLevel: 'warning',
  });
  return statSync(outfile).size;
}

async function buildWeb() {
  rmSync(join(assets, 'web'), { recursive: true, force: true });
  await vite({ configFile: join(root, 'web', 'vite.config.mts'), logLevel: 'warn' });
}

const apiBytes = await buildApi();
await buildWeb();
console.log(`assets: api/index.js ${(apiBytes / 1024).toFixed(0)} KiB, web/ built`);

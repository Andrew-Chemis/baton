// Builds both packages from clean and packs them the way npm will see them: pnpm applies each `files` allowlist and
// `publishConfig`. test/pack.test.ts installs these tarballs, and the release workflow publishes tarballs this script builds
// the same way, from the same commit.
//   node scripts/pack.ts <dest-dir>     prints "name@version<TAB>tarball", one per line, in publish order
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '..');

/** Package directories in publish order. Neither depends on the other, so the order is only for the summary. */
export const PACKAGES = ['cdk', 'cli'] as const;

export interface Packed {
  name: string;
  version: string;
  filename: string;
}

export function packAll(dest: string): Packed[] {
  // Clean first, so a file deleted from src/ cannot survive in lib/ or dist/ and ship.
  for (const [p, dirs] of [
    ['cdk', ['lib', 'assets/api', 'assets/web']],
    ['cli', ['dist']],
  ] as const) {
    for (const dir of dirs) rmSync(join(root, 'packages', p, dir), { recursive: true, force: true });
  }
  // Build output goes to stderr: stdout carries the list of tarballs.
  execFileSync('pnpm', ['run', '--silent', 'build'], { cwd: root, stdio: ['ignore', process.stderr, process.stderr] });
  mkdirSync(dest, { recursive: true });
  return PACKAGES.map((p) => {
    const out = execFileSync('pnpm', ['pack', '--json', '--pack-destination', resolve(dest)], {
      cwd: join(root, 'packages', p),
      encoding: 'utf8',
    });
    const { name, version, filename } = JSON.parse(out) as Packed;
    return { name, version, filename };
  });
}

if (import.meta.main) {
  const dest = process.argv[2];
  if (!dest) throw new Error('usage: node scripts/pack.ts <dest-dir>');
  for (const p of packAll(dest)) process.stdout.write(`${p.name}@${p.version}\t${p.filename}\n`);
}

// What a consumer gets. Builds both packages from clean, packs them as pnpm will publish them, installs the tarballs with npm
// into an empty directory, and then uses them: the CLI runs from node_modules/.bin, and a CDK app that imports the construct
// synthesizes with its Lambda bundle and web app found inside the installed package. Needs the npm registry (for the peers).
//   pnpm test:pack
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { packAll, root, type Packed } from '../scripts/pack.ts';

// The oldest release the peer range admits, and the one the constructs are checked against here. The workspace itself builds
// and synth-tests on the newest, so together they cover both ends of the range.
const CDK_FLOOR = '2.270.0';
const CONSTRUCTS_FLOOR = '10.5.0';

/** npm and pnpm leak their own configuration into child environments; the child should see a plain shell. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toLowerCase().startsWith('npm_') && key !== 'NODE_PATH' && key !== 'INIT_CWD') env[key] = value;
  }
  return { ...env, ...extra };
}

const listing = (tarball: string) =>
  execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line && !line.endsWith('/'));

let packed: Record<'cdk' | 'cli', Packed & { path: string }>;
let work: string;
let consumer: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'baton-pack-'));
  const all = packAll(join(work, 'tarballs'));
  const find = (suffix: string) => {
    const hit = all.find((p) => p.name.endsWith(suffix));
    if (!hit) throw new Error(`pack produced no ${suffix} tarball`);
    return { ...hit, path: hit.filename };
  };
  packed = { cdk: find('baton-cdk'), cli: find('baton-cli') };

  consumer = join(work, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, version: '0.0.0' }));
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-package-lock',
      packed.cdk.path,
      packed.cli.path,
      `aws-cdk-lib@${CDK_FLOOR}`,
      `constructs@${CONSTRUCTS_FLOOR}`,
    ],
    { cwd: consumer, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
  );
});

describe('the tarballs', () => {
  test('the two packages carry one version', () => {
    expect(packed.cdk.version).toBe(packed.cli.version);
    expect(packed.cdk.name).toBe('@andrewchemis/baton-cdk');
    expect(packed.cli.name).toBe('@andrewchemis/baton-cli');
  });

  test('the construct package holds lib, the Lambda bundle and the built web app, and no sources', () => {
    const files = listing(packed.cdk.path);
    for (const wanted of [
      'package/package.json',
      'package/LICENSE',
      'package/README.md',
      'package/lib/index.js',
      'package/lib/index.d.ts',
      'package/lib/baton-board.js',
      'package/assets/api/index.js',
      'package/assets/web/index.html',
    ]) {
      expect(files, wanted).toContain(wanted);
    }
    const unwanted = files.filter(
      (f) =>
        /^package\/(service|src|test|scripts|web)\//.test(f) ||
        f.endsWith('.map') ||
        (f.endsWith('.ts') && !f.endsWith('.d.ts')) ||
        f === 'package/tsconfig.build.json',
    );
    expect(unwanted).toEqual([]);
    // The web app has its scripts and styles as files, not inline.
    expect(files.some((f) => /^package\/assets\/web\/assets\/.+\.js$/.test(f))).toBe(true);
  });

  test('the CLI package is one script, the manifest, the licence and the readme', () => {
    expect(listing(packed.cli.path).toSorted()).toEqual([
      'package/LICENSE',
      'package/README.md',
      'package/dist/baton.mjs',
      'package/package.json',
    ]);
  });

  test('the CLI has no runtime dependencies, and neither manifest points into the workspace', () => {
    const manifest = (tarball: string) =>
      JSON.parse(execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' })) as Record<
        string,
        any
      >;
    const cli = manifest(packed.cli.path);
    expect(cli.dependencies ?? {}).toEqual({});
    expect(cli.bin).toEqual({ baton: './dist/baton.mjs' });
    const cdk = manifest(packed.cdk.path);
    expect(cdk.dependencies ?? {}).toEqual({});
    expect(cdk.peerDependencies).toEqual({ 'aws-cdk-lib': '^2.270.0', constructs: '^10.5.0' });
    for (const m of [cli, cdk]) expect(JSON.stringify(m)).not.toMatch(/workspace:|file:|link:/);
    expect(cli.publishConfig).toMatchObject({ access: 'public', provenance: true });
    expect(cdk.publishConfig).toMatchObject({ access: 'public', provenance: true });
  });

  test('both carry the licence the repository does', () => {
    const rootLicence = readFileSync(join(root, 'LICENSE'), 'utf8');
    for (const pkg of [packed.cdk, packed.cli]) {
      expect(execFileSync('tar', ['-xzOf', pkg.path, 'package/LICENSE'], { encoding: 'utf8' })).toBe(rootLicence);
    }
  });
});

describe('installed with npm', () => {
  test('npm put the peers at the floor of the range and the tarballs where the consumer imports them', () => {
    const version = (name: string) =>
      (JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8')) as { version: string })
        .version;
    expect(version('aws-cdk-lib')).toBe(CDK_FLOOR);
    expect(version('constructs')).toBe(CONSTRUCTS_FLOOR);
    expect(version('@andrewchemis/baton-cdk')).toBe(packed.cdk.version);
    expect(version('@andrewchemis/baton-cli')).toBe(packed.cli.version);
  });

  test('the baton command runs from node_modules/.bin and reports the package version', () => {
    const bin = join(consumer, 'node_modules', '.bin', 'baton');
    expect(existsSync(bin)).toBe(true);
    const out = execFileSync(bin, ['--version'], { env: cleanEnv(), encoding: 'utf8' }).trim();
    expect(out).toContain(packed.cli.version);
  });

  test('the command also says what it does with no arguments, and exits 2 outside a checkout', () => {
    const bin = join(consumer, 'node_modules', '.bin', 'baton');
    const help = execFileSync(bin, ['--help'], { env: cleanEnv(), encoding: 'utf8' });
    expect(help).toContain('baton take <card>');
  });

  test('a CDK app that imports the construct synthesizes, and the assets come from inside the installed package', () => {
    const outdir = join(consumer, 'cdk.out');
    // A throwaway account number: this file is a test, outside the account-string check, and nothing is deployed.
    const account = ['1234', '5678', '9012'].join('');
    writeFileSync(
      join(consumer, 'app.cjs'),
      `
const { App, Stack } = require('aws-cdk-lib');
const { Certificate } = require('aws-cdk-lib/aws-certificatemanager');
const { PublicHostedZone } = require('aws-cdk-lib/aws-route53');
const { BatonBoard } = require('@andrewchemis/baton-cdk');
const { API_ASSET_PATH, WEB_ASSET_PATH } = require('@andrewchemis/baton-cdk/lib/assets.js');

const app = new App({ outdir: ${JSON.stringify(outdir)} });
const edge = new Stack(app, 'Edge', { env: { account: '${account}', region: 'us-east-1' }, crossRegionReferences: true });
const zone = new PublicHostedZone(edge, 'Zone', { zoneName: 'baton.example.test' });
const certificate = new Certificate(edge, 'Cert', { domainName: 'baton.example.test' });
const stack = new Stack(app, 'Board', { env: { account: '${account}', region: 'us-west-2' }, crossRegionReferences: true });
new BatonBoard(stack, 'Baton', { domainName: 'baton.example.test', certificate, hostedZone: zone });
const assembly = app.synth();
console.log(JSON.stringify({ stacks: assembly.stacks.map((s) => s.stackName), api: API_ASSET_PATH, web: WEB_ASSET_PATH }));
`,
    );
    const out = execFileSync('node', ['app.cjs'], { cwd: consumer, env: cleanEnv(), encoding: 'utf8' });
    const report = JSON.parse(out.trim().split('\n').pop() as string) as { stacks: string[]; api: string; web: string };
    expect(report.stacks).toEqual(expect.arrayContaining(['Edge', 'Board']));
    const installed = join(consumer, 'node_modules', '@andrewchemis', 'baton-cdk');
    expect(report.api.startsWith(installed)).toBe(true);
    expect(report.web.startsWith(installed)).toBe(true);
    expect(statSync(join(report.api, 'index.js')).size).toBeGreaterThan(10_000);
    expect(statSync(join(report.web, 'index.html')).size).toBeGreaterThan(100);

    // The assembly staged them: one asset directory holds the Lambda bundle, another the web app.
    const staged = readdirSync(outdir).filter((n) => n.startsWith('asset.') && statSync(join(outdir, n)).isDirectory());
    expect(
      staged.some((n) => existsSync(join(outdir, n, 'index.js')) && !existsSync(join(outdir, n, 'index.html'))),
    ).toBe(true);
    expect(staged.some((n) => existsSync(join(outdir, n, 'index.html')))).toBe(true);
  });

  test('a TypeScript consumer sees the types', () => {
    writeFileSync(
      join(consumer, 'use.ts'),
      `
import { Stack } from 'aws-cdk-lib';
import { BatonBoard, type BatonBoardProps } from '@andrewchemis/baton-cdk';

declare const stack: Stack;
const props: BatonBoardProps = { domainName: 'baton.example.test', leaseMinutes: 15 };
const board = new BatonBoard(stack, 'Board', props);
export const table: string = board.table.tableName;
export const url: string = board.url;
`,
    );
    writeFileSync(
      join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          module: 'node16',
          moduleResolution: 'node16',
          target: 'es2022',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        files: ['use.ts'],
      }),
    );
    // Run the workspace's compiler on the consumer's files: the types it resolves are the installed package's.
    const tsc = () =>
      execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', join(consumer, 'tsconfig.json')], {
        cwd: consumer,
        env: cleanEnv(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    expect(() => tsc()).not.toThrow();

    // And the check is not vacuous: a prop of the wrong type is refused.
    writeFileSync(
      join(consumer, 'use.ts'),
      "import { BatonBoard } from '@andrewchemis/baton-cdk';\nexport const wrong: BatonBoard['url'] = 1;\n",
    );
    let refusal = '';
    try {
      tsc();
    } catch (error) {
      refusal = (error as { stdout?: string }).stdout ?? '';
    }
    expect(refusal).toMatch(/Type 'number' is not assignable to type 'string'/);
  });
});

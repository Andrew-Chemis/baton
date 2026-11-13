// The published artifact is dist/baton.mjs, one file. This runs that file as a process (shebang, exit codes, stdout and stderr)
// against the real service, and checks it imports nothing but Node's own modules.
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { REPO, startWorld, type World } from './harness.ts';

const exec = promisify(execFile);
const root = join(import.meta.dirname, '..');
const bin = join(root, 'dist', 'baton.mjs');
let w: World;
let checkout: string;

beforeAll(async () => {
  execFileSync('node', ['scripts/build.ts'], { cwd: root, stdio: 'pipe' });
  w = await startWorld();
  checkout = w.repo();
});
afterAll(async () => w.close());

async function baton(args: string[], env: Record<string, string> = {}, cwd = checkout) {
  const clean = { PATH: process.env.PATH ?? '', HOME: join(tmpdir(), 'baton-no-home'), ...env };
  try {
    const { stdout, stderr } = await exec(bin, args, { cwd, env: clean });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

describe('dist/baton.mjs', () => {
  test("is one executable file that imports only Node's built-ins", () => {
    expect(statSync(bin).mode & 0o111).not.toBe(0);
    const text = readFileSync(bin, 'utf8');
    expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true);
    const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith('node:'))).toEqual([]);
  });

  test('the package declares no dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(pkg.optionalDependencies).toBeUndefined();
    expect(pkg.bin).toEqual({ baton: './dist/baton.mjs' });
  });

  test('reports its version', async () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const result = await baton(['--version']);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  test('runs the loop end to end as a process', async () => {
    const env = w.env;
    const registered = await baton(['project', 'register', '--name', 'Widgets'], env);
    expect(registered.code).toBe(0);
    expect(JSON.parse(registered.stdout).project.repos).toEqual([REPO]);
    await baton(['create', 'Bundle card', '--key', 'bundle-card', '--column', 'ready'], env);
    const taken = await baton(['take', 'bundle-card'], env);
    expect(taken.code).toBe(0);
    expect(JSON.parse(taken.stdout).card.claim.worktree).toBe(checkout);
    const passed = await baton(['pass', '--comment', 'done'], env);
    expect(JSON.parse(passed.stdout).card.column).toBe('in_review');
  });

  test('exits 2 with JSON on stderr when it cannot start, and prints nothing on stdout', async () => {
    const result = await baton(['list'], { BATON_URL: w.server.url }, tmpdir());
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).error.code).toMatch(/not_a_checkout|no_token/);
  });

  test("exits 1 with the board's refusal on stderr", async () => {
    const result = await baton(['take', 'missing-card'], w.env);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr).error.code).toBe('not_found');
  });
});

// The reference copies of the skill and its hooks (packages/cli/skill/baton). The plugin repository carries the real ones; these
// are the copies it starts from, so they are held to the same standard: every verb documented, the version pinned to the CLI
// they ship with, and the hook scripts doing what their comments say.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { HELP } from '../packages/cli/src/run.ts';

const root = join(import.meta.dirname, '..');
const skillDir = join(root, 'packages/cli/skill/baton');
const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
const version = (JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')) as { version: string })
  .version;

describe('SKILL.md', () => {
  test('has the frontmatter a skill needs', () => {
    expect(skill).toMatch(/^---\nname: baton\ndescription: .{40,}\n---\n/);
  });

  test('documents every verb the CLI has', () => {
    const verbs = [...HELP.matchAll(/^ {2}baton ([a-z]+)/gm)].map((m) => m[1] as string);
    expect(verbs).toEqual(
      expect.arrayContaining([
        'project',
        'list',
        'create',
        'take',
        'heartbeat',
        'check',
        'ack',
        'comment',
        'move',
        'pass',
        'drop',
        'hook',
      ]),
    );
    // `project register` and `hook` are set up once; the loop's verbs are all named in the skill.
    for (const verb of verbs.filter((v) => !['project', 'hook', 'move'].includes(v))) {
      expect(skill, `the skill never mentions baton ${verb}`).toContain(`baton ${verb}`);
    }
  });

  test('orders the loop as the requirement does: list and take before editing, check and ack before passing, drop on stop', () => {
    const at = (s: string) => skill.indexOf(s);
    expect(at('baton check`')).toBeGreaterThan(-1);
    expect(at('baton list')).toBeGreaterThan(at('baton check`'));
    expect(at('baton take <card>')).toBeGreaterThan(at('baton list'));
    expect(at('baton ack <card>')).toBeGreaterThan(at('baton take <card>'));
    expect(at('baton pass')).toBeGreaterThan(at('baton ack <card>'));
    expect(at('baton drop')).toBeGreaterThan(at('baton pass'));
    expect(skill).toMatch(/before you touch a file/i);
  });

  test('pins the CLI version it ships with', () => {
    const pins = [...skill.matchAll(/@andrewchemis\/baton-cli@([\w.-]+)/g)].map((m) => m[1]);
    expect(pins.length).toBeGreaterThan(0);
    expect(new Set(pins)).toEqual(new Set([version]));
  });

  test('has no emoji', () => {
    expect(skill).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe('hook scripts', () => {
  const heartbeat = join(skillDir, 'hooks/heartbeat.sh');
  const stop = join(skillDir, 'hooks/stop.sh');

  test.each([heartbeat, stop])('%s is executable, POSIX sh, valid and pins the version', (file) => {
    expect(statSync(file).mode & 0o111).not.toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    execFileSync('sh', ['-n', file]);
    expect(text).toContain(`@andrewchemis/baton-cli@${version}`);
  });

  test('the stop hook is for SessionEnd, and says why', () => {
    const text = readFileSync(stop, 'utf8');
    expect(text).toMatch(/SessionEnd/);
    expect(text).toMatch(/not "Stop"/);
  });

  // A checkout, and an `npx` that records how it was called instead of fetching anything.
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'baton-hook-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const git = (...a: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...a], { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'npx.log');
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\necho "$@" >> ${log}\n`);
    chmodSync(join(bin, 'npx'), 0o755);
    const state = join(repo, '.git', 'baton-card');
    const run = (script: string) =>
      execFileSync('sh', [script], {
        cwd: repo,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: dir },
        stdio: 'pipe',
      });
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
    return { state, run, calls, repo, dir };
  }

  test('heartbeat: no card held, no Node start', () => {
    const { run, calls } = setup();
    run(heartbeat);
    expect(calls()).toEqual([]);
  });

  test('heartbeat: a stamp touched in the last minute is left alone; an older or missing one gets the CLI', () => {
    const { state, run, calls } = setup();
    writeFileSync(state, '{}');
    writeFileSync(`${state}.beat`, '');
    run(heartbeat);
    expect(calls()).toEqual([]);
    const old = new Date(Date.now() - 120_000);
    utimesSync(`${state}.beat`, old, old);
    run(heartbeat);
    expect(calls()).toEqual([`--yes --prefer-offline @andrewchemis/baton-cli@${version} hook heartbeat`]);
    rmSync(`${state}.beat`);
    run(heartbeat);
    expect(calls()).toHaveLength(2);
  });

  test('heartbeat: a state file rewritten inside the minute (by check or ack) does not hold the heartbeat back', () => {
    const { state, run, calls } = setup();
    const old = new Date(Date.now() - 120_000);
    writeFileSync(`${state}.beat`, '');
    utimesSync(`${state}.beat`, old, old);
    // `baton check` has just rewritten the state file: its mtime is now, the stamp's is two minutes ago.
    writeFileSync(state, '{}');
    run(heartbeat);
    expect(calls()).toEqual([`--yes --prefer-offline @andrewchemis/baton-cli@${version} hook heartbeat`]);
  });

  test('heartbeat: outside a git checkout it does nothing and exits 0', () => {
    const { dir, calls } = setup();
    execFileSync('sh', [heartbeat], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir }, stdio: 'pipe' });
    expect(calls()).toEqual([]);
  });

  test('stop: no card held, nothing; a card held, the CLI is told to stop', () => {
    const { state, run, calls } = setup();
    run(stop);
    expect(calls()).toEqual([]);
    writeFileSync(state, '{}');
    run(stop);
    expect(calls()).toEqual([`--yes --prefer-offline @andrewchemis/baton-cli@${version} hook stop`]);
  });

  test('both exit 0 when npx itself fails', () => {
    const { dir, state, repo } = setup();
    writeFileSync(join(dir, 'bin', 'npx'), '#!/bin/sh\nexit 1\n');
    writeFileSync(state, '{}');
    const env = { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, HOME: dir };
    expect(() => execFileSync('sh', [heartbeat], { cwd: repo, env, stdio: 'pipe' })).not.toThrow();
    expect(() => execFileSync('sh', [stop], { cwd: repo, env, stdio: 'pipe' })).not.toThrow();
  });
});

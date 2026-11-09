// Requirement 8.2: repo, worktree and branch come from the git checkout; the project from the repo map; and the command
// fails with a named cause outside a checkout or when the repo belongs to no project. Also worktree-local state.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { normalizeRepo } from '../src/git.ts';
import { git, stateFileOf } from './git.ts';
import { REPO, startWorld, type World } from './harness.ts';
import { REPO_URLS } from './repo-urls.ts';

let w: World;
beforeAll(async () => {
  w = await startWorld();
  await w.board.as({ human: 'owner@example.test' }).post('/projects', { name: 'Widgets', repos: [REPO] });
});
afterAll(async () => w.close());

describe('normalizeRepo', () => {
  test.each(REPO_URLS)('%s', (input, expected) => {
    expect(normalizeRepo(input)).toBe(expected);
  });
});

describe('detection', () => {
  test('outside a checkout the command says so and exits 2', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'baton-bare-'));
    const result = await w.baton(['list'], { cwd: bare });
    expect(result.code).toBe(2);
    expect(result.error.code).toBe('not_a_checkout');
    expect(result.error.message).toMatch(/git checkout/);
    expect(result.stdout).toBe('');
  });

  test('a checkout with no remote names the way out', async () => {
    const dir = w.repo(null);
    const result = await w.baton(['list'], { cwd: dir });
    expect(result.code).toBe(2);
    expect(result.error.code).toBe('no_remote');
    expect(result.error.message).toMatch(/BATON_REPO/);
    const named = await w.baton(['list'], { cwd: dir, env: { BATON_REPO: REPO } });
    expect(named.code).toBe(0);
  });

  test('a remote other than origin is used when origin is missing', async () => {
    const dir = w.repo(null);
    git(dir, 'remote', 'add', 'upstream', 'git@github.com:Acme/Widgets.git');
    const result = await w.baton(['list'], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.json.repo).toBe(REPO);
  });

  test('a repo that belongs to no project is refused, with the command that fixes it', async () => {
    const dir = w.repo('https://github.com/acme/orphan.git');
    const result = await w.baton(['list'], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.error.code).toBe('repo_unregistered');
    expect(result.error.message).toMatch(/baton project register --name/);
    const take = await w.baton(['take', 'anything'], { cwd: dir });
    expect(take.error.code).toBe('repo_unregistered');
  });

  test('a detached HEAD is recorded as a branch the reader can follow', async () => {
    const dir = w.repo();
    git(dir, 'checkout', '-q', '--detach');
    await w.board
      .as({ human: 'owner@example.test' })
      .post('/cards', { repo: REPO, title: 'Detached', key: 'detached' });
    const taken = await w.baton(['take', 'detached'], { cwd: dir });
    expect(taken.code).toBe(0);
    expect(taken.json.card.claim.branch).toMatch(/^detached-[0-9a-f]+$/);
  });

  test('a subdirectory resolves to the top of the checkout', async () => {
    const dir = w.repo();
    const sub = join(dir, 'src', 'deep');
    execFileSync('mkdir', ['-p', sub]);
    await w.board.as({ human: 'owner@example.test' }).post('/cards', { repo: REPO, title: 'Deep', key: 'deep' });
    const taken = await w.baton(['take', 'deep'], { cwd: sub });
    expect(taken.json.card.claim.worktree).toBe(dir);
  });
});

describe('linked worktrees', () => {
  test('each keeps its own held card, and a second worktree is told who holds the first', async () => {
    const human = w.board.as({ human: 'owner@example.test' });
    await human.post('/cards', { repo: REPO, title: 'Alpha', key: 'alpha' });
    await human.post('/cards', { repo: REPO, title: 'Beta', key: 'beta' });
    const main = w.repo();
    const other = w.worktree(main, 'feature/beta');

    const first = await w.baton(['take', 'alpha'], { cwd: main });
    expect(first.code).toBe(0);
    const stateMain = stateFileOf(main);
    const stateOther = stateFileOf(other);
    expect(stateMain).not.toBe(stateOther);
    expect(existsSync(stateMain)).toBe(true);
    expect(existsSync(stateOther)).toBe(false);

    // Same agent token, different worktree: not the holder, and the refusal says where the work is.
    const refused = await w.baton(['take', 'alpha'], { cwd: other });
    expect(refused.code).toBe(1);
    expect(refused.error.code).toBe('claim_held');
    expect(refused.error.claim).toMatchObject({ worktree: main, branch: 'main' });
    expect(refused.error.message).toMatch(/worktree|branch/i);

    const second = await w.baton(['take', 'beta'], { cwd: other });
    expect(second.json.card.claim).toMatchObject({ worktree: other, branch: 'feature/beta' });
    expect(JSON.parse(readFileSync(stateOther, 'utf8')).held.key).toBe(`${REPO}/beta`);
    expect(JSON.parse(readFileSync(stateMain, 'utf8')).held.key).toBe(`${REPO}/alpha`);
    // Neither command touched a tracked file.
    expect(git(main, 'status', '--porcelain')).toBe('');
  });

  test('taking a second card in one worktree warns that the first will go stale', async () => {
    const human = w.board.as({ human: 'owner@example.test' });
    await human.post('/cards', { repo: REPO, title: 'One', key: 'one' });
    await human.post('/cards', { repo: REPO, title: 'Two', key: 'two' });
    const dir = w.repo();
    await w.baton(['take', 'one'], { cwd: dir });
    const second = await w.baton(['take', 'two'], { cwd: dir });
    expect(second.json.warnings.map((x: any) => x.code)).toContain('second_card');
    expect(second.json.warnings.find((x: any) => x.code === 'second_card').message).toMatch(/baton drop/);
  });

  test("the session label is the environment's when set, else one made once and kept", async () => {
    const human = w.board.as({ human: 'owner@example.test' });
    await human.post('/cards', { repo: REPO, title: 'Labelled', key: 'labelled' });
    const withEnv = w.repo();
    const a = await w.baton(['take', 'labelled'], { cwd: withEnv, env: { CLAUDE_SESSION_ID: 'session_abc' } });
    expect(a.json.card.claim.session).toBe('session_abc');
    await human.post('/cards', { repo: REPO, title: 'Made', key: 'made' });
    const without = w.repo();
    const b = await w.baton(['take', 'made'], { cwd: without });
    const label = b.json.card.claim.session;
    expect(label).toMatch(/^local-[0-9a-f]{12}$/);
    const c = await w.baton(['check', 'made'], { cwd: without });
    expect(JSON.parse(readFileSync(stateFileOf(without), 'utf8')).session).toBe(label);
    expect(c.code).toBe(0);
  });
});

// Requirement 8.4: a heartbeat hook that sends at most one heartbeat a minute, and a stop hook that releases the card with
// reason session_ended and a comment. Hooks must never disturb the session: they exit 0 whatever happens.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { REPO, startWorld, type World } from './harness.ts';

let w: World;
beforeAll(async () => {
  w = await startWorld();
  await w.board.as({ human: 'owner@example.test' }).post('/projects', { name: 'Widgets', repos: [REPO] });
});
afterAll(async () => w.close());

const human = () => w.board.as({ human: 'owner@example.test' });
const statePath = (dir: string) =>
  execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'baton-card'], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();

function counting(): { fetch: typeof fetch; paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    fetch: (input, init) => {
      paths.push(`${init?.method ?? 'GET'} ${new URL(input as URL).pathname}`);
      return fetch(input, init);
    },
  };
}

async function holding(key: string) {
  const dir = w.repo();
  const card = (await human().post('/cards', { repo: REPO, title: key, key, column: 'ready' })).body.card;
  const taken = await w.baton(['take', card.id], { cwd: dir });
  expect(taken.code).toBe(0);
  return { dir, card };
}

describe('heartbeat hook', () => {
  test('does nothing, and asks nothing of the board, when no card is held', async () => {
    const dir = w.repo();
    const net = counting();
    const result = await w.baton(['hook', 'heartbeat'], { cwd: dir, fetch: net.fetch });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(net.paths).toEqual([]);
  });

  test('does nothing outside a git checkout', async () => {
    const net = counting();
    const result = await w.baton(['hook', 'heartbeat'], { fetch: net.fetch });
    expect(result.code).toBe(0);
    expect(net.paths).toEqual([]);
  });

  test('sends at most one heartbeat a minute however many tools run', async () => {
    const { dir, card } = await holding('hb-limit');
    const net = counting();
    const t0 = Date.now();
    // Inside the minute after the claim: nothing.
    for (let i = 0; i < 5; i += 1) {
      await w.baton(['hook', 'heartbeat'], { cwd: dir, fetch: net.fetch, now: () => t0 + 30_000 });
    }
    expect(net.paths).toEqual([]);
    // A minute on: one, then none until another minute has passed.
    for (let i = 0; i < 5; i += 1) {
      const result = await w.baton(['hook', 'heartbeat'], {
        cwd: dir,
        fetch: net.fetch,
        now: () => t0 + 61_000 + i * 1000,
      });
      expect(result.code).toBe(0);
    }
    expect(net.paths).toEqual([`POST /api/agent/cards/${card.id}/heartbeat`]);
    await w.baton(['hook', 'heartbeat'], { cwd: dir, fetch: net.fetch, now: () => t0 + 125_000 });
    expect(net.paths).toHaveLength(2);
  });

  test('extends the lease on the board', async () => {
    const { dir, card } = await holding('hb-extends');
    const before = (await human().get(`/cards/${card.id}`)).body.card.claim.leaseUntil;
    w.board.clock.advance(5 * 60_000);
    await w.baton(['hook', 'heartbeat'], { cwd: dir, now: () => Date.now() + 61_000 });
    const after = (await human().get(`/cards/${card.id}`)).body.card.claim.leaseUntil;
    expect(after - before).toBe(5 * 60_000);
  });

  test('exits 0 and says so on stderr when the board cannot be reached', async () => {
    const { dir } = await holding('hb-down');
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const result = await w.baton(['hook', 'heartbeat'], { cwd: dir, fetch: down, now: () => Date.now() + 61_000 });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/baton hook heartbeat/);
  });

  test('when the card was taken over, it forgets the card and says so, still exiting 0', async () => {
    const { dir, card } = await holding('hb-lost');
    w.board.clock.advance(11 * 60_000);
    const taken = await w.board
      .as({ agent: 'rival' })
      .post(`/cards/${card.id}/claim`, { repo: REPO, worktree: '/rival', branch: 'r' });
    expect(taken.status).toBe(200);
    const result = await w.baton(['hook', 'heartbeat'], { cwd: dir, now: () => Date.now() + 61_000 });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/not holding|holder|hold/i);
    const state = JSON.parse((await import('node:fs')).readFileSync(statePath(dir), 'utf8'));
    expect(state.held).toBeNull();
  });
});

describe('stop hook', () => {
  test('releases the card with session_ended and a comment, and forgets it', async () => {
    const { dir, card } = await holding('stop-releases');
    const result = await w.baton(['hook', 'stop'], { cwd: dir });
    expect(result.code).toBe(0);
    expect(result.json.card).toMatchObject({ claim: null, column: 'in_progress' });
    expect(result.json.card.lastClaim.reason).toBe('session_ended');
    const events = (await human().get(`/cards/${card.id}/events`)).body.events;
    const commented = events.find((e: any) => e.type === 'commented');
    expect(commented.payload.text).toMatch(/Session ended while this card was held/);
    expect(commented.payload.text).toContain('main');
    expect(events.at(-1)).toMatchObject({ type: 'released', payload: { reason: 'session_ended' } });
    expect(existsSync(statePath(dir))).toBe(false);
    const again = await w.baton(['hook', 'stop'], { cwd: dir });
    expect(again.code).toBe(0);
    expect(again.stdout).toBe('');
  });

  test('a card nobody holds any more is not an error', async () => {
    const { dir, card } = await holding('stop-lost');
    w.board.clock.advance(11 * 60_000);
    await w.board
      .as({ agent: 'rival-2' })
      .post(`/cards/${card.id}/claim`, { repo: REPO, worktree: '/rival', branch: 'r' });
    const result = await w.baton(['hook', 'stop'], { cwd: dir });
    expect(result.code).toBe(0);
    expect(existsSync(statePath(dir))).toBe(false);
    // The rival's claim is untouched.
    expect((await human().get(`/cards/${card.id}`)).body.card.claim.agentId).toBe('rival-2');
  });

  test('exits 0 when the board cannot be reached, and keeps the card so a later stop can retry', async () => {
    const { dir } = await holding('stop-down');
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const result = await w.baton(['hook', 'stop'], { cwd: dir, fetch: down });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/baton hook stop/);
    expect(existsSync(statePath(dir))).toBe(true);
  });

  test('an unknown hook name is a usage error', async () => {
    const result = await w.baton(['hook', 'nope'], { cwd: w.repo() });
    expect(result.code).toBe(2);
  });
});

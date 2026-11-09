// Requirement 7.2 from the caller's side: a write retried after a lost answer carries the same Idempotency-Key, so the board
// does it once. Every request below reaches the real service over DynamoDB Local; only the network between is made to fail.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { REPO, startWorld, type World } from './harness.ts';

let w: World;
let checkout: string;
beforeAll(async () => {
  w = await startWorld();
  checkout = w.repo();
  await w.board.as({ human: 'owner@example.test' }).post('/projects', { name: 'Widgets', repos: [REPO] });
});
afterAll(async () => w.close());

const human = () => w.board.as({ human: 'owner@example.test' });

interface Seen {
  method: string;
  path: string;
  key: string | null;
}
/** Forwards to the real server, then loses the answer to the first `lose` writes, as a dropped connection would. */
function flaky(options: { lose?: number; status?: number }): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  let lost = 0;
  const flakyFetch: typeof fetch = async (input, init) => {
    const url = new URL(input as URL);
    const headers = new Headers(init?.headers);
    seen.push({ method: init?.method ?? 'GET', path: url.pathname, key: headers.get('idempotency-key') });
    if (options.status && seen.length <= 2 && init?.method === 'POST') {
      return new Response('{"message":"Service Unavailable"}', { status: options.status });
    }
    const response = await fetch(input, init);
    if (options.lose && init?.method === 'POST' && lost < options.lose) {
      lost += 1;
      await response.text();
      throw new TypeError('fetch failed');
    }
    return response;
  };
  return { fetch: flakyFetch, seen };
}

describe('retries', () => {
  test('a claim whose answer was lost is retried under the same key and happens once', async () => {
    const card = (await human().post('/cards', { repo: REPO, title: 'Lost claim', key: 'lost-claim', column: 'ready' }))
      .body.card;
    const net = flaky({ lose: 1 });
    const result = await w.baton(['take', card.id], { cwd: checkout, fetch: net.fetch });
    expect(result.code).toBe(0);
    const posts = net.seen.filter((s) => s.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]?.key).toBeTruthy();
    expect(posts[0]?.key).toBe(posts[1]?.key);
    const events = await human().get(`/cards/${card.id}/events`);
    expect(events.body.events.filter((e: any) => e.type === 'claimed')).toHaveLength(1);
  });

  test('a comment whose answer was lost is posted once', async () => {
    const card = (await human().post('/cards', { repo: REPO, title: 'Lost comment', key: 'lost-comment' })).body.card;
    const net = flaky({ lose: 2 });
    const result = await w.baton(['comment', card.id, 'Found the cause.'], { cwd: checkout, fetch: net.fetch });
    expect(result.code).toBe(0);
    expect(net.seen.filter((s) => s.method === 'POST')).toHaveLength(3);
    const events = await human().get(`/cards/${card.id}/events`);
    expect(events.body.events.filter((e: any) => e.type === 'commented')).toHaveLength(1);
  });

  test('a 503 is retried and then succeeds', async () => {
    const card = (await human().post('/cards', { repo: REPO, title: 'Busy board', key: 'busy-board', column: 'ready' }))
      .body.card;
    const net = flaky({ status: 503 });
    const result = await w.baton(['take', card.id], { cwd: checkout, fetch: net.fetch });
    expect(result.code).toBe(0);
    expect(result.json.card.claim.worktree).toBe(checkout);
  });

  test('a refusal is not retried', async () => {
    const net = flaky({});
    const result = await w.baton(['pass', 'no-such-card'], { cwd: checkout, fetch: net.fetch });
    expect(result.code).toBe(1);
    expect(net.seen.filter((s) => s.method === 'POST')).toHaveLength(0);
    const held = (await human().post('/cards', { repo: REPO, title: 'Held elsewhere', key: 'held-elsewhere' })).body
      .card;
    await w.board.as({ agent: 'someone-else' }).post(`/cards/${held.id}/claim`, {
      repo: REPO,
      worktree: '/elsewhere',
      branch: 'x',
    });
    const refused = flaky({});
    const taken = await w.baton(['take', held.id], { cwd: checkout, fetch: refused.fetch });
    expect(taken.error.code).toBe('claim_held');
    expect(refused.seen.filter((s) => s.path.endsWith('/claim'))).toHaveLength(1);
  });

  test('a board that cannot be reached says the request is safe to repeat', async () => {
    const down: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    const result = await w.baton(['check'], { cwd: checkout, fetch: down });
    expect(result.code).toBe(1);
    expect(result.error.code).toBe('unreachable');
    expect(result.error.message).toMatch(/safe to repeat/);
    expect(result.error.message).toMatch(/BATON_URL/);
  });

  test("an answer that is not Baton's (a login page, a firewall) points at the address", async () => {
    const html: typeof fetch = () => Promise.resolve(new Response('<html>Forbidden</html>', { status: 403 }));
    const result = await w.baton(['check'], { cwd: checkout, fetch: html });
    expect(result.code).toBe(1);
    expect(result.error.code).toBe('bad_response');
    expect(result.error.message).toMatch(/BATON_URL/);
  });

  test("a revoked token gets the board's own instruction", async () => {
    const human2 = human();
    const agent = (await human2.post('/agents', { name: 'revoked-one' })).body.agent;
    const token = (await human2.post(`/agents/${agent.id}/tokens`, { label: 'x' })).body;
    await human2.del(`/agents/${agent.id}/tokens/${token.tokenId}`);
    const result = await w.baton(['check'], { cwd: checkout, env: { BATON_TOKEN: token.token } });
    expect(result.code).toBe(1);
    expect(result.error.code).toBe('token_revoked');
    expect(result.error.message.length).toBeGreaterThan(30);
  });
});

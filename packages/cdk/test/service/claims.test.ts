// Requirements 1, 2 and 5 against DynamoDB: the claim is decided by a conditional write, not by the code that calls it.
import { beforeAll, describe, expect, test } from 'vitest';
import { MINUTE, REPO, claimBody, eventsOf, newCard, seeded, type Seeded } from '../support/board.ts';

let s: Seeded;
beforeAll(async () => {
  s = await seeded();
});

const agent = (id: string) => s.board.as({ agent: id });

describe('R1 one claim per card, decided by the store', () => {
  test('1.1 a claim on a free card records agent, repo, worktree, branch, session and lease, and appends claimed', async () => {
    const card = await newCard(s.human);
    const out = await agent('a1').post(`/cards/${card.id}/claim`, claimBody());
    expect(out.status).toBe(200);
    expect(out.body.card.claim).toMatchObject({
      agentId: 'a1',
      repo: REPO,
      worktree: '/work/widgets',
      branch: 'feature/one',
      session: 's1',
      leaseUntil: s.board.clock.now() + 10 * MINUTE,
      stale: false,
    });
    expect(out.body.card.state).toBe('claimed');
    expect(out.body.alreadyHeld).toBe(false);
    const events = await eventsOf(agent('a1'), card.id);
    expect(events.map((e: any) => e.type)).toEqual(['created', 'claimed']);
    expect(events[1].actor).toEqual({ kind: 'agent', id: 'a1' });
  });

  test('1.2 many agents claiming at once yield exactly one winner, and every loser is told who holds it', async () => {
    const card = await newCard(s.human);
    const racers = Array.from({ length: 12 }, (_, i) => agent(`racer-${i}`));
    const results = await Promise.all(
      racers.map((r, i) =>
        r.post(`/cards/${card.id}/claim`, claimBody({ worktree: `/work/tree-${i}`, branch: `b${i}` })),
      ),
    );
    const won = results.filter((r) => r.status === 200);
    const lost = results.filter((r) => r.status === 409);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(11);
    const winner = won[0]!.body.card.claim;
    for (const loser of lost) {
      expect(loser.body.code).toBe('claim_held');
      expect(loser.body.claim).toMatchObject({
        agentId: winner.agentId,
        worktree: winner.worktree,
        branch: winner.branch,
      });
      expect(loser.body.claim.heartbeatAt).toBe(winner.heartbeatAt);
      expect(loser.body.message).toContain('Pick another card');
    }
    const stored = await agent('x').get(`/cards/${card.id}`);
    expect(stored.body.card.claim.agentId).toBe(winner.agentId);
    const events = await eventsOf(agent('x'), card.id);
    expect(events.filter((e: any) => e.type === 'claimed')).toHaveLength(1);
  });

  test('1.2 one shared token from two worktrees is still two claimants', async () => {
    const card = await newCard(s.human);
    const [a, b] = await Promise.all([
      agent('shared').post(`/cards/${card.id}/claim`, claimBody({ worktree: '/work/one' })),
      agent('shared').post(`/cards/${card.id}/claim`, claimBody({ worktree: '/work/two' })),
    ]);
    expect([a.status, b.status].toSorted((x, y) => x - y)).toEqual([200, 409]);
  });

  test('1.3 a claim on a card held by another agent with a live lease is refused and returns the claim', async () => {
    const card = await newCard(s.human);
    await agent('holder').post(`/cards/${card.id}/claim`, claimBody());
    s.board.clock.advance(3 * MINUTE);
    const out = await agent('other').post(`/cards/${card.id}/claim`, claimBody({ worktree: '/work/other' }));
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('claim_held');
    expect(out.body.claim).toMatchObject({ agentId: 'holder', worktree: '/work/widgets', branch: 'feature/one' });
    expect(out.body.card.id).toBe(card.id);
  });

  test('1.4 claiming a card you hold succeeds with no second claim and no second event', async () => {
    const card = await newCard(s.human);
    await agent('a1').post(`/cards/${card.id}/claim`, claimBody());
    s.board.clock.advance(MINUTE);
    const again = await agent('a1').post(`/cards/${card.id}/claim`, claimBody());
    expect(again.status).toBe(200);
    expect(again.body.alreadyHeld).toBe(true);
    expect(again.body.card.claim.leaseUntil).toBe(s.board.clock.now() + 10 * MINUTE);
    const events = await agent('a1').get(`/cards/${card.id}/events`);
    expect(events.body.events.filter((e: any) => e.type === 'claimed')).toHaveLength(1);
    expect(events.body.seq).toBe(2);
  });

  test('1.5 a claim on an expired lease is granted and appends taken_over naming the previous agent', async () => {
    const card = await newCard(s.human);
    await agent('gone').post(`/cards/${card.id}/claim`, claimBody({ worktree: '/work/gone', branch: 'old' }));
    s.board.clock.advance(11 * MINUTE);
    const view = await agent('new').get(`/cards/${card.id}`);
    expect(view.body.card.state).toBe('stale');
    const out = await agent('new').post(`/cards/${card.id}/claim`, claimBody({ worktree: '/work/new', branch: 'new' }));
    expect(out.status).toBe(200);
    expect(out.body.card.claim.agentId).toBe('new');
    const events = await eventsOf(agent('new'), card.id);
    const taken = events.find((e: any) => e.type === 'taken_over');
    expect(taken.payload.previous).toMatchObject({ agentId: 'gone', worktree: '/work/gone', branch: 'old' });
    expect(out.body.card.lastClaim).toMatchObject({ agentId: 'gone', endedBy: 'taken_over' });
  });

  test('1.5 two agents racing for an expired claim also yield one winner', async () => {
    const card = await newCard(s.human);
    await agent('gone').post(`/cards/${card.id}/claim`, claimBody({ worktree: '/work/gone' }));
    s.board.clock.advance(11 * MINUTE);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        agent(`t${i}`).post(`/cards/${card.id}/claim`, claimBody({ worktree: `/w/${i}` })),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const events = await eventsOf(agent('x'), card.id);
    expect(events.filter((e: any) => e.type === 'taken_over')).toHaveLength(1);
  });
});

describe('R2 a stalled agent becomes visible without anyone looking', () => {
  test('2.1 a heartbeat extends the lease and records heartbeatAt, and appends no event', async () => {
    const card = await newCard(s.human);
    await agent('a1').post(`/cards/${card.id}/claim`, claimBody());
    s.board.clock.advance(5 * MINUTE);
    const out = await agent('a1').post(`/cards/${card.id}/heartbeat`, { worktree: '/work/widgets' });
    expect(out.status).toBe(200);
    expect(out.body.card.claim.heartbeatAt).toBe(s.board.clock.now());
    expect(out.body.card.claim.leaseUntil).toBe(s.board.clock.now() + 10 * MINUTE);
    expect(out.body.heartbeatSeconds).toBe(60);
    const events = await agent('a1').get(`/cards/${card.id}/events`);
    expect(events.body.events).toHaveLength(2);
    expect(events.body.seq).toBe(2);
  });

  test('2.2 a heartbeat from an agent that does not hold the card is refused', async () => {
    const card = await newCard(s.human);
    await agent('a1').post(`/cards/${card.id}/claim`, claimBody());
    const stranger = await agent('b2').post(`/cards/${card.id}/heartbeat`, { worktree: '/work/widgets' });
    expect(stranger.status).toBe(409);
    expect(stranger.body.code).toBe('not_holder');
    const otherTree = await agent('a1').post(`/cards/${card.id}/heartbeat`, { worktree: '/work/elsewhere' });
    expect(otherTree.body.code).toBe('not_holder');
    const unclaimed = await newCard(s.human);
    expect((await agent('a1').post(`/cards/${unclaimed.id}/heartbeat`, { worktree: '/w' })).body.code).toBe(
      'not_holder',
    );
  });

  test('2.3 staleness is computed from leaseUntil at read time in every read', async () => {
    const card = await newCard(s.human);
    await agent('a1').post(`/cards/${card.id}/claim`, claimBody());
    const listed = async () =>
      (await agent('a1').get(`/cards?repo=${REPO}`)).body.cards.find((c: any) => c.id === card.id);
    expect((await listed()).state).toBe('claimed');
    s.board.clock.advance(10 * MINUTE);
    expect((await listed()).state).toBe('claimed');
    s.board.clock.advance(1);
    expect((await listed()).state).toBe('stale');
    expect((await listed()).claim.stale).toBe(true);
    expect((await agent('a1').get(`/cards/${card.id}`)).body.card.state).toBe('stale');
    const board = await s.human.get(`/cards?project=${s.projectId}`);
    expect(board.body.cards.find((c: any) => c.id === card.id).state).toBe('stale');
  });

  test('2.3 a stale holder that heartbeats before anyone takes over keeps the card', async () => {
    const card = await newCard(s.human);
    await agent('a1').post(`/cards/${card.id}/claim`, claimBody());
    s.board.clock.advance(20 * MINUTE);
    const out = await agent('a1').post(`/cards/${card.id}/heartbeat`, { worktree: '/work/widgets' });
    expect(out.status).toBe(200);
    expect(out.body.card.state).toBe('claimed');
  });

  test.each([['done'], ['paused'], ['blocked'], ['session_ended']])(
    '2.4 releasing with reason %s clears the claim, appends released and leaves the card in its column',
    async (reason) => {
      const card = await newCard(s.human, { column: 'in_progress' });
      await agent('a1').post(`/cards/${card.id}/claim`, claimBody());
      const out = await agent('a1').post(`/cards/${card.id}/release`, { worktree: '/work/widgets', reason });
      expect(out.status).toBe(200);
      expect(out.body.card.claim).toBeNull();
      expect(out.body.card.column).toBe('in_progress');
      expect(out.body.card.lastClaim).toMatchObject({
        agentId: 'a1',
        worktree: '/work/widgets',
        branch: 'feature/one',
        reason,
      });
      const events = await eventsOf(agent('a1'), card.id);
      expect(events.at(-1)).toMatchObject({
        type: 'released',
        payload: { reason },
        actor: { kind: 'agent', id: 'a1' },
      });
    },
  );

  test('2.4 a release may name a new column, and an unknown reason or a non-holder is refused', async () => {
    const card = await newCard(s.human);
    await agent('a1').post(`/cards/${card.id}/claim`, claimBody());
    const bad = await agent('a1').post(`/cards/${card.id}/release`, { worktree: '/work/widgets', reason: 'bored' });
    expect(bad.status).toBe(400);
    const notMine = await agent('b2').post(`/cards/${card.id}/release`, {
      worktree: '/work/widgets',
      reason: 'paused',
    });
    expect(notMine.body.code).toBe('not_holder');
    const moved = await agent('a1').post(`/cards/${card.id}/release`, {
      worktree: '/work/widgets',
      reason: 'blocked',
      to: 'blocked',
    });
    expect(moved.body.card.column).toBe('blocked');
    const events = await eventsOf(agent('a1'), card.id);
    expect(events.at(-1).payload).toEqual({ reason: 'blocked', to: 'blocked' });
  });

  test('2.5 an unclaimed card in an in-progress column is unowned, distinct from stale and claimed', async () => {
    const card = await newCard(s.human, { column: 'in_progress' });
    expect(card.state).toBe('unowned');
    const backlog = await newCard(s.human, { column: 'backlog' });
    expect(backlog.state).toBe('unclaimed');
    await agent('a1').post(`/cards/${card.id}/claim`, claimBody());
    expect((await agent('a1').get(`/cards/${card.id}`)).body.card.state).toBe('claimed');
    s.board.clock.advance(11 * MINUTE);
    expect((await agent('a1').get(`/cards/${card.id}`)).body.card.state).toBe('stale');
    await agent('a1').post(`/cards/${card.id}/release`, { worktree: '/work/widgets', reason: 'paused' });
    expect((await agent('a1').get(`/cards/${card.id}`)).body.card.state).toBe('unowned');
  });
});

describe('R5 cards and claims know their worktree', () => {
  test.each([
    ['worktree', claimBody({ worktree: undefined })],
    ['branch', claimBody({ branch: '' })],
    ['repo', claimBody({ repo: undefined })],
  ])('5.1 a claim lacking %s is rejected', async (field, body) => {
    const card = await newCard(s.human);
    const out = await agent('a1').post(`/cards/${card.id}/claim`, body);
    expect(out.status).toBe(400);
    expect(out.body.code).toBe('missing_worktree');
    expect(out.body.message).toContain(field);
    expect((await agent('a1').get(`/cards/${card.id}`)).body.card.claim).toBeNull();
  });

  test('5.1 a claim from another repo is refused', async () => {
    const card = await newCard(s.human);
    const out = await agent('a1').post(`/cards/${card.id}/claim`, claimBody({ repo: 'someone/else' }));
    expect(out.body.code).toBe('repo_mismatch');
  });

  test('5.2 claiming with a branch already active on another card in the repo succeeds with a warning naming that card', async () => {
    const first = await newCard(s.human, { title: 'First' });
    const second = await newCard(s.human, { title: 'Second' });
    await agent('a1').post(`/cards/${first.id}/claim`, claimBody({ branch: 'shared-branch' }));
    const out = await agent('a2').post(
      `/cards/${second.id}/claim`,
      claimBody({ worktree: '/work/two', branch: 'shared-branch' }),
    );
    expect(out.status).toBe(200);
    expect(out.body.warnings).toHaveLength(1);
    expect(out.body.warnings[0]).toMatchObject({ code: 'branch_reused', card: { id: first.id, title: 'First' } });
    s.board.clock.advance(11 * MINUTE);
    const third = await newCard(s.human, { title: 'Third' });
    const later = await agent('a3').post(
      `/cards/${third.id}/claim`,
      claimBody({ worktree: '/work/three', branch: 'shared-branch' }),
    );
    expect(later.body.warnings).toEqual([]);
  });

  test('5.3 listing a repo returns worktree, branch, agent and staleness for each claimed card', async () => {
    const card = await newCard(s.human, { title: 'Listed' });
    await agent('lister').post(
      `/cards/${card.id}/claim`,
      claimBody({ worktree: '/work/listed', branch: 'listed-branch' }),
    );
    const listed = (await agent('x').get(`/cards?repo=${REPO}`)).body.cards.find((c: any) => c.id === card.id);
    expect(listed.claim).toMatchObject({
      agentId: 'lister',
      worktree: '/work/listed',
      branch: 'listed-branch',
      stale: false,
    });
    s.board.clock.advance(11 * MINUTE);
    const stale = (await agent('x').get(`/cards?repo=${REPO}`)).body.cards.find((c: any) => c.id === card.id);
    expect(stale.claim.stale).toBe(true);
  });

  test('5.4 creating a card with an existing key returns the existing card, even when two creates race', async () => {
    const first = await s.human.post('/cards', { repo: REPO, title: 'Keyed', key: 'keyed-one' });
    expect(first.status).toBe(201);
    expect(first.body.card.key).toBe(`${REPO}/keyed-one`);
    const again = await agent('a1').post('/cards', { repo: REPO, title: 'Different title', key: `${REPO}/keyed-one` });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.card.id).toBe(first.body.card.id);
    const race = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        (i % 2 ? s.human : agent('a1')).post('/cards', { repo: REPO, title: `Racer ${i}`, key: 'raced' }),
      ),
    );
    expect(new Set(race.map((r) => r.body.card.id)).size).toBe(1);
    expect(race.filter((r) => r.status === 201)).toHaveLength(1);
    const listed = (await s.human.get(`/cards?project=${s.projectId}`)).body.cards.filter(
      (c: any) => c.key === `${REPO}/raced`,
    );
    expect(listed).toHaveLength(1);
  });

  test('a claim may advance a card from backlog to in progress, never backwards', async () => {
    const card = await newCard(s.human, { column: 'ready' });
    const out = await agent('a1').post(`/cards/${card.id}/claim`, claimBody({ to: 'in_progress' }));
    expect(out.body.card.column).toBe('in_progress');
    const review = await newCard(s.human, { column: 'in_review' });
    const stays = await agent('a1').post(
      `/cards/${review.id}/claim`,
      claimBody({ to: 'in_progress', branch: 'b2', worktree: '/work/widgets' }),
    );
    expect(stays.body.card.column).toBe('in_review');
  });
});

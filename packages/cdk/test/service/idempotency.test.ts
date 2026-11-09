// Requirement 7.2: every write route honours Idempotency-Key and a repeat returns the first response with no second write.
import { beforeAll, describe, expect, test } from 'vitest';
import { registerAgent } from '../support/agents.ts';
import { MINUTE, claimBody, eventsOf, newCard, seeded, type Seeded } from '../support/board.ts';

let s: Seeded;
beforeAll(async () => {
  s = await seeded();
});

const HOUR = 60 * MINUTE;

describe('R7.2 idempotency keys', () => {
  test('a replayed comment returns the first response and writes no second event', async () => {
    const card = await newCard(s.human);
    const first = await s.human.post(`/cards/${card.id}/comments`, { text: 'once' }, 'k-comment-1');
    expect(first.status).toBe(201);
    s.board.clock.advance(MINUTE);
    const again = await s.human.post(`/cards/${card.id}/comments`, { text: 'once' }, 'k-comment-1');
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const events = await eventsOf(s.human, card.id);
    expect(events.filter((e: any) => e.type === 'commented')).toHaveLength(1);
  });

  test('a claim retried with the same key by the same agent is a no-op that succeeds with no second event', async () => {
    const card = await newCard(s.human);
    const agent = s.board.as({ agent: 'a1' });
    const first = await agent.post(`/cards/${card.id}/claim`, claimBody(), 'k-claim-1');
    const again = await agent.post(`/cards/${card.id}/claim`, claimBody(), 'k-claim-1');
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const withNewKey = await agent.post(`/cards/${card.id}/claim`, claimBody(), 'k-claim-2');
    expect(withNewKey.status).toBe(200);
    expect(withNewKey.body.alreadyHeld).toBe(true);
    expect((await eventsOf(agent, card.id)).filter((e: any) => e.type === 'claimed')).toHaveLength(1);
  });

  test('a replayed card creation returns the same card, a replayed heartbeat the same lease', async () => {
    const created = await s.human.post('/cards', { repo: 'acme/widgets', title: 'Once only' }, 'k-create-1');
    const again = await s.human.post('/cards', { repo: 'acme/widgets', title: 'Once only' }, 'k-create-1');
    expect(again.body.card.id).toBe(created.body.card.id);
    const cards = (await s.human.get(`/cards?project=${s.projectId}`)).body.cards.filter(
      (c: any) => c.title === 'Once only',
    );
    expect(cards).toHaveLength(1);
    const agent = s.board.as({ agent: 'a1' });
    await agent.post(`/cards/${created.body.card.id}/claim`, claimBody());
    s.board.clock.advance(MINUTE);
    const beat = await agent.post(
      `/cards/${created.body.card.id}/heartbeat`,
      { worktree: '/work/widgets' },
      'k-beat-1',
    );
    s.board.clock.advance(MINUTE);
    const beatAgain = await agent.post(
      `/cards/${created.body.card.id}/heartbeat`,
      { worktree: '/work/widgets' },
      'k-beat-1',
    );
    expect(beatAgain.body).toEqual(beat.body);
  });

  test('the same key on a different request is refused rather than answered with the wrong response', async () => {
    const card = await newCard(s.human);
    await s.human.post(`/cards/${card.id}/comments`, { text: 'one' }, 'k-reuse');
    const out = await s.human.post(`/cards/${card.id}/comments`, { text: 'two' }, 'k-reuse');
    expect(out.status).toBe(422);
    expect(out.body.code).toBe('idempotent_replay');
    expect(out.body.message).toContain('new key');
  });

  test('concurrent sends of one request write once', async () => {
    const card = await newCard(s.human);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => s.human.post(`/cards/${card.id}/comments`, { text: 'race' }, 'k-race')),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect((await eventsOf(s.human, card.id)).filter((e: any) => e.type === 'commented')).toHaveLength(1);
  });

  test('a refusal is not remembered: the retry runs again', async () => {
    const card = await newCard(s.human, { column: 'in_progress' });
    const holder = s.board.as({ agent: 'holder' });
    const other = s.board.as({ agent: 'other' });
    await holder.post(`/cards/${card.id}/claim`, claimBody());
    const refused = await other.post(`/cards/${card.id}/claim`, claimBody({ worktree: '/w2' }), 'k-retry');
    expect(refused.status).toBe(409);
    await holder.post(`/cards/${card.id}/release`, { worktree: '/work/widgets', reason: 'paused' });
    const retried = await other.post(`/cards/${card.id}/claim`, claimBody({ worktree: '/w2' }), 'k-retry');
    expect(retried.status).toBe(200);
  });

  test('keys are scoped to the caller', async () => {
    const card = await newCard(s.human);
    const a = await s.human.post(`/cards/${card.id}/comments`, { text: 'mine' }, 'shared-key');
    const b = await s.board.as({ agent: 'a1' }).post(`/cards/${card.id}/comments`, { text: 'theirs' }, 'shared-key');
    expect(b.status).toBe(201);
    expect(b.body.event.payload.text).toBe('theirs');
    expect(a.body.event.payload.text).toBe('mine');
  });

  test('after 24 hours a key is free again, even before DynamoDB has deleted the item', async () => {
    const card = await newCard(s.human);
    await s.human.post(`/cards/${card.id}/comments`, { text: 'day one' }, 'k-expiry');
    s.board.clock.advance(24 * HOUR + 1);
    const out = await s.human.post(`/cards/${card.id}/comments`, { text: 'day two' }, 'k-expiry');
    expect(out.status).toBe(201);
    expect(out.headers['idempotent-replayed']).toBeUndefined();
    expect((await eventsOf(s.human, card.id)).filter((e: any) => e.type === 'commented')).toHaveLength(2);
  });

  test('a replayed token creation does not hand the secret out of the idempotency record', async () => {
    const agent = await registerAgent(s.human, 'Replay check');
    const first = await s.human.post(`/agents/${agent}/tokens`, {}, 'k-token');
    const again = await s.human.post(`/agents/${agent}/tokens`, {}, 'k-token');
    expect(first.body.token).toMatch(/^baton_/);
    expect(again.body.token).toBeNull();
    expect(again.body.note).toContain('Revoke');
    expect((await s.human.get('/agents')).body.agents.find((a: any) => a.id === agent).tokens).toHaveLength(1);
  });

  test('a malformed key is a 400', async () => {
    const card = await newCard(s.human);
    expect((await s.human.post(`/cards/${card.id}/comments`, { text: 'x' }, 'bad key!')).status).toBe(400);
  });
});

// Requirements 3 and 4: what a human does reaches the agent as events it acknowledges, and a backward move reopens work.
import { beforeAll, describe, expect, test } from 'vitest';
import { claimBody, eventsOf, newCard, seeded, type Caller, type Seeded } from '../support/board.ts';

let s: Seeded;
let agent: Caller;
beforeAll(async () => {
  s = await seeded();
  agent = s.board.as({ agent: 'a1' });
});

const WT = { worktree: '/work/widgets' };
const events = (id: string, since = 0) => eventsOf(agent, id, since);

/** An agent takes a card, then passes it to review (acknowledging nothing it was not sent). */
async function passed(title = 'Passed card') {
  const card = await newCard(s.human, { title, column: 'in_progress' });
  await agent.post(`/cards/${card.id}/claim`, claimBody());
  const out = await agent.post(`/cards/${card.id}/release`, { ...WT, reason: 'done', to: 'in_review' });
  expect(out.status).toBe(200);
  return card.id as string;
}

describe('R3 human edits reach the agent as changes', () => {
  test('3.1 a human move, comment and edit each append an event with actor, type, time and payload, and raise seq', async () => {
    const card = await newCard(s.human, { title: 'Steered' });
    expect(card.seq).toBe(1);
    await s.human.post(`/cards/${card.id}/move`, { to: 'ready' });
    await s.human.post(`/cards/${card.id}/comments`, { text: 'Please use the new API.' });
    await s.human.patch(`/cards/${card.id}`, { title: 'Steered again', body: 'More detail' });
    const log = await events(card.id);
    expect(log.map((e) => [e.seq, e.type, e.actor.kind])).toEqual([
      [1, 'created', 'human'],
      [2, 'moved', 'human'],
      [3, 'commented', 'human'],
      [4, 'edited', 'human'],
    ]);
    expect(log[1].payload).toEqual({ from: 'backlog', to: 'ready' });
    expect(log[2].payload).toEqual({ text: 'Please use the new API.' });
    expect(log[3].payload).toEqual({ title: 'Steered again', body: 'More detail' });
    expect(log.every((e) => typeof e.at === 'number')).toBe(true);
    expect((await agent.get(`/cards/${card.id}`)).body.card.seq).toBe(4);
  });

  test('3.2 events since N come back in order after N, with the full comment text', async () => {
    const card = await newCard(s.human);
    const long = 'x'.repeat(3000);
    await s.human.post(`/cards/${card.id}/comments`, { text: 'first' });
    await s.human.post(`/cards/${card.id}/comments`, { text: long });
    await s.human.post(`/cards/${card.id}/comments`, { text: 'third' });
    const since1 = await events(card.id, 1);
    expect(since1.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(since1[1].payload.text).toBe(long);
    const since3 = await events(card.id, 3);
    expect(since3.map((e) => e.payload.text)).toEqual(['third']);
    expect(await events(card.id, 4)).toEqual([]);
  });

  test('3.3 the last agent can acknowledge a sequence, also after it passed the card; a sequence not reached is refused', async () => {
    const id = await passed();
    await s.human.post(`/cards/${id}/comments`, { text: 'Not quite right.' });
    const card = (await agent.get(`/cards/${id}`)).body.card;
    expect(card.claim).toBeNull();
    expect(card.lastAgentId).toBe('a1');
    const ahead = await agent.post(`/cards/${id}/ack`, { seq: card.seq + 1 });
    expect(ahead.status).toBe(409);
    expect(ahead.body).toMatchObject({ code: 'seq_ahead', seq: card.seq });
    expect(ahead.body.message).toContain('baton check');
    const ok = await agent.post(`/cards/${id}/ack`, { seq: card.seq });
    expect(ok.status).toBe(200);
    expect(ok.body.card.ackedSeq).toBe(card.seq);
    expect(ok.body.card.unread).toBe(false);
    const stranger = await s.board.as({ agent: 'someone-else' }).post(`/cards/${id}/ack`, { seq: 1 });
    expect(stranger.body.code).toBe('not_holder');
    const lower = await agent.post(`/cards/${id}/ack`, { seq: 1 });
    expect(lower.body.card.ackedSeq).toBe(card.seq);
  });

  test('3.4 the board shows whether the last agent has acknowledged the latest human event', async () => {
    const id = await passed();
    const unreadOf = async () =>
      (await s.human.get(`/cards?project=${s.projectId}`)).body.cards.find((c: any) => c.id === id).unread;
    expect(await unreadOf()).toBe(false);
    await s.human.post(`/cards/${id}/comments`, { text: 'Look again.' });
    expect(await unreadOf()).toBe(true);
    const seq = (await agent.get(`/cards/${id}`)).body.card.seq;
    await agent.post(`/cards/${id}/ack`, { seq });
    expect(await unreadOf()).toBe(false);
  });

  test('3.5 the attention list returns a passed card after a human comment or a backward move, with no card id', async () => {
    const commented = await passed('Will be commented');
    const moved = await passed('Will be moved back');
    const quiet = await passed('Stays quiet');
    expect((await agent.get('/cards?attention=me')).body.cards.map((c: any) => c.id)).not.toContain(commented);
    await s.human.post(`/cards/${commented}/comments`, { text: 'One more thing.' });
    await s.human.post(`/cards/${moved}/move`, { to: 'in_progress' });
    const attention = (await agent.get('/cards?attention=me')).body.cards;
    const ids = attention.map((c: any) => c.id);
    expect(ids).toContain(commented);
    expect(ids).toContain(moved);
    expect(ids).not.toContain(quiet);
    expect(attention.find((c: any) => c.id === moved).reopened).toBe(true);
    expect((await s.board.as({ agent: 'someone-else' }).get('/cards?attention=me')).body.cards).toEqual([]);
    const seq = (await agent.get(`/cards/${commented}`)).body.card.seq;
    await agent.post(`/cards/${commented}/ack`, { seq });
    expect((await agent.get('/cards?attention=me')).body.cards.map((c: any) => c.id)).not.toContain(commented);
  });

  test('3.5 the attention list is for agents', async () => {
    expect((await s.human.get('/cards?attention=me')).status).toBe(403);
  });

  test('a claim response carries the human events the agent has not acknowledged', async () => {
    const card = await newCard(s.human);
    await s.human.post(`/cards/${card.id}/comments`, { text: 'Read this before starting.' });
    const out = await agent.post(`/cards/${card.id}/claim`, claimBody());
    expect(out.body.pending.map((e: any) => e.payload.text)).toEqual(['Read this before starting.']);
  });
});

describe('R4 a backward move means the work is not done', () => {
  test('4.1 a human move to an earlier column marks the card reopened and records from and to', async () => {
    const id = await passed();
    const out = await s.human.post(`/cards/${id}/move`, { to: 'in_progress' });
    expect(out.body.card.reopened).toBe(true);
    expect((await events(id)).at(-1)).toMatchObject({
      type: 'moved',
      payload: { from: 'in_review', to: 'in_progress' },
      actor: { kind: 'human' },
    });
  });

  test('4.1 forward moves and moves into blocked do not reopen', async () => {
    const card = await newCard(s.human, { column: 'ready' });
    expect((await s.human.post(`/cards/${card.id}/move`, { to: 'in_review' })).body.card.reopened).toBe(false);
    expect((await s.human.post(`/cards/${card.id}/move`, { to: 'blocked' })).body.card.reopened).toBe(false);
    expect((await s.human.post(`/cards/${card.id}/move`, { to: 'backlog' })).body.card.reopened).toBe(false);
  });

  test('4.2 an agent reads reopened: true until an agent claims the card, and the claim clears it', async () => {
    const id = await passed();
    await s.human.post(`/cards/${id}/move`, { to: 'in_progress' });
    expect((await agent.get(`/cards/${id}`)).body.card.reopened).toBe(true);
    expect((await agent.get(`/cards?repo=acme/widgets`)).body.cards.find((c: any) => c.id === id).reopened).toBe(true);
    const claimed = await agent.post(`/cards/${id}/claim`, claimBody());
    expect(claimed.body.card.reopened).toBe(false);
    expect((await agent.get(`/cards/${id}`)).body.card.reopened).toBe(false);
  });

  test('4.3 a human move to Done clears the claim and appends released with reason human_done', async () => {
    const card = await newCard(s.human, { column: 'in_progress' });
    await agent.post(`/cards/${card.id}/claim`, claimBody());
    const out = await s.human.post(`/cards/${card.id}/move`, { to: 'done' });
    expect(out.body.card.claim).toBeNull();
    expect(out.body.card.column).toBe('done');
    expect(out.body.card.lastClaim).toMatchObject({ agentId: 'a1', endedBy: 'human_done' });
    const log = await events(card.id);
    expect(log.map((e) => e.type).slice(-2)).toEqual(['moved', 'released']);
    expect(log.at(-1)).toMatchObject({ payload: { reason: 'human_done' }, actor: { kind: 'human' } });
    const heartbeat = await agent.post(`/cards/${card.id}/heartbeat`, WT);
    expect(heartbeat.body.code).toBe('not_holder');
  });

  test('4.4 an agent move to In review or Done is refused while a human event is unacknowledged, naming the sequence', async () => {
    const card = await newCard(s.human, { column: 'in_progress' });
    await agent.post(`/cards/${card.id}/claim`, claimBody());
    await s.human.post(`/cards/${card.id}/comments`, { text: 'Wait, also handle empty input.' });
    const current = (await agent.get(`/cards/${card.id}`)).body.card;
    for (const to of ['in_review', 'done']) {
      const refused = await agent.post(`/cards/${card.id}/move`, { ...WT, to });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'unacked_comments', seq: current.lastHumanSeq });
      expect(refused.body.message).toContain(String(current.lastHumanSeq));
      expect(refused.body.message).toContain('baton ack');
    }
    const refusedPass = await agent.post(`/cards/${card.id}/release`, { ...WT, reason: 'done', to: 'in_review' });
    expect(refusedPass.body.code).toBe('unacked_comments');
    expect((await agent.get(`/cards/${card.id}`)).body.card.claim).not.toBeNull();
  });

  test('4.4 the move is allowed after the agent acknowledges, and after the agent comments itself', async () => {
    const card = await newCard(s.human, { column: 'in_progress' });
    await agent.post(`/cards/${card.id}/claim`, claimBody());
    await agent.post(`/cards/${card.id}/comments`, { text: 'Progress note.' });
    expect((await agent.post(`/cards/${card.id}/move`, { ...WT, to: 'in_review' })).status).toBe(200);
    await s.human.post(`/cards/${card.id}/comments`, { text: 'Looks fine, one nit.' });
    expect((await agent.post(`/cards/${card.id}/move`, { ...WT, to: 'done' })).body.code).toBe('unacked_comments');
    const seq = (await agent.get(`/cards/${card.id}`)).body.card.seq;
    await agent.post(`/cards/${card.id}/ack`, { seq });
    const done = await agent.post(`/cards/${card.id}/move`, { ...WT, to: 'done' });
    expect(done.status).toBe(200);
    expect(done.body.card.claim).toBeNull();
    expect((await events(card.id)).at(-1)).toMatchObject({ type: 'released', payload: { reason: 'done' } });
  });

  test('4.4 an agent that does not hold the card cannot move it to review', async () => {
    const card = await newCard(s.human, { column: 'in_progress' });
    await agent.post(`/cards/${card.id}/claim`, claimBody());
    const out = await s.board.as({ agent: 'b2' }).post(`/cards/${card.id}/move`, { ...WT, to: 'in_review' });
    expect(out.body.code).toBe('not_holder');
  });

  test('an agent move needs a worktree, and cannot move a card another agent holds', async () => {
    const card = await newCard(s.human, { column: 'in_progress' });
    await agent.post(`/cards/${card.id}/claim`, claimBody());
    expect((await agent.post(`/cards/${card.id}/move`, { to: 'ready' })).body.code).toBe('missing_worktree');
    const held = await s.board.as({ agent: 'b2' }).post(`/cards/${card.id}/move`, { ...WT, to: 'ready' });
    expect(held.body.code).toBe('claim_held');
  });

  test('a human drag to a position persists the column and position in one request', async () => {
    const a = await newCard(s.human, { title: 'A' });
    const b = await newCard(s.human, { title: 'B' });
    const out = await s.human.post(`/cards/${b.id}/move`, { to: 'backlog', pos: '0a' });
    expect(out.status).toBe(200);
    const board = (await s.human.get(`/cards?project=${s.projectId}&column=backlog`)).body.cards;
    expect(board.findIndex((c: any) => c.id === b.id)).toBeLessThan(board.findIndex((c: any) => c.id === a.id));
    expect((await s.human.post(`/cards/${b.id}/move`, { to: 'ready', pos: 'No!' })).status).toBe(400);
  });
});

describe('the event log is read in pages', () => {
  test('a page stops at 200 events, says there are more, and its seq is the last event it returned', async () => {
    const card = await newCard(s.human, { title: 'Chatty' });
    for (let i = 0; i < 205; i += 1) await s.human.post(`/cards/${card.id}/comments`, { text: `Note ${i}` });
    const first = (await agent.get(`/cards/${card.id}/events?since=0`)).body;
    expect(first.events).toHaveLength(200);
    expect(first.more).toBe(true);
    expect(first.seq).toBe(first.events.at(-1).seq);
    const rest = (await agent.get(`/cards/${card.id}/events?since=${first.seq}`)).body;
    expect(rest.events).toHaveLength(6);
    expect(rest.more).toBe(false);
    expect(rest.seq).toBe(206);
    expect((await agent.get(`/cards/${card.id}/events?since=206`)).body).toMatchObject({
      events: [],
      more: false,
      seq: 206,
    });
  });
});

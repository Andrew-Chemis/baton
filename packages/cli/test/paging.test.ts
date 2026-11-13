// `check` reads a card's events in pages and records as read only what it showed: with more pending than one page holds, the
// sequence `ack` later acknowledges is the card's, because every page was fetched and printed.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { stateFileOf } from './git.ts';
import { REPO, startWorld, type World } from './harness.ts';

let w: World;
beforeAll(async () => {
  w = await startWorld();
  await w.board.as({ human: 'owner@example.test' }).post('/projects', { name: 'Widgets', repos: [REPO] });
});
afterAll(async () => w.close());

describe('check with more pending than one page', () => {
  test('205 comments are all shown, and the recorded sequence is the card sequence', async () => {
    const human = w.board.as({ human: 'owner@example.test' });
    const dir = w.repo();
    const card = (await human.post('/cards', { repo: REPO, title: 'Chatty', key: 'chatty', column: 'ready' })).body
      .card;
    expect((await w.baton(['take', card.id], { cwd: dir })).code).toBe(0);
    for (let i = 0; i < 205; i += 1) await human.post(`/cards/${card.id}/comments`, { text: `Note ${i}` });
    const checked = await w.baton(['check', card.id], { cwd: dir });
    expect(checked.code).toBe(0);
    expect(checked.json.pending).toHaveLength(205);
    const now = (await human.get(`/cards/${card.id}`)).body.card;
    expect(checked.json.seq).toBe(now.seq);
    expect(JSON.parse(readFileSync(stateFileOf(dir), 'utf8')).checked[card.id]).toBe(now.seq);
    const acked = await w.baton(['ack', card.id], { cwd: dir });
    expect(acked.code).toBe(0);
    expect(acked.json.card.unread).toBe(false);
  });
});

// Archived cards leave the board's partitions, so a poll never reads them; and a card can be taken only while its repo still
// belongs to the card's project.
import { describe, expect, test } from 'vitest';
import { GSI1, GSI2 } from '../../src/schema.ts';
import { cardKey } from '../../service/keys.ts';
import { getItem } from '../../service/store.ts';
import { REPO, claimBody, newCard, seeded } from '../support/board.ts';

describe('archived cards sit on their own shelf', () => {
  test('the live board and repo listings do not read them; archived=1 still shows them', async () => {
    const s = await seeded();
    const kept = await newCard(s.human, { title: 'Kept' });
    const gone = await newCard(s.human, { title: 'Gone' });
    expect((await s.human.post(`/cards/${gone.id}/archive`)).status).toBe(200);

    const stored = await getItem<Record<string, string>>(s.board.deps, cardKey(gone.id));
    expect(stored?.[GSI1.pk]).toBe(`BOARD#${s.projectId}#ARCHIVED`);
    expect(stored?.[GSI2.pk]).toBe(`REPO#${REPO}#ARCHIVED`);

    const byText = (a: string, b: string) => a.localeCompare(b);
    const ids = (body: Record<string, any>) => (body.cards as { id: string }[]).map((c) => c.id).toSorted(byText);
    expect(ids((await s.human.get(`/cards?project=${s.projectId}`)).body)).toEqual([kept.id]);
    expect(ids((await s.human.get(`/cards?repo=${REPO}`)).body)).toEqual([kept.id]);
    expect(ids((await s.human.get(`/cards?project=${s.projectId}&archived=1`)).body)).toEqual(
      [kept.id, gone.id].toSorted(byText),
    );
    expect(ids((await s.human.get(`/cards?repo=${REPO}&archived=1&column=backlog`)).body)).toEqual(
      [kept.id, gone.id].toSorted(byText),
    );
    const counts = (await s.human.get('/projects')).body.projects[0].counts;
    expect(counts.total).toBe(1);
  });
});

describe('a claim checks the repo map', () => {
  test('a card whose repo left its project cannot be taken, and says why', async () => {
    const s = await seeded();
    const card = await newCard(s.human);
    const agent = s.board.as({ agent: 'a1' });
    expect((await s.human.patch(`/projects/${s.projectId}`, { removeRepos: [REPO] })).status).toBe(200);

    const refused = await agent.post(`/cards/${card.id}/claim`, claimBody());
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('repo_unregistered');
    expect(refused.body.message).toContain('no longer holds acme/widgets');

    // The repo now belongs to another project: the old card stays refused and names the new owner.
    await s.human.post('/projects', { name: 'Gadgets', repos: [REPO] });
    const moved = await agent.post(`/cards/${card.id}/claim`, claimBody());
    expect(moved.body.code).toBe('repo_unregistered');
    expect(moved.body.message).toContain('now belongs to project gadgets');
    expect((await s.human.get(`/cards/${card.id}`)).body.card.claim).toBeNull();
  });

  test('a holder renewing its own claim is not refused by the map read', async () => {
    const s = await seeded();
    const card = await newCard(s.human);
    const agent = s.board.as({ agent: 'a1' });
    expect((await agent.post(`/cards/${card.id}/claim`, claimBody())).status).toBe(200);
    expect((await agent.post(`/cards/${card.id}/claim`, claimBody())).body.alreadyHeld).toBe(true);
  });
});

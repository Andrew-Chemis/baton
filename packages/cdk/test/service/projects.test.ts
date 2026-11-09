// Requirement 10: many projects, one dashboard.
import { describe, expect, test } from 'vitest';
import { tally } from '../../web/src/counts.ts';
import { MINUTE, claimBody, newBoard, newCard, seeded } from '../support/board.ts';

describe('R10 registering projects and repos', () => {
  test('10.1 registering creates the project and its repo map entries, and lists it', async () => {
    const board = await newBoard();
    const human = board.as({ human: 'o@example.test' });
    const out = await human.post('/projects', {
      name: 'Site',
      repos: ['https://github.com/Acme/Site.git', 'git@github.com:Acme/site-api.git'],
    });
    expect(out.status).toBe(201);
    expect(out.body.project).toMatchObject({
      id: 'site',
      name: 'Site',
      repos: ['acme/site', 'acme/site-api'],
      archived: false,
    });
    const byRepo = await board.as({ agent: 'a1' }).get('/projects?repo=acme/site-api&counts=0');
    expect(byRepo.body.projects.map((p: any) => p.id)).toEqual(['site']);
    expect((await board.as({ agent: 'a1' }).get('/projects?repo=acme/unknown')).body.projects).toEqual([]);
  });

  test('10.1 a failed registration writes nothing: the project, its name and its other repos are all-or-nothing', async () => {
    const board = await newBoard();
    const human = board.as({ human: 'o@example.test' });
    await human.post('/projects', { name: 'First', repos: ['acme/taken'] });
    const out = await human.post('/projects', { name: 'Second', repos: ['acme/free', 'acme/taken'] });
    expect(out.status).toBe(409);
    expect(out.body.code).toBe('repo_taken');
    expect((await human.get('/projects')).body.projects.map((p: any) => p.name)).toEqual(['First']);
    const retry = await human.post('/projects', { name: 'Second', repos: ['acme/free'] });
    expect(retry.status).toBe(201);
  });

  test('10.2 a repo already held, by the same project or another, is refused and the holder is named', async () => {
    const board = await newBoard();
    const human = board.as({ human: 'o@example.test' });
    const first = await human.post('/projects', { name: 'Alpha', repos: ['acme/shared'] });
    const other = await human.post('/projects', { name: 'Beta', repos: ['acme/shared'] });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: 'repo_taken', project: { id: first.body.project.id, name: 'Alpha' } });
    expect(other.body.message).toContain('Alpha');
    const same = await human.patch(`/projects/${first.body.project.id}`, { addRepos: ['acme/shared'] });
    expect(same.body).toMatchObject({ code: 'repo_taken', project: { name: 'Alpha' } });
    const second = await human.post('/projects', { name: 'Gamma', repos: ['acme/gamma'] });
    const move = await human.patch(`/projects/${second.body.project.id}`, { addRepos: ['acme/shared'] });
    expect(move.body).toMatchObject({ code: 'repo_taken', project: { name: 'Alpha' } });
  });

  test('10.1 an agent registering by name adds its repo to an existing project, and a second project is refused for a taken name', async () => {
    const board = await newBoard();
    const agent = board.as({ agent: 'a1' });
    const created = await agent.post('/projects', { name: 'Tools', repos: ['acme/one'], ifExists: 'add' });
    expect(created.status).toBe(201);
    const added = await agent.post('/projects', { name: 'tools', repos: ['acme/two'], ifExists: 'add' });
    expect(added.status).toBe(200);
    expect(added.body.added).toEqual(['acme/two']);
    expect((await agent.get('/projects?repo=acme/two')).body.projects[0].repos).toEqual(['acme/one', 'acme/two']);
    const refused = await agent.post('/projects', { name: 'Tools', repos: ['acme/three'] });
    expect(refused.body).toMatchObject({ code: 'name_taken', project: { id: 'tools' } });
    const again = await agent.post('/projects', { name: 'Tools', repos: ['acme/two'], ifExists: 'add' });
    expect(again.body).toMatchObject({ code: 'repo_taken', project: { name: 'Tools' } });
  });

  test('10.1 two registrations of the same new name at once leave one project', async () => {
    const board = await newBoard();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        board.as({ agent: `a${i}` }).post('/projects', { name: 'Raced', repos: [`acme/r${i}`], ifExists: 'add' }),
      ),
    );
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    const projects = (await board.as({ human: 'o@example.test' }).get('/projects')).body.projects;
    expect(projects).toHaveLength(1);
    expect(projects[0].repos.toSorted()).toEqual(['acme/r0', 'acme/r1', 'acme/r2', 'acme/r3', 'acme/r4']);
  });

  test('10.3 a card for a repo in no project is refused, and a card takes its repo project', async () => {
    const s = await seeded();
    const refused = await s.human.post('/cards', { repo: 'acme/nowhere', title: 'Lost' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('repo_unregistered');
    expect(refused.body.message).toContain('baton project register');
    const second = await s.human.post('/projects', { name: 'Other', repos: ['acme/other'] });
    const card = await newCard(s.human, { repo: 'acme/other', title: 'Belongs elsewhere' });
    expect(card.projectId).toBe(second.body.project.id);
    expect((await newCard(s.human)).projectId).toBe(s.projectId);
  });

  test('10.5 rename, add and remove repos; a name in use is refused', async () => {
    const board = await newBoard();
    const human = board.as({ human: 'o@example.test' });
    const a = await human.post('/projects', { name: 'Old name', repos: ['acme/a'] });
    await human.post('/projects', { name: 'Taken', repos: ['acme/t'] });
    const renamed = await human.patch(`/projects/${a.body.project.id}`, {
      name: 'New name',
      addRepos: ['acme/b'],
      removeRepos: ['acme/a'],
    });
    expect(renamed.body.project).toMatchObject({ name: 'New name', repos: ['acme/b'] });
    expect((await human.patch(`/projects/${a.body.project.id}`, { name: 'taken' })).body.code).toBe('name_taken');
    const freed = await human.post('/cards', { repo: 'acme/a', title: 'No home' });
    expect(freed.body.code).toBe('repo_unregistered');
    // The old name is free again after the rename, and so is the removed repo.
    expect((await human.post('/projects', { name: 'Old name', repos: ['acme/a'] })).status).toBe(201);
    expect((await human.patch(`/projects/${a.body.project.id}`, { removeRepos: ['acme/zzz'] })).status).toBe(400);
  });

  test('10.5 archiving is refused with project_has_claims while a card is claimed, then frees the repos and hides the project', async () => {
    const s = await seeded();
    const card = await newCard(s.human, { column: 'in_progress' });
    const agent = s.board.as({ agent: 'a1' });
    await agent.post(`/cards/${card.id}/claim`, claimBody());
    const refused = await s.human.post(`/projects/${s.projectId}/archive`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'project_has_claims', project: { id: s.projectId } });
    expect(refused.body.message).toContain('a1');
    expect((await s.human.get('/projects')).body.projects).toHaveLength(1);
    await agent.post(`/cards/${card.id}/release`, { worktree: '/work/widgets', reason: 'paused' });
    const archived = await s.human.post(`/projects/${s.projectId}/archive`);
    expect(archived.status).toBe(200);
    expect(archived.body.project).toMatchObject({ archived: true, repos: [] });
    expect((await s.human.get('/projects')).body.projects).toEqual([]);
    expect((await s.human.post('/cards', { repo: 'acme/widgets', title: 'After' })).body.code).toBe(
      'repo_unregistered',
    );
    expect((await s.human.post('/projects', { name: 'Widgets', repos: ['acme/widgets'] })).status).toBe(201);
  });

  test('10.5 a stale claim does not block archiving', async () => {
    const s = await seeded();
    const card = await newCard(s.human, { column: 'in_progress' });
    await s.board.as({ agent: 'a1' }).post(`/cards/${card.id}/claim`, claimBody());
    s.board.clock.advance(11 * MINUTE);
    expect((await s.human.post(`/projects/${s.projectId}/archive`)).status).toBe(200);
  });
});

describe('R10.4 the dashboard', () => {
  test('counts match a seeded board, archived cards and archived projects are left out, and lastEventAt is the latest event', async () => {
    const board = await newBoard();
    const human = board.as({ human: 'o@example.test' });
    const agent = board.as({ agent: 'a1' });
    const wt = { worktree: '/work/counts' };
    await human.post('/projects', { name: 'Counts', repos: ['acme/counts'] });
    await human.post('/projects', { name: 'Quiet', repos: ['acme/quiet'] });
    const retired = await human.post('/projects', { name: 'Retired', repos: ['acme/retired'] });
    await human.post(`/projects/${retired.body.project.id}/archive`);
    const mk = (title: string, over: Record<string, unknown> = {}) =>
      newCard(human, { repo: 'acme/counts', title, ...over });
    const cl = (id: string, extra: Record<string, unknown> = {}) =>
      agent.post(`/cards/${id}/claim`, claimBody({ repo: 'acme/counts', worktree: '/work/counts', ...extra }));

    const stale = await mk('stale', { column: 'in_progress' });
    await board
      .as({ agent: 'gone' })
      .post(`/cards/${stale.id}/claim`, claimBody({ repo: 'acme/counts', worktree: '/work/gone' }));
    board.clock.advance(11 * MINUTE);
    const claimed = await mk('claimed', { column: 'in_progress' });
    await cl(claimed.id);
    await mk('unowned', { column: 'in_progress' });
    await mk('backlog only');
    const reopened = await mk('reopened', { column: 'in_progress' });
    await cl(reopened.id, { worktree: '/work/counts' });
    await agent.post(`/cards/${reopened.id}/release`, { ...wt, reason: 'done', to: 'in_review' });
    await human.post(`/cards/${reopened.id}/move`, { to: 'in_progress' });
    const unread = await mk('unread', { column: 'in_progress' });
    await cl(unread.id);
    await agent.post(`/cards/${unread.id}/release`, { ...wt, reason: 'done', to: 'in_review' });
    board.clock.advance(MINUTE);
    await human.post(`/cards/${unread.id}/comments`, { text: 'hm' });
    const review = await mk('in review', { column: 'in_review' });
    const hidden = await mk('archived', { column: 'in_progress' });
    await human.post(`/cards/${hidden.id}/archive`);
    const lastEventAt = board.clock.now();

    const projects = (await human.get('/projects')).body.projects;
    expect(projects.map((p: any) => p.name)).toEqual(['Counts', 'Quiet']);
    const counts = projects[0];
    expect(counts.counts).toEqual({
      total: 7,
      claimed: 1,
      stale: 1,
      // unowned: the card nobody took, the passed card a human sent back (now in progress with no claim), and the unread one's column is review.
      unowned: 2,
      reopened: 1,
      unread: 2,
      inReview: 2,
    });
    expect(counts.lastEventAt).toBe(lastEventAt);
    expect(projects[1].counts).toEqual({
      total: 0,
      claimed: 0,
      stale: 0,
      unowned: 0,
      reopened: 0,
      unread: 0,
      inReview: 0,
    });
    expect(review.state).toBe('unclaimed');

    // The board page works the five counts out from the cards it lists, not from this endpoint, and they must come out the
    // same, whether or not archived cards were asked for.
    const { total: _total, inReview: _inReview, ...five } = counts.counts;
    expect(tally((await human.get(`/cards?project=${counts.id}`)).body.cards)).toEqual(five);
    expect(tally((await human.get(`/cards?project=${counts.id}&archived=1`)).body.cards)).toEqual(five);
  });
});

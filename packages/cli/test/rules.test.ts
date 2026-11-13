// Rules the CLI applies before it asks the board must agree with the board's. Each case here was a place they could differ.
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { REPO, startWorld, type World } from './harness.ts';

// One board per describe: each registers the same repo.
let w: World;
const worlds: World[] = [];
beforeEach(async () => {
  w = await startWorld();
  worlds.push(w);
});
afterAll(async () => Promise.all(worlds.map((world) => world.close())));

describe('registering a project again', () => {
  test('a name with extra spaces or another case is the same project, so the repeat changes nothing', async () => {
    const checkout = w.repo();
    const first = await w.baton(['project', 'register', '--name', 'My  Project'], { cwd: checkout });
    expect(first.code).toBe(0);
    expect(first.json.created).toBe(true);
    expect(first.json.project.name).toBe('My Project');
    for (const name of ['My  Project', '  my project ', 'MY\u00a0PROJECT']) {
      const again = await w.baton(['project', 'register', '--name', name], { cwd: checkout });
      expect(again.code, name).toBe(0);
      expect(again.json.created, name).toBe(false);
      expect(again.json.added, name).toEqual([]);
    }
  });
});

describe('a card named by thirteen lower-case letters', () => {
  test('is a slug when no card has that id', async () => {
    const checkout = w.repo();
    const human = w.board.as({ human: 'owner@example.test' });
    expect((await human.post('/projects', { name: 'Slugs', repos: [REPO] })).status).toBe(201);
    const slug = 'abcdefghijklm';
    const made = await human.post('/cards', { repo: REPO, title: 'Thirteen', key: slug, column: 'ready' });
    expect(made.status).toBe(201);
    const taken = await w.baton(['take', slug], { cwd: checkout });
    expect(taken.code).toBe(0);
    expect(taken.json.card.id).toBe(made.body.card.id);
    // The real id still works, and so does the full key.
    expect((await w.baton(['check', made.body.card.id], { cwd: checkout })).code).toBe(0);
    expect((await w.baton(['check', `${REPO}/${slug}`], { cwd: checkout })).code).toBe(0);
  });
});

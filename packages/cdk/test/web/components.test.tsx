// Requirements 6 and 10 as the page shows them: states told apart by shape and wording, the dashboard putting what needs a
// person first, the board's columns, filter, drawer and forms. Layout and dragging need a real browser and are checked there.
import { describe, expect, test } from 'vitest';
import { Agents } from '../../web/src/agents.tsx';
import { badgesFor, CardBadges } from '../../web/src/badges.tsx';
import { Board } from '../../web/src/board.tsx';
import { Dashboard, ordered } from '../../web/src/dashboard.tsx';
import {
  button,
  choose,
  counts,
  mount,
  projectView,
  route,
  stubApi,
  submit,
  type,
  until,
  useWebEnv,
  view,
} from './support.tsx';

const NOW = Date.now();
const claim = (over: object = {}) => ({
  agentId: 'nova',
  repo: 'acme/widgets',
  worktree: '/w/widgets',
  branch: 'feat/x',
  session: 's',
  claimedAt: NOW - 60_000,
  heartbeatAt: NOW - 30_000,
  leaseUntil: NOW + 570_000,
  stale: false,
  ...over,
});

useWebEnv('/');

describe('card badges', () => {
  const cases = [
    ['claimed', view({ state: 'claimed', claim: claim() }), ['claimed']],
    ['stale', view({ state: 'stale', claim: claim({ stale: true, heartbeatAt: NOW - 2_400_000 }) }), ['stale']],
    ['unowned', view({ state: 'unowned', column: 'in_progress' }), ['unowned']],
    ['reopened', view({ reopened: true }), ['reopened']],
    ['unread', view({ unread: true }), ['unread']],
    ['claimed and unread', view({ state: 'claimed', claim: claim(), unread: true }), ['claimed', 'unread']],
    ['reopened and unread', view({ reopened: true, unread: true }), ['reopened', 'unread']],
    ['nothing', view(), []],
  ] as const;
  test.each(cases)('%s', async (_name, card, kinds) => {
    expect(badgesFor(card as never)).toEqual(kinds);
    const root = await mount(<CardBadges card={card as never} now={NOW} />);
    expect([...root.querySelectorAll('[data-badge]')].map((b) => (b as HTMLElement).dataset.badge)).toEqual(kinds);
  });

  test('each state has its own icon and its own words, so none depends on colour', async () => {
    const all = view({ state: 'claimed', claim: claim(), reopened: true, unread: true });
    const stale = view({ state: 'stale', claim: claim({ stale: true, heartbeatAt: NOW - 2_400_000 }) });
    const unowned = view({ state: 'unowned' });
    const text = new Map<string, string>();
    const icons = new Set<string>();
    for (const card of [all, stale, unowned]) {
      const root = await mount(<CardBadges card={card as never} now={NOW} />);
      for (const badge of root.querySelectorAll('[data-badge]')) {
        text.set((badge as HTMLElement).dataset.badge as string, badge.textContent);
        icons.add(badge.querySelector('svg')?.innerHTML ?? '');
      }
    }
    expect([...text.keys()].toSorted()).toEqual(['claimed', 'reopened', 'stale', 'unowned', 'unread']);
    expect(icons.size).toBe(5);
    expect(text.get('claimed')).toBe('nova · feat/x');
    expect(text.get('stale')).toBe('stale 40m · nova');
    expect(text.get('unowned')).toBe('unowned');
  });
});

const project = (id: string, c: object, lastEventAt: number) =>
  projectView(id, { name: id.toUpperCase(), lastEventAt, counts: counts(c) });

describe('dashboard', () => {
  const projects = [
    project('busy', { claimed: 3, unread: 2 }, NOW - 1000),
    project('stale', { stale: 1, claimed: 1 }, NOW - 9_000_000),
    project('reopened', { reopened: 2 }, NOW - 5_000_000),
    project('calm', {}, NOW - 100),
    project('unowned', { unowned: 1 }, NOW - 8_000_000),
  ];

  test('projects that need a person come first, then the most recently active', () => {
    expect(ordered(projects).map((p) => p.id)).toEqual(['reopened', 'unowned', 'stale', 'calm', 'busy']);
  });

  test('shows the five counts per project and "Needs you" only for stale, unowned or reopened work', async () => {
    stubApi({ 'GET /projects': { projects } });
    const root = await mount(<Dashboard />);
    await until(() => root.querySelector('.project-row'), 'the project rows');
    const rows = [...root.querySelectorAll<HTMLElement>('.project-row')];
    expect(rows.map((r) => r.dataset.project)).toEqual(['reopened', 'unowned', 'stale', 'calm', 'busy']);
    const needs = rows.filter((r) => r.querySelector('.needs-tag')).map((r) => r.dataset.project);
    expect(needs).toEqual(['reopened', 'unowned', 'stale']);
    const busy = rows.find((r) => r.dataset.project === 'busy') as HTMLElement;
    const read = (kind: string) => busy.querySelector(`[data-count="${kind}"] .chip-n`)?.textContent;
    expect(['claimed', 'stale', 'unowned', 'reopened', 'unread'].map(read)).toEqual(['3', '0', '0', '0', '2']);
    expect(busy.querySelector('[data-count="stale"]')?.classList.contains('zero')).toBe(true);
    expect(busy.querySelector('a')?.getAttribute('href')).toBe('/p/busy');
  });

  test('says how to start when there are no projects', async () => {
    stubApi({ 'GET /projects': { projects: [] } });
    const root = await mount(<Dashboard />);
    await until(() => root.querySelector('.empty-state'), 'the empty state');
    expect(root.querySelector('.empty-state')?.textContent).toMatch(/baton project register/);
  });

  test('registers a project and opens its board', async () => {
    const calls = stubApi({
      'GET /projects': { projects: [] },
      'POST /projects': { project: { id: 'new-one' }, created: true },
    });
    const root = await mount(<Dashboard />);
    await until(() => root.querySelector('form.register'), 'the form');
    await type(root.querySelector('form.register input') as HTMLInputElement, 'New one');
    await type(
      root.querySelector('form.register textarea') as HTMLTextAreaElement,
      'acme/a, https://github.com/acme/b.git',
    );
    submit(root.querySelector('form.register'));
    await until(() => location.pathname === '/p/new-one', 'navigation to the new board');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'New one',
      repos: ['acme/a', 'https://github.com/acme/b.git'],
    });
  });

  test("shows the board's refusal when a repo already belongs to another project", async () => {
    stubApi({
      'GET /projects': { projects: [] },
      'POST /projects': new Response(
        JSON.stringify({
          code: 'repo_taken',
          message: 'acme/a already belongs to project "Payments". Remove it there first.',
        }),
        { status: 409 },
      ),
    });
    const root = await mount(<Dashboard />);
    await until(() => root.querySelector('form.register'), 'the form');
    await type(root.querySelector('form.register input') as HTMLInputElement, 'Second');
    await type(root.querySelector('form.register textarea') as HTMLTextAreaElement, 'acme/a');
    submit(root.querySelector('form.register'));
    await until(() => root.querySelector('.register .error'), 'the refusal');
    expect(root.querySelector('.register .error')?.textContent).toMatch(/belongs to project "Payments"/);
    expect(location.pathname).toBe('/');
  });
});

describe('board', () => {
  const cards = [
    view({ id: 'a', title: 'Backlog card', column: 'backlog', pos: 'a' }),
    view({ id: 'b', title: 'Ready card', column: 'ready', pos: 'b', repo: 'acme/web' }),
    view({
      id: 'c',
      title: 'Taken card',
      column: 'in_progress',
      pos: 'c',
      state: 'claimed',
      claim: claim(),
      key: 'acme/widgets/taken',
    }),
    view({
      id: 'd',
      title: 'Stalled card',
      column: 'in_progress',
      pos: 'd',
      state: 'stale',
      claim: claim({ stale: true }),
    }),
    view({ id: 'e', title: 'Done card', column: 'done', pos: 'e' }),
  ];
  const widgets = projectView('widgets', {
    name: 'Widgets',
    repos: ['acme/widgets', 'acme/web'],
    lastEventAt: NOW,
    counts: counts({ claimed: 1, stale: 1 }),
  });
  const routes = (extra: Record<string, unknown> = {}) => ({
    'GET /projects': { projects: [widgets] },
    'GET /cards?project=widgets': { cards },
    'GET /cards?project=widgets&archived=1': {
      cards: [...cards, view({ id: 'z', title: 'Old card', archived: true })],
    },
    ...extra,
  });

  test("groups cards by column, shows counts and the project's summary", async () => {
    stubApi(routes());
    const root = await mount(<Board projectId="widgets" route={route()} />);
    await until(() => root.querySelector('.card'), 'cards');
    const columns = [...root.querySelectorAll<HTMLElement>('.column')].map((c) => [
      c.dataset.col,
      [...c.querySelectorAll('.card-title')].map((t) => t.textContent),
    ]);
    expect(columns).toEqual([
      ['backlog', ['Backlog card']],
      ['ready', ['Ready card']],
      ['in_progress', ['Taken card', 'Stalled card']],
      ['in_review', []],
      ['done', ['Done card']],
      ['blocked', []],
    ]);
    expect(root.querySelector('h1')?.textContent).toBe('Widgets');
    expect(root.querySelector('.count-row')?.textContent).toMatch(/1 claimed.*1 stale/);
    expect(root.querySelector('[data-state="stale"] [data-badge="stale"]')).toBeTruthy();
    expect(root.querySelector('[data-state="claimed"] [data-badge="claimed"]')).toBeTruthy();
  });

  test('filters by repo from the address, and names the repo on cards when there is more than one', async () => {
    stubApi(routes());
    const all = await mount(<Board projectId="widgets" route={route()} />);
    await until(() => all.querySelector('.card'), 'cards');
    expect(all.querySelectorAll('.card .repo').length).toBe(5);
    const filtered = await mount(<Board projectId="widgets" route={route('repo=acme%2Fweb')} />);
    await until(() => filtered.querySelector('.card'), 'filtered cards');
    expect([...filtered.querySelectorAll('.card-title')].map((t) => t.textContent)).toEqual(['Ready card']);
  });

  test('hides archived cards until asked', async () => {
    const calls = stubApi(routes());
    const root = await mount(<Board projectId="widgets" route={route()} />);
    await until(() => root.querySelector('.card'), 'cards');
    expect(root.textContent).not.toContain('Old card');
    const box = root.querySelector<HTMLInputElement>('.check input') as HTMLInputElement;
    box.click();
    await until(() => root.textContent?.includes('Old card'), 'the archived card');
    expect(calls.some((c) => c.path.endsWith('archived=1'))).toBe(true);
  });

  test('creates a card in the chosen repo and column', async () => {
    const calls = stubApi(routes({ 'POST /cards': { card: view(), created: true } }));
    const root = await mount(<Board projectId="widgets" route={route()} />);
    await until(() => root.querySelector('.card'), 'cards');
    button(root, 'New card').click();
    await until(() => root.querySelector('form.new-card'), 'the new-card form');
    const form = root.querySelector('form.new-card') as HTMLFormElement;
    await type(form.querySelector('input') as HTMLInputElement, 'Brand new');
    const [repo, column] = form.querySelectorAll('select');
    await choose(repo, 'acme/web');
    await choose(column, 'ready');
    submit(form);
    await until(() => calls.some((c) => c.method === 'POST'), 'the create call');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      repo: 'acme/web',
      title: 'Brand new',
      body: '',
      column: 'ready',
    });
  });

  test('the drawer shows who holds a stale card and where, and posts a comment and a move', async () => {
    const stale = view({
      id: 'd',
      title: 'Stalled card',
      column: 'in_progress',
      state: 'stale',
      claim: claim({ stale: true, heartbeatAt: NOW - 2_400_000, leaseUntil: NOW - 1_800_000 }),
      seq: 3,
    });
    const events = [
      { seq: 1, at: NOW - 3_000_000, actor: { kind: 'human', id: 'owner@example.test' }, type: 'created', payload: {} },
      {
        seq: 2,
        at: NOW - 2_900_000,
        actor: { kind: 'agent', id: 'nova' },
        type: 'claimed',
        payload: { worktree: '/w/widgets', branch: 'feat/x' },
      },
    ];
    const calls = stubApi(
      routes({
        'GET /cards/d': { card: stale },
        'GET /cards/d/events': { events, seq: 3 },
        'POST /cards/d/comments': { card: stale },
        'POST /cards/d/move': { card: stale },
      }),
    );
    const root = await mount(<Board projectId="widgets" route={route('card=d')} />);
    await until(() => root.querySelector('.drawer .facts'), 'the drawer');
    const facts = root.querySelector('.drawer .facts')?.textContent ?? '';
    expect(facts).toContain('nova');
    expect(facts).toContain('feat/x');
    expect(facts).toContain('/w/widgets');
    expect(facts).toMatch(/lease ran out/);
    expect(root.querySelector('.drawer [data-badge="stale"]')).toBeTruthy();
    expect(root.querySelector('.drawer .events')?.textContent).toMatch(/nova took it on feat\/x/);

    await type(root.querySelector('.comment-box textarea') as HTMLTextAreaElement, 'Please resume this one.');
    submit(root.querySelector('.comment-box'));
    await until(() => calls.some((c) => c.path.endsWith('/comments')), 'the comment call');
    expect(calls.find((c) => c.path.endsWith('/comments'))?.body).toEqual({ text: 'Please resume this one.' });

    await choose(root.querySelector('.move-row select') as HTMLSelectElement, 'ready');
    await until(() => calls.some((c) => c.path.endsWith('/move')), 'the move call');
    expect(calls.find((c) => c.path.endsWith('/move'))?.body).toEqual({ to: 'ready' });
  });

  test('a card id taken from the address is escaped in the request paths', async () => {
    const calls = stubApi(routes());
    await mount(<Board projectId="widgets" route={route('card=a%2Fb%3Fx')} />);
    await until(() => calls.some((c) => c.path.endsWith('/events')), 'the drawer requests');
    const paths = calls.map((c) => c.path);
    expect(paths).toContain('/api/human/cards/a%2Fb%3Fx');
    expect(paths).toContain('/api/human/cards/a%2Fb%3Fx/events');
  });

  test('says so when the project does not exist', async () => {
    stubApi({ 'GET /projects': { projects: [] }, 'GET /cards?project=widgets': { cards: [] } });
    const root = await mount(<Board projectId="widgets" route={route()} />);
    await until(() => root.querySelector('h1')?.textContent === 'No such project', 'the message');
  });
});

describe('agents page', () => {
  test('issues a token, shows it once, and revokes it', async () => {
    let agents = [
      {
        id: 'laptop',
        name: 'laptop',
        createdAt: NOW,
        tokens: [{ tokenId: 't1', label: 'first token', createdAt: NOW }],
      },
    ];
    const calls = stubApi({
      'GET /agents': () => ({ agents }),
      'POST /agents/laptop/tokens': { token: 'baton_secret_value', tokenId: 't2', agentId: 'laptop', label: 'x' },
      'DELETE /agents/laptop/tokens/t1': () => {
        agents = [{ ...(agents[0] as (typeof agents)[number]), tokens: [] }];
        return { revoked: 't1' };
      },
    });
    const root = await mount(<Agents />);
    await until(() => root.querySelector('.agent'), 'the agent');
    expect(root.textContent).not.toContain('baton_secret_value');
    button(root, 'New token').click();
    await until(() => root.querySelector('[data-testid="token"]'), 'the token');
    expect(root.querySelector('[data-testid="token"]')?.textContent).toBe('baton_secret_value');
    expect(root.querySelector('.snippet')?.textContent).toContain('BATON_TOKEN=baton_secret_value');
    button(root, 'I have stored it').click();
    await until(() => !root.querySelector('[data-testid="token"]'), 'the token to be hidden');
    [...root.querySelectorAll('button')].find((b) => b.getAttribute('aria-label')?.startsWith('Revoke'))?.click();
    await until(() => calls.some((c) => c.method === 'DELETE'), 'the revoke call');
    await until(() => !root.textContent?.includes('first token'), 'the token to leave the list');
  });
});

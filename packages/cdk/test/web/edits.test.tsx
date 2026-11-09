// Requirement 6: a person edits and archives cards, and renames, re-points and archives projects, from the page. Each action
// calls its route once with only what changed, and a declined confirmation calls nothing.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setApiConfig } from '../../web/src/api.ts';
import { Board } from '../../web/src/board.tsx';
import { Toasts } from '../../web/src/toast.tsx';
import { mount, settle, stubApi, until, view } from './support.tsx';

const NOW = Date.now();
const project = {
  id: 'widgets',
  name: 'Widgets',
  repos: ['acme/widgets', 'acme/web'],
  archived: false,
  lastEventAt: NOW,
  createdAt: 1,
  counts: { total: 1, claimed: 0, stale: 0, unowned: 0, reopened: 0, unread: 0, inReview: 0 },
};
const card = view({ id: 'a', title: 'Original title', body: 'Original details', column: 'ready' });
const routes = (extra: Record<string, unknown> = {}) => ({
  'GET /projects': { projects: [project] },
  'GET /cards?project=widgets': { cards: [card] },
  'GET /cards/a': { card },
  'GET /cards/a/events': { events: [], seq: 1 },
  ...extra,
});
const open = (query = '') => ({ path: '/p/widgets', query: new URLSearchParams(query) });
const type = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
};
const submit = (form: Element | null) => form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const button = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

beforeEach(() => {
  setApiConfig({ apiUrl: '/api' });
  history.replaceState(null, '', '/p/widgets');
  vi.stubGlobal('confirm', () => true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('editing a card', () => {
  test('saves only the field that changed, and the button waits until something changed', async () => {
    const calls = stubApi(routes({ 'PATCH /cards/a': { card } }));
    const root = await mount(<Board projectId="widgets" route={open('card=a')} />);
    await until(() => root.querySelector('form.edit'), 'the edit form');
    const save = button(root, 'Save changes');
    expect(save.disabled).toBe(true);
    await type(root.querySelector('form.edit input') as HTMLInputElement, 'Renamed title');
    expect(save.disabled).toBe(false);
    submit(root.querySelector('form.edit'));
    await until(() => calls.some((c) => c.method === 'PATCH'), 'the edit call');
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    expect(calls.find((c) => c.method === 'PATCH')?.path).toBe('/api/human/cards/a');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ title: 'Renamed title' });
  });

  test('the details are saved on their own', async () => {
    const calls = stubApi(routes({ 'PATCH /cards/a': { card } }));
    const root = await mount(<Board projectId="widgets" route={open('card=a')} />);
    await until(() => root.querySelector('form.edit'), 'the edit form');
    await type(root.querySelector('form.edit textarea') as HTMLTextAreaElement, 'New details');
    submit(root.querySelector('form.edit'));
    await until(() => calls.some((c) => c.method === 'PATCH'), 'the edit call');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ body: 'New details' });
  });

  test("a refusal shows the board's message and keeps what was typed", async () => {
    stubApi(
      routes({
        'PATCH /cards/a': () =>
          new Response(JSON.stringify({ code: 'invalid_request', message: 'The title is too long. Shorten it.' }), {
            status: 400,
          }),
      }),
    );
    const root = await mount(
      <>
        <Board projectId="widgets" route={open('card=a')} />
        <Toasts />
      </>,
    );
    await until(() => root.querySelector('form.edit'), 'the edit form');
    const title = root.querySelector('form.edit input') as HTMLInputElement;
    await type(title, 'Something');
    submit(root.querySelector('form.edit'));
    await until(() => document.body.textContent?.includes('The title is too long. Shorten it.'), 'the refusal');
    expect((root.querySelector('form.edit input') as HTMLInputElement).value).toBe('Something');
  });
});

describe('archiving a card', () => {
  test('asks first, then calls the archive route once', async () => {
    const calls = stubApi(routes({ 'POST /cards/a/archive': { card: { ...card, archived: true } } }));
    const confirmed = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmed);
    const root = await mount(<Board projectId="widgets" route={open('card=a')} />);
    await until(() => root.querySelector('.move-row'), 'the drawer');
    button(root, 'Archive').click();
    await until(() => calls.some((c) => c.path.endsWith('/archive')), 'the archive call');
    expect(confirmed).toHaveBeenCalledWith(expect.stringContaining('Original title'));
    expect(calls.filter((c) => c.path.endsWith('/archive'))).toHaveLength(1);
  });

  test('declining the question calls nothing', async () => {
    const calls = stubApi(routes());
    vi.stubGlobal('confirm', () => false);
    const root = await mount(<Board projectId="widgets" route={open('card=a')} />);
    await until(() => root.querySelector('.move-row'), 'the drawer');
    button(root, 'Archive').click();
    await settle(50);
    expect(calls.some((c) => c.path.endsWith('/archive'))).toBe(false);
  });
});

describe('project settings', () => {
  const openSettings = async (extra: Record<string, unknown>) => {
    const calls = stubApi(routes(extra));
    const root = await mount(
      <>
        <Board projectId="widgets" route={open()} />
        <Toasts />
      </>,
    );
    await until(() => root.querySelector('.card'), 'cards');
    button(root, 'Settings').click();
    await until(() => root.querySelector('.settings'), 'the settings panel');
    return { calls, root };
  };

  test('renames the project', async () => {
    const { calls, root } = await openSettings({ 'PATCH /projects/widgets': { project } });
    const rename = button(root, 'Rename');
    expect(rename.disabled).toBe(true);
    await type(root.querySelector('.settings input') as HTMLInputElement, 'Gadgets');
    submit(root.querySelector('.settings form'));
    await until(() => calls.some((c) => c.method === 'PATCH'), 'the rename call');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Gadgets' });
  });

  test('adds a repo, trimmed, from a name or a clone address', async () => {
    const { calls, root } = await openSettings({ 'PATCH /projects/widgets': { project } });
    const forms = root.querySelectorAll('.settings form');
    await type(forms[1]?.querySelector('input') as HTMLInputElement, '  git@github.com:acme/api.git ');
    submit(forms[1] ?? null);
    await until(() => calls.some((c) => c.method === 'PATCH'), 'the add call');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ addRepos: ['git@github.com:acme/api.git'] });
  });

  test('removes a repo after asking, and not when declined', async () => {
    const { calls, root } = await openSettings({ 'PATCH /projects/widgets': { project } });
    vi.stubGlobal('confirm', () => false);
    (root.querySelector('[aria-label="Remove acme/web"]') as HTMLButtonElement).click();
    await settle(50);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    vi.stubGlobal('confirm', () => true);
    (root.querySelector('[aria-label="Remove acme/web"]') as HTMLButtonElement).click();
    await until(() => calls.some((c) => c.method === 'PATCH'), 'the remove call');
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ removeRepos: ['acme/web'] });
  });

  test('archives the project and goes back to the dashboard', async () => {
    const { calls, root } = await openSettings({ 'POST /projects/widgets/archive': { project } });
    button(root, 'Archive project').click();
    await until(() => calls.some((c) => c.path.endsWith('/projects/widgets/archive')), 'the archive call');
    await until(() => location.pathname === '/', 'the dashboard address');
  });

  test("a refusal to archive (a claim is held) shows the board's message and stays on the board", async () => {
    const { root } = await openSettings({
      'POST /projects/widgets/archive': () =>
        new Response(
          JSON.stringify({
            code: 'project_has_claims',
            message: 'Cards are claimed. Wait for the agents to pass or drop them, then archive.',
          }),
          { status: 409 },
        ),
    });
    button(root, 'Archive project').click();
    await until(() => document.body.textContent?.includes('Wait for the agents to pass or drop them'), 'the refusal');
    expect(location.pathname).toBe('/p/widgets');
  });
});

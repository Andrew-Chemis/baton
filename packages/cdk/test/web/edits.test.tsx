// Requirement 6: a person edits and archives cards, and renames, re-points and archives projects, from the page. Each action
// calls its route once with only what changed, and a declined confirmation calls nothing.
import { describe, expect, test, vi } from 'vitest';
import { Board } from '../../web/src/board.tsx';
import { Toasts } from '../../web/src/toast.tsx';
import {
  button,
  counts,
  mount,
  projectView,
  route,
  settle,
  stubApi,
  submit,
  type,
  until,
  useWebEnv,
  view,
} from './support.tsx';

const project = projectView('widgets', {
  name: 'Widgets',
  repos: ['acme/widgets', 'acme/web'],
  lastEventAt: Date.now(),
  counts: counts({ total: 1 }),
});
const card = view({ id: 'a', title: 'Original title', body: 'Original details', column: 'ready' });
const routes = (extra: Record<string, unknown> = {}) => ({
  'GET /projects': { projects: [project] },
  'GET /cards?project=widgets': { cards: [card] },
  'GET /cards/a': { card },
  'GET /cards/a/events': { events: [], seq: 1 },
  ...extra,
});

useWebEnv('/p/widgets');

describe('editing a card', () => {
  test('saves only the field that changed, and the button waits until something changed', async () => {
    const calls = stubApi(routes({ 'PATCH /cards/a': { card } }));
    const root = await mount(<Board projectId="widgets" route={route('card=a')} />);
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
    const root = await mount(<Board projectId="widgets" route={route('card=a')} />);
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
        <Board projectId="widgets" route={route('card=a')} />
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
    const root = await mount(<Board projectId="widgets" route={route('card=a')} />);
    await until(() => root.querySelector('.move-row'), 'the drawer');
    button(root, 'Archive').click();
    await until(() => calls.some((c) => c.path.endsWith('/archive')), 'the archive call');
    expect(confirmed).toHaveBeenCalledWith(expect.stringContaining('Original title'));
    expect(calls.filter((c) => c.path.endsWith('/archive'))).toHaveLength(1);
  });

  test('declining the question calls nothing', async () => {
    const calls = stubApi(routes());
    vi.stubGlobal('confirm', () => false);
    const root = await mount(<Board projectId="widgets" route={route('card=a')} />);
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
        <Board projectId="widgets" route={route()} />
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

import { act } from 'preact/test-utils';
import { render } from 'preact';
import type { ComponentChild } from 'preact';
import { afterEach, beforeEach, vi } from 'vitest';
import { setApiConfig } from '../../web/src/api.ts';
import type { ProjectCounts, ProjectView } from '../../web/src/types.ts';

/** What a request body was: parsed when it is JSON, else the text (the token endpoint takes a form). */
function parseBody(body: BodyInit | null | undefined): unknown {
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof body !== 'string' || body === '') return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

export interface Stub {
  method: string;
  path: string;
  body?: unknown;
  headers: Headers;
}

/** A fetch that answers from a table of "METHOD /path" to JSON, and records what it was asked. */
export function stubApi(routes: Record<string, unknown>) {
  const calls: Stub[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init?.method ?? 'GET';
      const stub: Stub = {
        method,
        path: `${url.pathname}${url.search}`,
        body: parseBody(init?.body),
        headers: new Headers(init?.headers),
      };
      calls.push(stub);
      const key = `${method} ${url.pathname.replace('/api/human', '')}${url.search}`;
      const bare = `${method} ${url.pathname.replace('/api/human', '')}`;
      const hit = key in routes ? routes[key] : routes[bare];
      if (hit === undefined)
        return new Response(JSON.stringify({ code: 'not_found', message: `no stub for ${key}` }), { status: 404 });
      const out = typeof hit === 'function' ? (hit as (s: Stub) => unknown)(stub) : hit;
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

export async function mount(node: ComponentChild): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  await act(() => render(node, container));
  return container;
}

export async function settle(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

export async function until(check: () => unknown, label: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await settle(10);
    if (check()) return;
  }
  throw new Error(`timed out waiting for ${label}`);
}

export const view = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  projectId: 'p1',
  key: 'acme/widgets/one',
  title: 'One',
  repo: 'acme/widgets',
  column: 'ready',
  pos: 'n',
  seq: 1,
  lastHumanSeq: 0,
  lastAgentId: null,
  ackedSeq: 0,
  reopened: false,
  archived: false,
  links: [],
  claim: null,
  lastClaim: null,
  state: 'unclaimed',
  unread: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

/** What every page test starts from: the api at /api, the address at `path`, window.confirm saying yes; put back afterwards. */
export function useWebEnv(path: string): void {
  beforeEach(() => {
    setApiConfig({ apiUrl: '/api' });
    history.replaceState(null, '', path);
    vi.stubGlobal('confirm', () => true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });
}

export const counts = (over: Partial<ProjectCounts> = {}): ProjectCounts => ({
  total: 4,
  claimed: 0,
  stale: 0,
  unowned: 0,
  reopened: 0,
  unread: 0,
  inReview: 0,
  ...over,
});

export const projectView = (id: string, over: Partial<ProjectView> = {}): ProjectView => ({
  id,
  name: id,
  repos: [`acme/${id}`],
  archived: false,
  lastEventAt: 1,
  createdAt: 1,
  counts: counts(),
  ...over,
});

/** The address props a board takes: /p/widgets with the given query. */
export const route = (query = '') => ({ path: '/p/widgets', query: new URLSearchParams(query) });

/** Fill a field as a person would: set it, tell the page, and let the page redraw. */
export async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

/** Choose an option in a select. */
export async function choose(select: HTMLSelectElement | undefined, value: string): Promise<void> {
  (select as HTMLSelectElement).value = value;
  select?.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
}

export const submit = (form: Element | null | undefined) =>
  form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

export const button = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;

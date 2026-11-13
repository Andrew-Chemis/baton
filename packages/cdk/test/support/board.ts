// A board for one test file: a real table in DynamoDB Local (or whatever DYNAMODB_ENDPOINT names), a clock the test moves,
// and callers that go through the same router the Lambda uses.
import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import { AGENT_PREFIX, HUMAN_PREFIX } from '../../src/schema.ts';
import { configFor } from '../../service/config.ts';
import { authorize, handleHttp, type HttpEvent } from '../../service/router.ts';
import { createDocClient, type Deps } from '../../service/store.ts';
import { httpEvent } from './http-event.ts';
import { createTable } from './table.ts';

export const T0 = Date.parse('2026-01-01T00:00:00Z');
export const MINUTE = 60_000;

export interface Clock {
  now: () => number;
  advance: (ms: number) => void;
}

export function makeClock(start = T0): Clock {
  let current = start;
  return { now: () => current, advance: (ms) => void (current += ms) };
}

/** A person is in the admin group unless `admin: false`. */
export type Who = { human: string; admin?: boolean } | { agent: string };

export interface Result<T = Record<string, any>> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

export interface Board {
  deps: Deps;
  clock: Clock;
  table: string;
  /** Calls a route as a person or as an agent whose token the gateway has already accepted. */
  as: (who: Who) => Caller;
  /** Calls an agent route with a real token through the real authorizer. */
  withToken: (token: string) => Caller;
}

export interface Caller {
  get: (path: string) => Promise<Result>;
  post: (path: string, body?: unknown, key?: string) => Promise<Result>;
  patch: (path: string, body?: unknown, key?: string) => Promise<Result>;
  del: (path: string, key?: string) => Promise<Result>;
}

export async function newBoard(options: { leaseMs?: number; heartbeatSeconds?: number } = {}): Promise<Board> {
  const endpoint = inject('dynamodbEndpoint');
  // Explicit, so credentials in the environment (a session token for a real account, say) can never reach a test.
  const credentials = { accessKeyId: 'local', secretAccessKey: 'local' };
  const region = 'us-west-2';
  const table = `baton-test-${randomBytes(6).toString('hex')}`;
  await createTable({ endpoint, region, credentials }, table);
  const clock = makeClock();
  const deps: Deps = {
    db: createDocClient({ endpoint, region, credentials }),
    config: configFor(table, options),
    now: clock.now,
  };

  type Context = HttpEvent['requestContext']['authorizer'];
  const call = async (
    kind: 'human' | 'agent',
    context: Context,
    method: string,
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<Result> => {
    const event = httpEvent(method, `${kind === 'human' ? HUMAN_PREFIX : AGENT_PREFIX}${path}`, {
      headers: key ? { 'Idempotency-Key': key } : {},
      body: body === undefined ? undefined : JSON.stringify(body),
      authorizer: context,
    });
    const out = await handleHttp(deps, event);
    return { status: out.statusCode, body: JSON.parse(out.body) as Record<string, any>, headers: out.headers };
  };
  // `context` may be worked out per call, as when the gateway's authorizer judges the token afresh each time.
  const caller = (kind: 'human' | 'agent', context: Context | (() => Promise<Context>)): Caller => {
    const send = async (method: string, path: string, body?: unknown, key?: string) =>
      call(kind, typeof context === 'function' ? await context() : context, method, path, body, key);
    return {
      get: (path) => send('GET', path),
      post: (path, body, key) => send('POST', path, body ?? {}, key),
      patch: (path, body, key) => send('PATCH', path, body ?? {}, key),
      del: (path, key) => send('DELETE', path, undefined, key),
    };
  };

  return {
    deps,
    clock,
    table,
    as: (who) =>
      'human' in who
        ? caller('human', {
            jwt: {
              claims: {
                sub: `sub-${who.human}`,
                email: who.human,
                ...(who.admin === false ? {} : { 'cognito:groups': '[admins]' }),
              },
            },
          })
        : caller('agent', { lambda: { verdict: 'ok', agentId: who.agent } }),
    // Goes through the authorizer exactly as API Gateway would: the verdict it returns becomes the request context.
    withToken: (token) =>
      caller('agent', async () => ({
        lambda: (
          await authorize(deps, {
            type: 'REQUEST',
            routeArn: 'arn-for-test',
            headers: { authorization: `Bearer ${token}` },
          })
        ).context,
      })),
  };
}

export const REPO = 'acme/widgets';

export interface Seeded {
  board: Board;
  human: Caller;
  projectId: string;
}

/** A board with one project holding REPO. */
export async function seeded(options: Parameters<typeof newBoard>[0] = {}): Promise<Seeded> {
  const board = await newBoard(options);
  const human = board.as({ human: 'owner@example.test' });
  const created = await human.post('/projects', { name: 'Widgets', repos: [REPO] });
  if (created.status !== 201) throw new Error(`seed failed: ${JSON.stringify(created.body)}`);
  return { board, human, projectId: created.body.project.id as string };
}

export const claimBody = (over: Record<string, unknown> = {}) => ({
  repo: REPO,
  worktree: '/work/widgets',
  branch: 'feature/one',
  session: 's1',
  ...over,
});

export async function newCard(c: Caller, over: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const out = await c.post('/cards', { repo: REPO, title: 'A card', ...over });
  if (out.status !== 201 && out.status !== 200) throw new Error(`card failed: ${JSON.stringify(out.body)}`);
  return out.body.card as Record<string, any>;
}

/** A card's events, oldest first, as `caller` reads them. */
export async function eventsOf(caller: Caller, id: string, since = 0): Promise<any[]> {
  return (await caller.get(`/cards/${id}/events?since=${since}`)).body.events as any[];
}

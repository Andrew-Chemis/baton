// Turns an API Gateway HTTP API event into a call on the modules and the result back into a response.
//
// Authentication happens at the gateway, once per prefix: /api/human/* sits behind the Cognito JWT authorizer and
// /api/agent/* behind the bearer-token authorizer, so a route never has to accept both credentials. The checks here read what
// the gateway attached to the request and refuse anything that is missing, so a mis-wired route fails closed.
import { AGENT_PREFIX, HUMAN_PREFIX, MAX_BODY_BYTES } from '../src/schema.ts';
import type { Actor, ActorKind } from './api-types.ts';
import { COLUMNS } from './api-types.ts';
import { createAgent, createToken, deleteAgent, listAgents, revokeToken, verifyToken } from './agents.ts';
import { timingOf } from './config.ts';
import { archiveCard, commentCard, createCard, getCard, listCards, listEvents, patchCard } from './cards.ts';
import { ackCard, claimCard, heartbeatCard, moveCard, releaseCard } from './claims.ts';
import { idempotencyOf, type Reply, type RequestCtx } from './engine.ts';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from './errors.ts';
import { archiveProject, listProjects, patchProject, registerProject } from './projects.ts';
import type { Deps } from './store.ts';
import { metricsOf } from './telemetry.ts';

export interface HttpEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string | undefined;
  isBase64Encoded?: boolean;
  requestContext: {
    /** API Gateway's id for the request; it is also in the access log, so one id finds both lines. */
    requestId?: string;
    http: { method: string };
    authorizer?: {
      jwt?: { claims?: Record<string, unknown> };
      lambda?: Record<string, unknown>;
    };
  };
}

export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

interface Call {
  deps: Deps;
  ctx: RequestCtx;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

/** `admin` is a person in the board's admin group: agent and token management is theirs alone. */
type Who = ActorKind | 'both' | 'admin';
interface Route {
  /** `METHOD /path/:param`, as logged. */
  name: string;
  method: string;
  segments: string[];
  who: Who;
  run: (call: Call) => Promise<Reply>;
}

const ok = (body: unknown, status = 200): Promise<Reply> => Promise.resolve({ status, body });

/** Adapts a module function that takes the card, project or agent id after the context into a route handler. */
const byId =
  (fn: (deps: Deps, ctx: RequestCtx, id: string, body: unknown) => Promise<Reply>): Route['run'] =>
  ({ deps, ctx, params, body }) =>
    fn(deps, ctx, params.id as string, body);

const route = (method: string, path: string, who: Who, run: Route['run']): Route => ({
  name: `${method} ${path}`,
  method,
  segments: path.split('/').filter(Boolean),
  who,
  run,
});

const ROUTES: Route[] = [
  route('GET', '/config', 'both', ({ deps }) => ok({ ...timingOf(deps.config), columns: COLUMNS })),
  route('GET', '/projects', 'both', async ({ deps, query }) =>
    ok(await listProjects(deps, { repo: query.get('repo') ?? undefined, counts: query.get('counts') !== '0' })),
  ),
  route('POST', '/projects', 'both', ({ deps, ctx, body }) => registerProject(deps, ctx, body)),
  route('PATCH', '/projects/:id', 'both', byId(patchProject)),
  route('POST', '/projects/:id/archive', 'both', byId(archiveProject)),

  route('GET', '/cards', 'both', async ({ deps, ctx, query }) =>
    ok(
      await listCards(deps, ctx.actor, {
        project: query.get('project') ?? undefined,
        repo: query.get('repo') ?? undefined,
        column: query.get('column') ?? undefined,
        key: query.get('key') ?? undefined,
        archived: query.get('archived') === 'true' || query.get('archived') === '1',
        attention: query.get('attention') === 'me',
      }),
    ),
  ),
  route('POST', '/cards', 'both', ({ deps, ctx, body }) => createCard(deps, ctx, body)),
  route('GET', '/cards/:id', 'both', async ({ deps, params }) => ok(await getCard(deps, params.id as string))),
  route('PATCH', '/cards/:id', 'both', byId(patchCard)),
  route('POST', '/cards/:id/move', 'both', byId(moveCard)),
  route('POST', '/cards/:id/comments', 'both', byId(commentCard)),
  route('GET', '/cards/:id/events', 'both', async ({ deps, params, query }) => {
    const since = Number(query.get('since') ?? 0);
    if (!Number.isInteger(since) || since < 0)
      throw badRequest('since must be a whole number: the last sequence you have read.');
    return ok(await listEvents(deps, params.id as string, since));
  }),
  route('POST', '/cards/:id/claim', 'agent', byId(claimCard)),
  route('POST', '/cards/:id/heartbeat', 'agent', byId(heartbeatCard)),
  route('POST', '/cards/:id/ack', 'agent', byId(ackCard)),
  route('POST', '/cards/:id/release', 'agent', byId(releaseCard)),
  route('POST', '/cards/:id/archive', 'human', byId(archiveCard)),

  route('GET', '/agents', 'admin', async ({ deps }) => ok(await listAgents(deps))),
  route('POST', '/agents', 'admin', ({ deps, ctx, body }) => createAgent(deps, ctx, body)),
  route('DELETE', '/agents/:id', 'admin', byId(deleteAgent)),
  route('POST', '/agents/:id/tokens', 'admin', byId(createToken)),
  route('DELETE', '/agents/:id/tokens/:tokenId', 'admin', ({ deps, ctx, params }) =>
    revokeToken(deps, ctx, params.id as string, params.tokenId as string),
  ),
];

/** A path segment with its %-escapes undone; a stray % is the caller's mistake, not the board's. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw badRequest(
      `The address contains "${segment}", which has a % that is not followed by two hex digits. Write a literal % as %25.`,
    );
  }
}

function match(method: string, segments: string[]): { route: Route; params: Record<string, string> } | undefined {
  for (const r of ROUTES) {
    if (r.method !== method || r.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const fits = r.segments.every((s, i) => {
      const actual = segments[i] as string;
      if (s.startsWith(':')) {
        params[s.slice(1)] = decodeSegment(actual);
        return true;
      }
      return s === actual;
    });
    if (fits) return { route: r, params };
  }
  return undefined;
}

function resolveActor(event: HttpEvent, kind: ActorKind): Actor {
  if (kind === 'human') {
    const claims = event.requestContext.authorizer?.jwt?.claims;
    const sub = typeof claims?.sub === 'string' ? claims.sub : undefined;
    if (!sub) throw unauthorized('Sign in again: this call needs a Cognito ID token in the Authorization header.');
    return { kind: 'human', id: typeof claims?.email === 'string' && claims.email ? claims.email : sub };
  }
  const context = event.requestContext.authorizer?.lambda;
  if (context?.verdict === 'expired') {
    throw new ApiError(
      'token_expired',
      'This token has expired. Ask the human to issue a new one on the Agents page, then set BATON_TOKEN.',
    );
  }
  if (context?.verdict === 'revoked') {
    throw new ApiError(
      'token_revoked',
      'This token was revoked. Ask the human to issue a new one on the Agents page, then set BATON_TOKEN.',
    );
  }
  if (context?.verdict !== 'ok' || typeof context.agentId !== 'string') {
    throw unauthorized(
      'Send a valid agent token as `Authorization: Bearer <token>`. Set BATON_TOKEN, or ask the human to issue one on the Agents page.',
    );
  }
  return { kind: 'agent', id: context.agentId };
}

const header = (source: { headers?: Record<string, string | undefined> }, name: string): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(source.headers ?? {})) if (k.toLowerCase() === wanted) return v;
  return undefined;
};

/** Where each caller kind's routes live: the gateway puts a different authorizer in front of each. */
const PREFIX: Record<ActorKind, string> = { human: HUMAN_PREFIX, agent: AGENT_PREFIX };

function respond(status: number, body: unknown, extra: Record<string, string> = {}): HttpResult {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
    body: JSON.stringify(body),
  };
}

/** What the request log records about a request as it goes: filled in by `serve`, read once at the end. */
interface Trace {
  route?: string;
  actor?: Actor;
}

export async function handleHttp(deps: Deps, event: HttpEvent): Promise<HttpResult> {
  const started = performance.now();
  const requestId = event.requestContext.requestId;
  const trace: Trace = {};
  const { result, body, replayed } = await serve(deps, event, trace, requestId);
  if (requestId) result.headers['x-request-id'] = requestId;
  const code = typeof (body as { code?: unknown }).code === 'string' ? (body as { code: string }).code : undefined;
  deps.telemetry?.request({
    requestId,
    method: event.requestContext.http.method.toUpperCase(),
    route: trace.route,
    status: result.statusCode,
    code: result.statusCode >= 400 ? code : undefined,
    durationMs: Math.round(performance.now() - started),
    // A person is logged by their Cognito subject, never their email.
    actor: trace.actor && {
      kind: trace.actor.kind,
      id: trace.actor.kind === 'human' ? subjectOf(event) : trace.actor.id,
    },
    // A replay answers with a stored body; counting it again would count one claim twice.
    metrics: replayed ? [] : metricsOf(trace.route, result.statusCode, code, body),
  });
  return result;
}

/**
 * The person's Cognito groups. The HTTP API's JWT authorizer hands an array claim to the function as one string, `[a b]`;
 * a direct invocation may pass the array itself.
 */
export function groupsOf(event: HttpEvent): string[] {
  const raw = event.requestContext.authorizer?.jwt?.claims?.['cognito:groups'];
  if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string');
  if (typeof raw !== 'string') return [];
  return raw
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

const subjectOf = (event: HttpEvent): string => {
  const sub = event.requestContext.authorizer?.jwt?.claims?.sub;
  return typeof sub === 'string' ? sub : 'unknown';
};

async function serve(
  deps: Deps,
  event: HttpEvent,
  trace: Trace,
  requestId: string | undefined,
): Promise<{ result: HttpResult; body: unknown; replayed?: boolean }> {
  try {
    const path = event.rawPath;
    const kind = (Object.keys(PREFIX) as ActorKind[]).find((k) => path.startsWith(`${PREFIX[k]}/`));
    if (!kind)
      throw notFound(
        `No such path ${path}. The API lives under ${HUMAN_PREFIX}/ (web app) and ${AGENT_PREFIX}/ (agents).`,
      );
    const actor = resolveActor(event, kind);
    trace.actor = actor;
    const method = event.requestContext.http.method.toUpperCase();
    const segments = path.slice(PREFIX[kind].length).split('/').filter(Boolean);
    const found = match(method, segments);
    if (!found) throw notFound(`No route ${method} ${path}.`);
    trace.route = found.route.name;
    if (found.route.who === 'admin') {
      if (kind !== 'human')
        throw forbidden(
          `${method} ${segments.join('/')} is for people signed in to the web app, under ${HUMAN_PREFIX}/.`,
        );
      if (!groupsOf(event).includes(deps.config.adminGroup)) {
        throw forbidden(
          `Managing agents and tokens is for the board's admins. Ask an admin to add you to the "${deps.config.adminGroup}" group in the user pool.`,
        );
      }
    } else if (found.route.who !== 'both' && found.route.who !== kind) {
      throw forbidden(
        found.route.who === 'agent'
          ? `${method} ${segments.join('/')} is for agents: call it with an agent token under ${AGENT_PREFIX}/.`
          : `${method} ${segments.join('/')} is for people signed in to the web app, under ${HUMAN_PREFIX}/.`,
      );
    }
    let rawBody = event.body;
    if (rawBody && event.isBase64Encoded) rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
    if (rawBody && Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
      throw new ApiError(
        'payload_too_large',
        `The request body is over ${MAX_BODY_BYTES / 1024} KiB. A card body holds at most 20,000 characters; send less.`,
      );
    }
    let body: unknown;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw badRequest('The request body is not valid JSON.');
      }
    }
    const ctx: RequestCtx = { actor, idem: idempotencyOf(method, path, rawBody, header(event, 'idempotency-key')) };
    const query = new URLSearchParams(event.rawQueryString ?? '');
    const reply = await found.route.run({ deps, ctx, params: found.params, query, body });
    return {
      result: respond(reply.status, reply.body, reply.replayed ? { 'idempotent-replayed': 'true' } : {}),
      body: reply.body,
      replayed: reply.replayed === true,
    };
  } catch (error) {
    if (error instanceof ApiError) return { result: respond(error.status, error.body), body: error.body };
    // Never log bodies or headers: they may carry tokens. `console.error` with the error itself lets the Lambda's JSON log
    // format record its type and stack as fields.
    console.error('unhandled error', { requestId, route: trace.route }, error);
    const body = {
      code: 'internal',
      message:
        'The board hit an unexpected error. Repeat the request; it is safe to retry with the same Idempotency-Key. ' +
        `If it keeps failing, tell the human${requestId ? ` and quote request ${requestId}` : ''}.`,
    };
    return { result: respond(500, body), body };
  }
}

export interface AuthorizerEvent {
  type: 'REQUEST';
  routeArn: string;
  headers?: Record<string, string | undefined>;
}

export interface AuthorizerResult {
  isAuthorized: boolean;
  context: Record<string, string>;
}

/**
 * The bearer-token authorizer. It always authorizes a request that carries an Authorization header and records the verdict,
 * because an HTTP API cannot customize a denial: a deny reaches the agent as a bare 403 with no code and no next step. The
 * handler refuses anything whose verdict is not `ok`, before it runs a route. API Gateway caches the result for five minutes,
 * which is the longest a revoked token keeps working.
 */
export async function authorize(deps: Deps, event: AuthorizerEvent): Promise<AuthorizerResult> {
  const value = header(event, 'authorization') ?? '';
  const bearer = /^Bearer\s+(\S+)$/i.exec(value)?.[1] ?? '';
  const verdict = await verifyToken(deps, bearer);
  return {
    isAuthorized: true,
    context: verdict.verdict === 'ok' ? { verdict: 'ok', agentId: verdict.agentId } : { verdict: verdict.verdict },
  };
}

// One way to write: build the items for an attempt, add the idempotency item, commit them in a single transaction, and on a
// lost race read again and decide again. The conditions in the transaction are what decides a race; the code before it only
// produces good messages from a snapshot.
import { hash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Actor } from './api-types.ts';
import { ApiError, badRequest } from './errors.ts';
import { idempotencyKey } from './keys.ts';
import type { IdempotencyItem } from './items.ts';
import { Cancelled, getItem, putItem, transact, type Deps, type TransactItem } from './store.ts';

export interface Reply {
  status: number;
  body: unknown;
  /** What an idempotent replay returns, when the first response held a secret that must not be stored. */
  stored?: unknown;
  replayed?: boolean;
}

export interface RequestCtx {
  actor: Actor;
  idem?: { key: string; fingerprint: string } | undefined;
}

export interface Attempt {
  items: TransactItem[];
  reply: Reply;
  /** Indexes into `items` whose failed condition means "someone else got there first: read again and decide again". */
  retryOn?: number[];
  /** Turns a cancellation into a refusal the caller can act on. Return undefined to fall through to the generic handling. */
  classify?: (cancelled: Cancelled) => ApiError | 'retry' | undefined | Promise<ApiError | 'retry' | undefined>;
}

const MAX_ATTEMPTS = 8;
const IDEMPOTENCY_MS = 24 * 60 * 60 * 1000;

const KEY_PATTERN = /^[\w.:-]{1,200}$/;

/**
 * The idempotency record for a request, when it has an `Idempotency-Key` and is not a read. The fingerprint is what a replay
 * is compared against: the same key on a different request is refused, not answered with the wrong response.
 */
export function idempotencyOf(
  method: string,
  path: string,
  rawBody: string | undefined,
  key: string | undefined,
): RequestCtx['idem'] {
  if (key === undefined || method === 'GET') return undefined;
  if (!KEY_PATTERN.test(key))
    throw badRequest('Idempotency-Key must be 1 to 200 characters of letters, digits and . _ : -.');
  return { key, fingerprint: hash('sha256', `${method}\n${path}\n${rawBody ?? ''}`) };
}

const idemKeyOf = (actor: Actor, key: string) => idempotencyKey(`${actor.kind}:${actor.id}`, key);

async function replayOf(deps: Deps, ctx: RequestCtx, now: number): Promise<Reply | undefined> {
  if (!ctx.idem) return undefined;
  const stored = await getItem<IdempotencyItem>(deps, idemKeyOf(ctx.actor, ctx.idem.key));
  if (!stored || stored.expiresAt <= now) return undefined;
  if (stored.fingerprint !== ctx.idem.fingerprint) {
    throw new ApiError(
      422,
      'idempotent_replay',
      'This Idempotency-Key was already used for a different request within the last 24 hours. Send a new key for a new request, or repeat the original request unchanged to get its first response again.',
    );
  }
  return { status: stored.status, body: JSON.parse(stored.body) as unknown, replayed: true };
}

const jitter = (attempt: number) => sleep(Math.min(200, 10 * 2 ** attempt) * (0.5 + Math.random()));

/* oxlint-disable eslint/no-await-in-loop -- attempts are sequential on purpose: each one reads what the last one lost to. */
export async function execute(deps: Deps, ctx: RequestCtx, build: (now: number) => Promise<Attempt>): Promise<Reply> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const now = deps.now();
    const replay = await replayOf(deps, ctx, now);
    if (replay) return replay;
    const built = await build(now);
    if (built.items.length === 0) return built.reply;
    const items = [...built.items];
    let idemIndex = -1;
    if (ctx.idem) {
      idemIndex = items.length;
      const item: IdempotencyItem = {
        ...idemKeyOf(ctx.actor, ctx.idem.key),
        SK: 'META',
        type: 'idempotency',
        fingerprint: ctx.idem.fingerprint,
        status: built.reply.status,
        body: JSON.stringify(built.reply.stored ?? built.reply.body),
        expiresAt: now + IDEMPOTENCY_MS,
        ttl: Math.ceil((now + IDEMPOTENCY_MS) / 1000),
      };
      // An expired item DynamoDB has not yet deleted may be overwritten.
      items.push(
        putItem(item, {
          expr: 'attribute_not_exists(PK) OR #exp <= :now',
          names: { '#exp': 'expiresAt' },
          values: { ':now': now },
        }),
      );
    }
    try {
      await transact(deps, items);
      return built.reply;
    } catch (error) {
      if (!(error instanceof Cancelled)) throw error;
      if (idemIndex >= 0 && error.failed(idemIndex)) continue;
      const verdict = await built.classify?.(error);
      if (verdict instanceof ApiError) throw verdict;
      if (verdict === 'retry' || error.conflict || (built.retryOn ?? []).some((i) => error.failed(i))) {
        await jitter(attempt);
        continue;
      }
      throw error;
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
  throw new ApiError(
    409,
    'conflict',
    'The board was changing too fast to apply this write. Repeat the request; it is safe to retry with the same Idempotency-Key.',
  );
}

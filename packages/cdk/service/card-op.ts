// The common shape of a card write: decide from a snapshot, then commit the card update, its events, the project touch and the
// idempotency record as one transaction guarded by what the snapshot assumed.
import type { CardView } from './api-types.ts';
import { keyed, toCardView, type CardFields } from './card-model.ts';
import { execute, type Reply, type RequestCtx } from './engine.ts';
import { notFound } from './errors.ts';
import type { CardItem, EventItem } from './items.ts';
import { cardKey } from './keys.ts';
import { touchProject } from './projects.ts';
import {
  diffUpdate,
  getItem,
  merge,
  putNew,
  type Cancelled,
  type Condition,
  type Deps,
  type TransactItem,
} from './store.ts';
import type { ApiError } from './errors.ts';

export async function loadCard(deps: Deps, id: string): Promise<CardItem> {
  const card = await getItem<CardItem>(deps, cardKey(id));
  if (!card) throw notFound(`No card "${id}". List cards with \`baton list\`.`);
  return card;
}

export interface CardPlan {
  next: CardFields;
  events?: EventItem[];
  /** Guard at the store, beyond the sequence check. */
  condition?: Condition | undefined;
  /** Set when the plan appends events or changes anything an event describes. Heartbeats leave it off. */
  checkSeq?: boolean;
  touch?: boolean;
  status?: number;
  respond: (card: CardView) => unknown;
  /** Nothing to write: answer from the snapshot. */
  noop?: boolean;
  classify?: (cancelled: Cancelled) => ApiError | 'retry' | undefined;
  extra?: TransactItem[];
}

export function cardOp(
  deps: Deps,
  ctx: RequestCtx,
  cardId: string,
  build: (card: CardItem, now: number) => CardPlan | Promise<CardPlan>,
): Promise<Reply> {
  return execute(deps, ctx, async (now) => {
    const card = await loadCard(deps, cardId);
    const plan = await build(card, now);
    const next = keyed(plan.next);
    const reply: Reply = { status: plan.status ?? 200, body: plan.respond(toCardView(next, now, true)) };
    if (plan.noop) return { items: [], reply };
    const seqGuard: Condition | undefined =
      plan.checkSeq === false
        ? undefined
        : { expr: '#seq = :seq0', names: { '#seq': 'seq' }, values: { ':seq0': card.seq } };
    const condition = merge(seqGuard, plan.condition);
    const items: TransactItem[] = [
      diffUpdate({ PK: card.PK, SK: 'META' }, card, next, condition),
      ...(plan.events ?? []).map(putNew),
      ...(plan.touch === false ? [] : [touchProject(card.projectId, now)]),
      ...(plan.extra ?? []),
    ];
    return { items, reply, retryOn: [0], classify: plan.classify };
  });
}

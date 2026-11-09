// Cards: create, read, list, edit, move, comment, archive and the event log.
import { GSI1, GSI2, GSI3 } from '../src/schema.ts';
import { COLUMNS, COLUMN_RANK, type Actor, type CardView, type Column, type EventView } from './api-types.ts';
import { between, isPos } from './rank.ts';
import { appendEvents, keyed, toCardView, toEventView, type CardFields } from './card-model.ts';
import { cardOp, loadCard } from './card-op.ts';
import { execute, type Reply, type RequestCtx } from './engine.ts';
import { ApiError, badRequest, forbidden } from './errors.ts';
import { newId } from './ids.ts';
import type { CardItem, EventItem, ClaimItem } from './items.ts';
import { attentionPartition, boardPartition, cardKeyItem, columnPrefix, repoKey, repoPartition } from './keys.ts';
import { touchProject } from './projects.ts';
import { getItem, putItem, queryAll, type Deps, type TransactItem } from './store.ts';
import { asObject, normalizeRepo, stringList, text } from './validate.ts';

export const isColumn = (value: unknown): value is Column =>
  typeof value === 'string' && (COLUMNS as readonly string[]).includes(value);

export function columnOf(value: unknown, field = 'column'): Column {
  if (!isColumn(value)) throw badRequest(`${field} must be one of ${COLUMNS.join(', ')}.`);
  return value;
}

/** A position after every card in `column` of the project. */
export async function appendPos(deps: Deps, projectId: string, column: Column): Promise<string> {
  const last = await queryAll<Pick<CardItem, 'pos'>>(deps, {
    IndexName: GSI1.name,
    KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
    ExpressionAttributeNames: { '#pk': GSI1.pk, '#sk': GSI1.sk },
    ExpressionAttributeValues: { ':pk': boardPartition(projectId), ':prefix': columnPrefix(column) },
    ScanIndexForward: false,
    Limit: 1,
  });
  return between(last[0]?.pos ?? null, null);
}

function parseLinks(value: unknown): string[] {
  const links = stringList(value, 'links', 20, 500);
  for (const link of links) if (!/^https?:\/\//.test(link)) throw badRequest('links must be http or https URLs.');
  return links;
}

function parseSlug(raw: unknown, repo: string): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw badRequest('key must be a string.');
  const slug = raw.startsWith(`${repo}/`) ? raw.slice(repo.length + 1) : raw;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    throw badRequest(`key must be a slug of lower-case letters, digits and hyphens (or ${repo}/<slug>); got "${raw}".`);
  }
  return slug;
}

export async function createCard(deps: Deps, ctx: RequestCtx, input: unknown): Promise<Reply> {
  const body = asObject(input);
  const repo = normalizeRepo(body.repo);
  const title = (text(body.title, 'title', { max: 200 }) as string).trim();
  const cardBody = text(body.body, 'body', { max: 20_000, optional: true, min: 0 }) ?? '';
  const column = body.column === undefined ? 'backlog' : columnOf(body.column);
  const links = parseLinks(body.links);
  const slug = parseSlug(body.key, repo);
  const key = slug ? `${repo}/${slug}` : undefined;
  return execute(deps, ctx, async (now) => {
    const mapped = await getItem<{ projectId: string }>(deps, repoKey(repo));
    if (!mapped) {
      throw new ApiError(
        409,
        'repo_unregistered',
        `Repo ${repo} belongs to no project, so a card cannot be created for it. Register it: run \`baton project register --name <project>\` from a checkout of the repo, or use the dashboard's register form.`,
      );
    }
    if (key) {
      const existing = await getItem<{ cardId: string }>(deps, cardKeyItem(key));
      if (existing) {
        const card = await loadCard(deps, existing.cardId);
        return { items: [], reply: { status: 200, body: { card: toCardView(card, now, true), created: false } } };
      }
    }
    const projectId = mapped.projectId;
    const id = newId(now);
    const fields: CardFields = {
      type: 'card',
      id,
      projectId,
      ...(key ? { key } : {}),
      title,
      body: cardBody,
      repo,
      column,
      pos: await appendPos(deps, projectId, column),
      seq: 0,
      lastHumanSeq: 0,
      ackedSeq: 0,
      reopened: false,
      archived: false,
      links,
      createdAt: now,
      updatedAt: now,
    };
    const { events, seq } = appendEvents(fields, ctx.actor, now, [
      { type: 'created', payload: { title, column, ...(key ? { key } : {}) } },
    ]);
    const card = keyed({ ...fields, seq });
    const items: TransactItem[] = [
      putItem(card as never, { expr: 'attribute_not_exists(PK)' }),
      ...events.map((e) => putItem(e as never, { expr: 'attribute_not_exists(PK)' })),
      touchProject(projectId, now),
      ...(key
        ? [putItem({ ...cardKeyItem(key), type: 'card-key', cardId: id }, { expr: 'attribute_not_exists(PK)' })]
        : []),
    ];
    const keyIndex = items.length - 1;
    return {
      items,
      reply: { status: 201, body: { card: toCardView(card, now, true), created: true } },
      // Two creates with one key: the loser reads again and is handed the winner's card (Requirement 5.4).
      classify: (c) => (key && c.failed(keyIndex) ? 'retry' : undefined),
    };
  });
}

export async function getCard(deps: Deps, id: string): Promise<{ card: CardView }> {
  return { card: toCardView(await loadCard(deps, id), deps.now(), true) };
}

const byBoardOrder = (a: CardItem, b: CardItem) =>
  COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column) ||
  (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : a.id < b.id ? -1 : 1);

export interface CardQuery {
  project?: string | undefined;
  repo?: string | undefined;
  column?: string | undefined;
  key?: string | undefined;
  archived?: boolean;
  attention?: boolean;
}

export async function listCards(deps: Deps, actor: Actor, query: CardQuery): Promise<{ cards: CardView[] }> {
  const now = deps.now();
  let items: CardItem[];
  if (query.attention) {
    if (actor.kind !== 'agent')
      throw forbidden('attention=me lists the cards an agent was last on; it is for agent tokens.');
    items = await queryAll<CardItem>(deps, {
      IndexName: GSI3.name,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': GSI3.pk },
      ExpressionAttributeValues: { ':pk': attentionPartition(actor.id) },
    });
  } else if (query.key) {
    const mapped = await getItem<{ cardId: string }>(deps, cardKeyItem(query.key));
    items = mapped ? [await loadCard(deps, mapped.cardId)] : [];
  } else if (query.project) {
    const column = query.column ? columnOf(query.column) : undefined;
    items = await queryAll<CardItem>(deps, {
      IndexName: GSI1.name,
      KeyConditionExpression: column ? '#pk = :pk AND begins_with(#sk, :prefix)' : '#pk = :pk',
      ExpressionAttributeNames: column ? { '#pk': GSI1.pk, '#sk': GSI1.sk } : { '#pk': GSI1.pk },
      ExpressionAttributeValues: column
        ? { ':pk': boardPartition(query.project), ':prefix': columnPrefix(column) }
        : { ':pk': boardPartition(query.project) },
    });
  } else if (query.repo) {
    const repo = normalizeRepo(query.repo);
    items = await queryAll<CardItem>(deps, {
      IndexName: GSI2.name,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': GSI2.pk },
      ExpressionAttributeValues: { ':pk': repoPartition(repo) },
    });
    if (query.column) {
      const column = columnOf(query.column);
      items = items.filter((c) => c.column === column);
    }
  } else {
    throw badRequest('Pass project=<id>, repo=<owner/name>, key=<repo/slug> or attention=me.');
  }
  const shown = query.archived ? items : items.filter((c) => !c.archived);
  return { cards: shown.toSorted(byBoardOrder).map((c) => toCardView(c, now, false)) };
}

export function patchCard(deps: Deps, ctx: RequestCtx, id: string, input: unknown): Promise<Reply> {
  const body = asObject(input);
  const title = body.title === undefined ? undefined : (text(body.title, 'title', { max: 200 }) as string).trim();
  const cardBody = body.body === undefined ? undefined : (text(body.body, 'body', { max: 20_000, min: 0 }) as string);
  const links = body.links === undefined ? undefined : parseLinks(body.links);
  if (title === undefined && cardBody === undefined && links === undefined)
    throw badRequest('Send title, body or links.');
  return cardOp(deps, ctx, id, (card, now) => {
    const changed: Record<string, unknown> = {};
    if (title !== undefined && title !== card.title) changed.title = title;
    if (cardBody !== undefined && cardBody !== card.body) changed.body = cardBody;
    if (links !== undefined && JSON.stringify(links) !== JSON.stringify(card.links)) changed.links = links;
    if (Object.keys(changed).length === 0) return { next: card, noop: true, respond: (view) => ({ card: view }) };
    const { events, seq, lastHumanSeq } = appendEvents(card, ctx.actor, now, [{ type: 'edited', payload: changed }]);
    return {
      next: {
        ...card,
        title: title ?? card.title,
        body: cardBody ?? card.body,
        links: links ?? card.links,
        seq,
        lastHumanSeq,
        updatedAt: now,
      },
      events,
      respond: (view) => ({ card: view }),
    };
  });
}

export function commentCard(deps: Deps, ctx: RequestCtx, id: string, input: unknown): Promise<Reply> {
  const textBody = (text(asObject(input).text, 'text', { max: 10_000 }) as string).trim();
  return cardOp(deps, ctx, id, (card, now) => {
    const { events, seq, lastHumanSeq } = appendEvents(card, ctx.actor, now, [
      { type: 'commented', payload: { text: textBody } },
    ]);
    return {
      next: { ...card, seq, lastHumanSeq, updatedAt: now },
      events,
      status: 201,
      respond: (view) => ({ card: view, event: toEventView(events[0] as EventItem) }),
    };
  });
}

export function archiveCard(deps: Deps, ctx: RequestCtx, id: string): Promise<Reply> {
  return cardOp(deps, ctx, id, (card, now) => {
    if (card.archived) return { next: card, noop: true, respond: (view) => ({ card: view }) };
    const specs: { type: 'edited' | 'released'; payload: Record<string, unknown> }[] = [
      { type: 'edited', payload: { archived: true } },
    ];
    if (card.claim) specs.push({ type: 'released', payload: { reason: 'archived' } });
    const { events, seq, lastHumanSeq } = appendEvents(card, ctx.actor, now, specs);
    return {
      next: {
        ...card,
        archived: true,
        ...(card.claim ? { claim: undefined, lastClaim: endedClaim(card.claim, now, 'archived', 'archived') } : {}),
        seq,
        lastHumanSeq,
        updatedAt: now,
      },
      events,
      respond: (view) => ({ card: view }),
    };
  });
}

export const endedClaim = (
  claim: ClaimItem,
  now: number,
  endedBy: 'released' | 'taken_over' | 'human_done' | 'archived',
  reason: string | null,
) => ({
  agentId: claim.agentId,
  repo: claim.repo,
  worktree: claim.worktree,
  branch: claim.branch,
  session: claim.session,
  endedAt: now,
  endedBy,
  reason,
});

export async function listEvents(
  deps: Deps,
  id: string,
  since: number,
  limit = 200,
): Promise<{ events: EventView[]; seq: number }> {
  const card = await loadCard(deps, id);
  const events = await queryAll<EventItem>(deps, {
    // BETWEEN, not a bare lower bound: the card's own META item sorts after every EVT# key.
    KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lo AND :hi',
    ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
    ExpressionAttributeValues: {
      ':pk': `CARD#${id}`,
      ':lo': `EVT#${String(since + 1).padStart(8, '0')}`,
      ':hi': 'EVT#99999999',
    },
    Limit: limit,
  });
  return { events: events.map(toEventView), seq: card.seq };
}

/** Human events after `since`, for the claim response. */
export async function pendingHumanEvents(deps: Deps, card: CardItem): Promise<EventView[]> {
  const all = await listEvents(deps, card.id, card.ackedSeq, 500);
  return all.events.filter((e) => e.actor.kind === 'human');
}

export type MoveTarget = { to: Column; pos: string };

export async function resolveTarget(deps: Deps, card: CardItem, to: Column, pos: unknown): Promise<MoveTarget> {
  if (pos !== undefined && !isPos(pos))
    throw badRequest('pos must be a lower-case alphanumeric position string, as the board sends it.');
  return { to, pos: pos ?? (await appendPos(deps, card.projectId, to)) };
}

export const rankOf = (column: Column): number | null => COLUMN_RANK[column];

/** A human moved the card to an earlier column: the work is not done (Requirement 4.1). */
export const isBackward = (from: Column, to: Column): boolean => {
  const a = rankOf(from);
  const b = rankOf(to);
  return a !== null && b !== null && b < a;
};

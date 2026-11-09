// Cards: create, read, list, edit, move, comment, archive and the event log.
import { GSI1, GSI2, GSI3 } from '../src/schema.ts';
import { COLUMNS, type Actor, type CardEdit, type CardView, type Column, type EventView } from './api-types.ts';
import { between, comparePos, isPos } from './rank.ts';
import {
  endedClaim,
  isSteering,
  keyed,
  toCardView,
  toEventView,
  withEvents,
  type CardFields,
  type EventSpec,
} from './card-model.ts';
import { cardOp, loadCard } from './card-op.ts';
import { execute, type Reply, type RequestCtx } from './engine.ts';
import { ApiError, badRequest, forbidden } from './errors.ts';
import { newId } from './ids.ts';
import type { CardItem, EventItem } from './items.ts';
import {
  attentionPartition,
  boardPartition,
  cardKeyItem,
  columnPrefix,
  eventRange,
  repoKey,
  repoPartition,
} from './keys.ts';
import { touchProject } from './projects.ts';
import { getItem, putNew, queryAll, type Deps, type TransactItem } from './store.ts';
import { asObject, normalizeRepo, requiredText, stringList, text } from './validate.ts';

const isColumn = (value: unknown): value is Column =>
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
  const title = requiredText(body.title, 'title', 200).trim();
  const cardBody = text(body.body, 'body', { max: 20_000, optional: true, min: 0 }) ?? '';
  const column = body.column === undefined ? 'backlog' : columnOf(body.column);
  const links = parseLinks(body.links);
  const slug = parseSlug(body.key, repo);
  const key = slug ? `${repo}/${slug}` : undefined;
  return execute(deps, ctx, async (now) => {
    const [mapped, existing] = await Promise.all([
      getItem<{ projectId: string }>(deps, repoKey(repo)),
      key ? getItem<{ cardId: string }>(deps, cardKeyItem(key)) : undefined,
    ]);
    if (!mapped) {
      throw new ApiError(
        'repo_unregistered',
        `Repo ${repo} belongs to no project, so a card cannot be created for it. Register it: run \`baton project register --name <project>\` from a checkout of the repo, or use the dashboard's register form.`,
      );
    }
    if (existing) {
      const card = await loadCard(deps, existing.cardId);
      return { items: [], reply: { status: 200, body: { card: toCardView(card, now, true), created: false } } };
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
    const { next, events } = withEvents(fields, ctx.actor, now, [
      { type: 'created', payload: { title, column, ...(key ? { key } : {}) } },
    ]);
    const card = keyed(next);
    const items: TransactItem[] = [
      putNew(card),
      ...events.map(putNew),
      touchProject(projectId, now),
      ...(key ? [putNew({ ...cardKeyItem(key), type: 'card-key', cardId: id })] : []),
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
  COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column) || comparePos(a, b);

interface CardQuery {
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
  const title = body.title === undefined ? undefined : requiredText(body.title, 'title', 200).trim();
  const cardBody = body.body === undefined ? undefined : requiredText(body.body, 'body', 20_000, 0);
  const links = body.links === undefined ? undefined : parseLinks(body.links);
  if (title === undefined && cardBody === undefined && links === undefined)
    throw badRequest('Send title, body or links.');
  return cardOp(deps, ctx, id, (card, now) => {
    const changed: CardEdit = {};
    if (title !== undefined && title !== card.title) changed.title = title;
    if (cardBody !== undefined && cardBody !== card.body) changed.body = cardBody;
    if (links !== undefined && JSON.stringify(links) !== JSON.stringify(card.links)) changed.links = links;
    if (Object.keys(changed).length === 0) return { next: card, noop: true };
    return withEvents(card, ctx.actor, now, [{ type: 'edited', payload: changed }], {
      title: title ?? card.title,
      body: cardBody ?? card.body,
      links: links ?? card.links,
    });
  });
}

export function commentCard(deps: Deps, ctx: RequestCtx, id: string, input: unknown): Promise<Reply> {
  const textBody = requiredText(asObject(input).text, 'text', 10_000).trim();
  return cardOp(deps, ctx, id, (card, now) => {
    const { next, events } = withEvents(card, ctx.actor, now, [{ type: 'commented', payload: { text: textBody } }]);
    return {
      next,
      events,
      status: 201,
      respond: (view) => ({ card: view, event: toEventView(events[0] as EventItem) }),
    };
  });
}

export function archiveCard(deps: Deps, ctx: RequestCtx, id: string): Promise<Reply> {
  return cardOp(deps, ctx, id, (card, now) => {
    if (card.archived) return { next: card, noop: true };
    const specs: EventSpec[] = [{ type: 'edited', payload: { archived: true } }];
    if (card.claim) specs.push({ type: 'released', payload: { reason: 'archived' } });
    return withEvents(card, ctx.actor, now, specs, {
      archived: true,
      ...(card.claim ? { claim: undefined, lastClaim: endedClaim(card.claim, now, 'archived', 'archived') } : {}),
    });
  });
}

/** The events of `card` after sequence `since`, oldest first. */
function eventsAfter(deps: Deps, card: CardItem, since: number, limit: number): Promise<EventItem[]> {
  const { lo, hi } = eventRange(since);
  return queryAll<EventItem>(deps, {
    KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :lo AND :hi',
    ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
    ExpressionAttributeValues: { ':pk': card.PK, ':lo': lo, ':hi': hi },
    Limit: limit,
  });
}

export async function listEvents(
  deps: Deps,
  id: string,
  since: number,
  limit = 200,
): Promise<{ events: EventView[]; seq: number }> {
  const card = await loadCard(deps, id);
  return { events: (await eventsAfter(deps, card, since, limit)).map(toEventView), seq: card.seq };
}

/** Human events after the card's acknowledged sequence, for the claim response. */
export async function pendingHumanEvents(deps: Deps, card: CardItem): Promise<EventView[]> {
  const events = (await eventsAfter(deps, card, card.ackedSeq, 500)).map(toEventView);
  return events.filter((e) => isSteering(e.actor, e.type));
}

/** The position a move asked for, or the end of the target column. */
export async function resolvePos(deps: Deps, projectId: string, column: Column, pos: unknown): Promise<string> {
  if (pos !== undefined && !isPos(pos))
    throw badRequest('pos must be a lower-case alphanumeric position string, as the board sends it.');
  return pos ?? (await appendPos(deps, projectId, column));
}

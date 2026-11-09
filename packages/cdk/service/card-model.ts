// Pure functions over card items: derived keys, derived state, views. No I/O.
import type { Actor, CardState, CardView, ClaimView, EventType, EventView, LastClaimView } from './api-types.ts';
import { boardPartition, boardSort, cardKey, attentionPartition, repoPartition } from './keys.ts';
import type { CardItem, ClaimItem, EventItem, LastClaimItem } from './items.ts';

export type CardFields = Omit<CardItem, 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK' | 'GSI2PK' | 'GSI2SK' | 'GSI3PK' | 'GSI3SK'>;

/** The card needs its last agent's attention: reopened, or a human event it has not acknowledged. */
export const needsAttention = (card: CardFields): boolean =>
  card.lastAgentId !== undefined && !card.archived && (card.reopened || card.lastHumanSeq > card.ackedSeq);

/** Attaches every key attribute, derived from the logical fields so a move or an ack can never leave an index stale. */
export function keyed(card: CardFields): CardItem {
  const attention = needsAttention(card) && card.lastAgentId !== undefined;
  return {
    ...card,
    ...cardKey(card.id),
    SK: 'META',
    GSI1PK: boardPartition(card.projectId),
    GSI1SK: boardSort(card.column, card.pos, card.id),
    GSI2PK: repoPartition(card.repo),
    GSI2SK: `CARD#${card.id}`,
    GSI3PK: attention ? attentionPartition(card.lastAgentId as string) : undefined,
    GSI3SK: attention ? `${String(card.updatedAt).padStart(15, '0')}#${card.id}` : undefined,
  };
}

export function stateOf(card: CardFields, now: number): CardState {
  if (card.claim) return card.claim.leaseUntil < now ? 'stale' : 'claimed';
  return card.column === 'in_progress' ? 'unowned' : 'unclaimed';
}

export const isUnread = (card: CardFields): boolean =>
  card.lastAgentId !== undefined && card.lastHumanSeq > card.ackedSeq;

export function claimView(claim: ClaimItem, now: number): ClaimView {
  return {
    agentId: claim.agentId,
    repo: claim.repo,
    worktree: claim.worktree,
    branch: claim.branch,
    session: claim.session,
    claimedAt: claim.claimedAt,
    heartbeatAt: claim.heartbeatAt,
    leaseUntil: claim.leaseUntil,
    stale: claim.leaseUntil < now,
  };
}

const lastClaimView = (c: LastClaimItem): LastClaimView => ({ ...c });

export function toCardView(card: CardItem, now: number, withBody: boolean): CardView {
  return {
    id: card.id,
    projectId: card.projectId,
    key: card.key ?? null,
    title: card.title,
    ...(withBody ? { body: card.body } : {}),
    repo: card.repo,
    column: card.column,
    pos: card.pos,
    seq: card.seq,
    lastHumanSeq: card.lastHumanSeq,
    lastAgentId: card.lastAgentId ?? null,
    ackedSeq: card.ackedSeq,
    reopened: card.reopened,
    archived: card.archived,
    links: card.links,
    claim: card.claim ? claimView(card.claim, now) : null,
    lastClaim: card.lastClaim ? lastClaimView(card.lastClaim) : null,
    state: stateOf(card, now),
    unread: isUnread(card),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

export function toEventView(event: EventItem): EventView {
  return { seq: event.seq, at: event.at, actor: event.actor, type: event.eventType, payload: event.payload };
}

/** Event types a human raises that the owning agent must read and acknowledge. */
const STEERING: ReadonlySet<EventType> = new Set(['edited', 'moved', 'commented', 'released']);

export interface EventSpec {
  type: EventType;
  payload: Record<string, unknown>;
}

/** The events to append to `card` and the counters they move. Heartbeats never come through here. */
export function appendEvents(card: CardFields, actor: Actor, now: number, specs: EventSpec[]) {
  let seq = card.seq;
  let lastHumanSeq = card.lastHumanSeq;
  const events: EventItem[] = specs.map((spec) => {
    seq += 1;
    if (actor.kind === 'human' && STEERING.has(spec.type)) lastHumanSeq = seq;
    return {
      PK: `CARD#${card.id}`,
      SK: `EVT#${String(seq).padStart(8, '0')}`,
      type: 'event',
      cardId: card.id,
      seq,
      at: now,
      actor,
      eventType: spec.type,
      payload: spec.payload,
    };
  });
  return { events, seq, lastHumanSeq };
}

// Pure functions over card items: derived keys, derived state, views. No I/O.
import type { Actor, CardState, CardView, ClaimEnd, ClaimView, EventBody, EventType, EventView } from './api-types.ts';
import {
  archivedPartition,
  attentionPartition,
  boardPartition,
  boardSort,
  cardKey,
  eventKey,
  repoPartition,
} from './keys.ts';
import type { CardItem, ClaimItem, EventItem, LastClaimItem } from './items.ts';

export type CardFields = Omit<CardItem, 'PK' | 'SK' | 'GSI1PK' | 'GSI1SK' | 'GSI2PK' | 'GSI2SK' | 'GSI3PK' | 'GSI3SK'>;

/** The claim's lease has not run out. */
export const isLive = (claim: ClaimItem, now: number): boolean => claim.leaseUntil >= now;

/** A human has written to the card since its last agent acknowledged. */
export const hasUnacked = (card: CardFields): boolean => card.ackedSeq < card.lastHumanSeq;

/** The claim with its lease running from `now`, and `patch` applied for a holder that took the card again. */
export const renewLease = (
  claim: ClaimItem,
  now: number,
  leaseMs: number,
  patch: Partial<ClaimItem> = {},
): ClaimItem => ({
  ...claim,
  ...patch,
  heartbeatAt: now,
  leaseUntil: now + leaseMs,
});

/** The card needs its last agent's attention: reopened, or a human event it has not acknowledged. */
const needsAttention = (card: CardFields): boolean =>
  card.lastAgentId !== undefined && !card.archived && (card.reopened || hasUnacked(card));

/** Attaches every key attribute, derived from the logical fields so a move or an ack can never leave an index stale. */
export function keyed(card: CardFields): CardItem {
  const agent = needsAttention(card) ? card.lastAgentId : undefined;
  const shelf = (partition: string) => (card.archived ? archivedPartition(partition) : partition);
  return {
    ...card,
    ...cardKey(card.id),
    SK: 'META',
    GSI1PK: shelf(boardPartition(card.projectId)),
    GSI1SK: boardSort(card.column, card.pos, card.id),
    GSI2PK: shelf(repoPartition(card.repo)),
    GSI2SK: `CARD#${card.id}`,
    GSI3PK: agent === undefined ? undefined : attentionPartition(agent),
    GSI3SK: agent === undefined ? undefined : `${String(card.updatedAt).padStart(15, '0')}#${card.id}`,
  };
}

export function stateOf(card: CardFields, now: number): CardState {
  if (card.claim) return isLive(card.claim, now) ? 'claimed' : 'stale';
  return card.column === 'in_progress' ? 'unowned' : 'unclaimed';
}

export const isUnread = (card: CardFields): boolean => card.lastAgentId !== undefined && hasUnacked(card);

/** Where a claim was left when it ended, kept on the card for the next agent. */
export const endedClaim = (
  claim: ClaimItem,
  endedAt: number,
  endedBy: ClaimEnd,
  reason: string | null,
): LastClaimItem => ({
  agentId: claim.agentId,
  repo: claim.repo,
  worktree: claim.worktree,
  branch: claim.branch,
  session: claim.session,
  endedAt,
  endedBy,
  reason,
});

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
    stale: !isLive(claim, now),
  };
}

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
    lastClaim: card.lastClaim ?? null,
    state: stateOf(card, now),
    unread: isUnread(card),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

export function toEventView(event: EventItem): EventView {
  // The item stores the pair loosely; the board only ever writes the pairs EventBody names.
  return {
    seq: event.seq,
    at: event.at,
    actor: event.actor,
    type: event.eventType,
    payload: event.payload,
  } as EventView;
}

/** Event types a human raises that the owning agent must read and acknowledge. */
const STEERING: ReadonlySet<EventType> = new Set(['edited', 'moved', 'commented', 'released']);

/** A human's event that asks something of the card's agent: the creating event, and every agent's own, do not. */
export const isSteering = (actor: Actor, type: EventType): boolean => actor.kind === 'human' && STEERING.has(type);

export type EventSpec = EventBody;

/** The events to append to `card` and the counters they move. Heartbeats never come through here. */
function appendEvents(card: CardFields, actor: Actor, now: number, specs: EventSpec[]) {
  let seq = card.seq;
  let lastHumanSeq = card.lastHumanSeq;
  const events: EventItem[] = specs.map((spec) => {
    seq += 1;
    if (isSteering(actor, spec.type)) lastHumanSeq = seq;
    return {
      ...eventKey(card.id, seq),
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

/** `card` with `patch` applied and `specs` appended as events: sequence, human sequence and `updatedAt` follow from them. */
export function withEvents(
  card: CardFields,
  actor: Actor,
  now: number,
  specs: EventSpec[],
  patch: Partial<CardFields> = {},
): { next: CardFields; events: EventItem[] } {
  const { events, seq, lastHumanSeq } = appendEvents(card, actor, now, specs);
  return { next: { ...card, ...patch, seq, lastHumanSeq, updatedAt: now }, events };
}

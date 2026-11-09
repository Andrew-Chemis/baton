// Claims, heartbeats, acknowledgements, releases and moves: every operation whose rules depend on who holds a card.
import { GSI2 } from '../src/schema.ts';
import {
  RELEASE_REASONS,
  isBackward,
  isForward,
  isReview,
  type CardView,
  type ClaimResponse,
  type Column,
  type Warning,
} from './api-types.ts';
import {
  claimView,
  endedClaim,
  hasUnacked,
  isLive,
  renewLease,
  toCardView,
  withEvents,
  type EventSpec,
} from './card-model.ts';
import { cardOp, type CardPlan } from './card-op.ts';
import { appendPos, columnOf, pendingHumanEvents, resolvePos } from './cards.ts';
import { timingOf } from './config.ts';
import type { Reply, RequestCtx } from './engine.ts';
import { ApiError, badRequest, claimHeld, notHolder } from './errors.ts';
import type { CardItem, ClaimItem } from './items.ts';
import { repoPartition } from './keys.ts';
import { queryAll, type Condition, type Deps } from './store.ts';
import { asObject, normalizeRepo, requiredText, text } from './validate.ts';

const holderOf = (agentId: string, worktree: string) => `${agentId}#${worktree}`;

/** The write may go ahead when nobody holds the card, the holder's lease has run out, or `me` holds it. */
const activeOrMine = (now: number, me: string): Condition => ({
  expr: 'attribute_not_exists(#claim) OR #claim.#leaseUntil < :now OR #claim.#holder = :me',
  names: { '#claim': 'claim', '#leaseUntil': 'leaseUntil', '#holder': 'holder' },
  values: { ':now': now, ':me': me },
});

const holderIs = (me: string): Condition => ({
  expr: '#claim.#holder = :me',
  names: { '#claim': 'claim', '#holder': 'holder' },
  values: { ':me': me },
});

const ackedAndHolder = (me: string): Condition => ({
  expr: '#claim.#holder = :me AND #acked >= #human',
  names: { '#claim': 'claim', '#holder': 'holder', '#acked': 'ackedSeq', '#human': 'lastHumanSeq' },
  values: { ':me': me },
});

/** The claim, when `me` holds it; otherwise the refusal that says what `doing` would have needed. */
function heldBy(card: CardItem, now: number, me: string, doing: string): ClaimItem {
  if (!card.claim || card.claim.holder !== me) throw notHolder(toCardView(card, now, false), doing);
  return card.claim;
}

/** Refuses with claim_held while another holder's lease is still running. */
function assertNotHeldByOther(card: CardItem, now: number, me: string): void {
  const claim = card.claim;
  if (claim && claim.holder !== me && isLive(claim, now))
    throw claimHeld(toCardView(card, now, true), claimView(claim, now));
}

/** A plan that writes only the claim's lease: no event, no sequence bump, no project touch. */
function refreshLease(card: CardItem, claim: ClaimItem, respond: (card: CardView) => unknown): CardPlan {
  return { next: { ...card, claim }, checkSeq: false, touch: false, condition: holderIs(claim.holder), respond };
}

function agentWorktree(
  ctx: RequestCtx,
  body: Record<string, unknown>,
): { agentId: string; worktree: string; me: string } {
  const worktree = typeof body.worktree === 'string' ? body.worktree.trim() : '';
  if (!worktree) {
    throw new ApiError(
      'missing_worktree',
      'worktree is required: send the absolute path of your git checkout (the CLI reads it from `git rev-parse --show-toplevel`).',
    );
  }
  if (worktree.length > 500) throw badRequest('worktree must be at most 500 characters.');
  return { agentId: ctx.actor.id, worktree, me: holderOf(ctx.actor.id, worktree) };
}

export async function claimCard(deps: Deps, ctx: RequestCtx, id: string, input: unknown): Promise<Reply> {
  const body = asObject(input);
  const missing = ['repo', 'worktree', 'branch'].filter((f) => typeof body[f] !== 'string' || body[f].trim() === '');
  if (missing.length > 0) {
    throw new ApiError(
      'missing_worktree',
      `A claim records where the work happens, so ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required. Run from a git checkout: the CLI reads repo from the origin URL, worktree from \`git rev-parse --show-toplevel\` and branch from \`git rev-parse --abbrev-ref HEAD\`.`,
    );
  }
  const { agentId, worktree, me } = agentWorktree(ctx, body);
  const repo = normalizeRepo(body.repo);
  const branch = requiredText(body.branch, 'branch', 255).trim();
  const session = (text(body.session, 'session', { max: 200, optional: true }) ?? null)?.trim() ?? null;
  const advanceTo = body.to === undefined ? undefined : columnOf(body.to, 'to');
  return cardOp(deps, ctx, id, (card, now) =>
    planClaim(deps, card, now, { agentId, worktree, me, repo, branch, session, advanceTo }),
  );
}

interface ClaimArgs {
  agentId: string;
  worktree: string;
  me: string;
  repo: string;
  branch: string;
  session: string | null;
  advanceTo: Column | undefined;
}

async function planClaim(deps: Deps, card: CardItem, now: number, a: ClaimArgs): Promise<CardPlan> {
  const { leaseMs } = deps.config;
  if (card.repo !== a.repo) {
    throw new ApiError(
      'repo_mismatch',
      `Card ${card.key ?? card.id} belongs to ${card.repo}, but this checkout is ${a.repo}. Take cards for this repo with \`baton list\`, or run the command from a checkout of ${card.repo}.`,
    );
  }
  if (card.archived || card.column === 'done') {
    throw badRequest(
      `Card ${card.key ?? card.id} is ${card.archived ? 'archived' : 'in Done'}, so it cannot be taken. A human can move it back to open it again.`,
    );
  }
  const existing = card.claim;
  const timing = timingOf(deps.config);

  if (existing && existing.holder === a.me) {
    // Taking a card you hold writes only the lease and where you are now: no second claim, no second event (Requirement 1.4).
    const claim = renewLease(existing, now, leaseMs, { branch: a.branch, session: a.session });
    return refreshLease(card, claim, (view): ClaimResponse => ({
      card: view,
      warnings: [],
      pending: [],
      alreadyHeld: true,
      ...timing,
    }));
  }

  assertNotHeldByOther(card, now, a.me);

  const claim: ClaimItem = {
    agentId: a.agentId,
    holder: a.me,
    repo: a.repo,
    worktree: a.worktree,
    branch: a.branch,
    session: a.session,
    claimedAt: now,
    heartbeatAt: now,
    leaseUntil: now + leaseMs,
  };
  const specs: EventSpec[] = [
    existing
      ? {
          type: 'taken_over',
          payload: {
            previous: {
              agentId: existing.agentId,
              worktree: existing.worktree,
              branch: existing.branch,
              heartbeatAt: existing.heartbeatAt,
            },
            worktree: a.worktree,
            branch: a.branch,
            session: a.session,
          },
        }
      : { type: 'claimed', payload: { worktree: a.worktree, branch: a.branch, session: a.session } },
  ];
  const advanceTo = a.advanceTo && isForward(card.column, a.advanceTo) ? a.advanceTo : undefined;
  if (advanceTo) specs.push({ type: 'moved', payload: { from: card.column, to: advanceTo } });
  const [pos, warnings, pending] = await Promise.all([
    advanceTo ? appendPos(deps, card.projectId, advanceTo) : card.pos,
    branchWarnings(deps, card, a, now),
    pendingHumanEvents(deps, card),
  ]);
  const { next, events } = withEvents(card, { kind: 'agent', id: a.agentId }, now, specs, {
    column: advanceTo ?? card.column,
    pos,
    claim,
    lastAgentId: a.agentId,
    lastClaim: existing ? endedClaim(existing, now, 'taken_over', null) : card.lastClaim,
    // A claim that grants ownership clears `reopened` (Requirement 4.2).
    reopened: false,
  });
  return {
    next,
    events,
    condition: activeOrMine(now, a.me),
    respond: (view): ClaimResponse => ({ card: view, warnings, pending, alreadyHeld: false, ...timing }),
  };
}

/** Another card in this repo already has an active claim on the same branch (Requirement 5.2). */
async function branchWarnings(deps: Deps, card: CardItem, a: ClaimArgs, now: number): Promise<Warning[]> {
  const others = await queryAll<CardItem>(deps, {
    IndexName: GSI2.name,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': GSI2.pk },
    ExpressionAttributeValues: { ':pk': repoPartition(card.repo) },
  });
  return others
    .filter((o) => o.id !== card.id && !o.archived && o.claim && o.claim.branch === a.branch && isLive(o.claim, now))
    .map((o) => ({
      code: 'branch_reused' as const,
      message: `Branch ${a.branch} already carries an active claim on card ${o.key ?? o.id} ("${o.title}"). Two cards on one branch tangle their commits; use a branch per card unless that is intended.`,
      card: { id: o.id, title: o.title, key: o.key ?? null },
    }));
}

export function heartbeatCard(deps: Deps, ctx: RequestCtx, id: string, input: unknown): Promise<Reply> {
  const { me } = agentWorktree(ctx, asObject(input));
  return cardOp(deps, ctx, id, (card, now) => {
    const claim = renewLease(heldBy(card, now, me, 'send a heartbeat'), now, deps.config.leaseMs);
    return refreshLease(card, claim, ({ body: _body, ...lean }) => ({ card: lean, ...timingOf(deps.config) }));
  });
}

export async function ackCard(deps: Deps, ctx: RequestCtx, id: string, input: unknown): Promise<Reply> {
  const agentId = ctx.actor.id;
  const seq = asObject(input).seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0)
    throw badRequest('seq must be a whole number: the latest sequence you have read.');
  return cardOp(deps, ctx, id, (card, now) => {
    const view = toCardView(card, now, false);
    if (card.lastAgentId !== agentId) {
      throw new ApiError(
        'not_holder',
        card.lastAgentId
          ? `Only the agent that last held card ${card.key ?? card.id} (${card.lastAgentId}) can acknowledge it.`
          : `Card ${card.key ?? card.id} has never been taken, so there is nothing to acknowledge. Take it first with \`baton take\`.`,
        { card: view },
      );
    }
    if (seq > card.seq) {
      throw new ApiError(
        'seq_ahead',
        `Card ${card.key ?? card.id} is at sequence ${card.seq}; you tried to acknowledge ${seq}. Run \`baton check ${card.key ?? card.id}\` and acknowledge the sequence it reports.`,
        { card: view, seq: card.seq },
      );
    }
    if (seq <= card.ackedSeq) return { next: card, noop: true };
    return {
      next: { ...card, ackedSeq: seq, updatedAt: now },
      checkSeq: false,
      touch: false,
      condition: {
        expr: '#last = :me AND #seq >= :n AND #acked < :n',
        names: { '#last': 'lastAgentId', '#seq': 'seq', '#acked': 'ackedSeq' },
        values: { ':me': agentId, ':n': seq },
      },
    };
  });
}

function unacked(card: CardItem, now: number, to: string): ApiError {
  return new ApiError(
    'unacked_comments',
    `Card ${card.key ?? card.id} has human activity up to sequence ${card.lastHumanSeq} that you have not acknowledged (you are at ${card.ackedSeq}), so it cannot go to ${to}. ` +
      `Run \`baton check ${card.key ?? card.id}\`, read and answer it, run \`baton ack ${card.key ?? card.id}\`, then try again.`,
    { card: toCardView(card, now, false), seq: card.lastHumanSeq },
  );
}

/** Review and Done say the work is finished, so everything a human wrote must have been read first. */
function reviewGuard(card: CardItem, now: number, me: string, to: string): Condition {
  if (hasUnacked(card)) throw unacked(card, now, to);
  return ackedAndHolder(me);
}

export function releaseCard(deps: Deps, ctx: RequestCtx, id: string, input: unknown): Promise<Reply> {
  const body = asObject(input);
  const { agentId, me } = agentWorktree(ctx, body);
  const reason = body.reason;
  if (typeof reason !== 'string' || !(RELEASE_REASONS as readonly string[]).includes(reason)) {
    throw badRequest(`reason must be one of ${RELEASE_REASONS.join(', ')}.`);
  }
  const to = body.to === undefined ? undefined : columnOf(body.to, 'to');
  const comment = text(body.comment, 'comment', { max: 10_000, optional: true });
  return cardOp(deps, ctx, id, async (card, now) => {
    const claim = heldBy(card, now, me, 'release it');
    const condition = isReview(to) ? reviewGuard(card, now, me, to) : holderIs(me);
    const specs: EventSpec[] = [];
    if (comment?.trim()) specs.push({ type: 'commented', payload: { text: comment.trim() } });
    specs.push({ type: 'released', payload: { reason, ...(to ? { to } : {}) } });
    const moved = to ? { column: to, pos: await resolvePos(deps, card.projectId, to, body.pos) } : {};
    const { next, events } = withEvents(card, { kind: 'agent', id: agentId }, now, specs, {
      claim: undefined,
      lastClaim: endedClaim(claim, now, 'released', reason),
      ...moved,
    });
    return { next, events, condition };
  });
}

export function moveCard(deps: Deps, ctx: RequestCtx, id: string, input: unknown): Promise<Reply> {
  const body = asObject(input);
  const to = columnOf(body.to, 'to');
  const agent = ctx.actor.kind === 'agent' ? agentWorktree(ctx, body) : undefined;
  return cardOp(deps, ctx, id, async (card, now) => {
    const pos = await resolvePos(deps, card.projectId, to, body.pos);
    const specs: EventSpec[] = [{ type: 'moved', payload: { from: card.column, to } }];
    let claim = card.claim;
    let lastClaim = card.lastClaim;
    let condition: Condition | undefined;
    let reopened = card.reopened;

    if (!agent) {
      // A human move. Backward means the work is not done; Done releases whatever claim is there.
      if (isBackward(card.column, to)) reopened = true;
      if (to === 'done') {
        reopened = false;
        if (claim) {
          specs.push({ type: 'released', payload: { reason: 'human_done' } });
          lastClaim = endedClaim(claim, now, 'human_done', 'human_done');
          claim = undefined;
        }
      }
    } else if (isReview(to)) {
      const held = heldBy(card, now, agent.me, `move it to ${to}`);
      condition = reviewGuard(card, now, agent.me, to);
      if (to === 'done') {
        specs.push({ type: 'released', payload: { reason: 'done' } });
        lastClaim = endedClaim(held, now, 'released', 'done');
        claim = undefined;
      }
    } else {
      assertNotHeldByOther(card, now, agent.me);
      condition = activeOrMine(now, agent.me);
    }
    const { next, events } = withEvents(card, ctx.actor, now, specs, { column: to, pos, reopened, claim, lastClaim });
    return { next, events, condition };
  });
}

// Claims, heartbeats, acknowledgements, releases and moves: every operation whose rules depend on who holds a card.
import { GSI2 } from '../src/schema.ts';
import { RELEASE_REASONS, type CardView, type ClaimResponse, type Column, type Warning } from './api-types.ts';
import { appendEvents, toCardView, claimView, type CardFields } from './card-model.ts';
import { cardOp, type CardPlan } from './card-op.ts';
import { appendPos, columnOf, endedClaim, isBackward, pendingHumanEvents, rankOf, resolveTarget } from './cards.ts';
import type { Reply, RequestCtx } from './engine.ts';
import { ApiError, badRequest, claimHeld, notHolder } from './errors.ts';
import type { CardItem, ClaimItem } from './items.ts';
import { repoPartition } from './keys.ts';
import { queryAll, type Condition, type Deps } from './store.ts';
import { asObject, normalizeRepo, text } from './validate.ts';

const holderOf = (agentId: string, worktree: string) => `${agentId}#${worktree}`;

const ACTIVE_OR_MINE: Condition = {
  expr: 'attribute_not_exists(#claim) OR #claim.#leaseUntil < :now OR #claim.#holder = :me',
  names: { '#claim': 'claim', '#leaseUntil': 'leaseUntil', '#holder': 'holder' },
};

const HOLDER_IS_ME: Condition = {
  expr: '#claim.#holder = :me',
  names: { '#claim': 'claim', '#holder': 'holder' },
};

function agentWorktree(
  ctx: RequestCtx,
  body: Record<string, unknown>,
): { agentId: string; worktree: string; me: string } {
  if (ctx.actor.kind !== 'agent') throw badRequest('This route is for agents.');
  const worktree = typeof body.worktree === 'string' ? body.worktree.trim() : '';
  if (!worktree) {
    throw new ApiError(
      400,
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
      400,
      'missing_worktree',
      `A claim records where the work happens, so ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required. Run from a git checkout: the CLI reads repo from the origin URL, worktree from \`git rev-parse --show-toplevel\` and branch from \`git rev-parse --abbrev-ref HEAD\`.`,
    );
  }
  const { agentId, worktree, me } = agentWorktree(ctx, body);
  const repo = normalizeRepo(body.repo);
  const branch = (text(body.branch, 'branch', { max: 255 }) as string).trim();
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
  const { leaseMs, heartbeatSeconds } = deps.config;
  if (card.repo !== a.repo) {
    throw new ApiError(
      409,
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
  const lease = { heartbeatAt: now, leaseUntil: now + leaseMs };
  const timing = { leaseSeconds: Math.round(leaseMs / 1000), heartbeatSeconds };

  if (existing && existing.holder === a.me) {
    // Taking a card you hold writes only the lease and where you are now: no second claim, no second event (Requirement 1.4).
    const claim: ClaimItem = { ...existing, branch: a.branch, session: a.session, ...lease };
    const next: CardFields = { ...card, claim };
    return {
      next,
      checkSeq: false,
      touch: false,
      condition: { ...HOLDER_IS_ME, values: { ':me': a.me } },
      respond: (view: CardView): ClaimResponse => ({
        card: view,
        warnings: [],
        pending: [],
        alreadyHeld: true,
        ...timing,
      }),
    };
  }

  if (existing && existing.leaseUntil >= now) throw claimHeld(toCardView(card, now, true), claimView(existing, now));

  const claim: ClaimItem = {
    agentId: a.agentId,
    holder: a.me,
    repo: a.repo,
    worktree: a.worktree,
    branch: a.branch,
    session: a.session,
    claimedAt: now,
    ...lease,
  };
  const specs: { type: 'claimed' | 'taken_over' | 'moved'; payload: Record<string, unknown> }[] = [
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
  let column: Column = card.column;
  let pos = card.pos;
  const from = rankOf(card.column);
  const to = a.advanceTo ? rankOf(a.advanceTo) : null;
  if (a.advanceTo && from !== null && to !== null && from < to) {
    column = a.advanceTo;
    pos = await appendPos(deps, card.projectId, column);
    specs.push({ type: 'moved', payload: { from: card.column, to: column } });
  }
  const { events, seq, lastHumanSeq } = appendEvents(card, { kind: 'agent', id: a.agentId }, now, specs);
  const next: CardFields = {
    ...card,
    column,
    pos,
    claim,
    lastAgentId: a.agentId,
    lastClaim: existing ? endedClaim(existing, now, 'taken_over', null) : card.lastClaim,
    // A claim that grants ownership clears `reopened` (Requirement 4.2).
    reopened: false,
    seq,
    lastHumanSeq,
    updatedAt: now,
  };
  const warnings = await branchWarnings(deps, card, a, now);
  const pending = await pendingHumanEvents(deps, card);
  return {
    next,
    events,
    condition: { ...ACTIVE_OR_MINE, values: { ':now': now, ':me': a.me } },
    status: 200,
    respond: (view: CardView): ClaimResponse => ({ card: view, warnings, pending, alreadyHeld: false, ...timing }),
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
    .filter(
      (o) => o.id !== card.id && !o.archived && o.claim && o.claim.branch === a.branch && o.claim.leaseUntil >= now,
    )
    .map((o) => ({
      code: 'branch_reused' as const,
      message: `Branch ${a.branch} already carries an active claim on card ${o.key ?? o.id} ("${o.title}"). Two cards on one branch tangle their commits; use a branch per card unless that is intended.`,
      card: { id: o.id, title: o.title, key: o.key ?? null },
    }));
}

export function heartbeatCard(deps: Deps, ctx: RequestCtx, id: string, input: unknown): Promise<Reply> {
  const { me } = agentWorktree(ctx, asObject(input));
  return cardOp(deps, ctx, id, (card, now) => {
    const view = toCardView(card, now, false);
    if (!card.claim || card.claim.holder !== me) throw notHolder(view, 'send a heartbeat');
    const { leaseMs, heartbeatSeconds } = deps.config;
    const claim: ClaimItem = { ...card.claim, heartbeatAt: now, leaseUntil: now + leaseMs };
    return {
      next: { ...card, claim },
      checkSeq: false,
      touch: false,
      condition: { ...HOLDER_IS_ME, values: { ':me': me } },
      respond: (updated) => {
        const { body: _body, ...lean } = updated;
        return { card: lean, leaseSeconds: Math.round(leaseMs / 1000), heartbeatSeconds };
      },
    };
  });
}

export async function ackCard(deps: Deps, ctx: RequestCtx, id: string, input: unknown): Promise<Reply> {
  if (ctx.actor.kind !== 'agent') throw badRequest('This route is for agents.');
  const agentId = ctx.actor.id;
  const seq = asObject(input).seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0)
    throw badRequest('seq must be a whole number: the latest sequence you have read.');
  return cardOp(deps, ctx, id, (card, now) => {
    const view = toCardView(card, now, false);
    if (card.lastAgentId !== agentId) {
      throw new ApiError(
        409,
        'not_holder',
        card.lastAgentId
          ? `Only the agent that last held card ${card.key ?? card.id} (${card.lastAgentId}) can acknowledge it.`
          : `Card ${card.key ?? card.id} has never been taken, so there is nothing to acknowledge. Take it first with \`baton take\`.`,
        { card: view },
      );
    }
    if (seq > card.seq) {
      throw new ApiError(
        409,
        'seq_ahead',
        `Card ${card.key ?? card.id} is at sequence ${card.seq}; you tried to acknowledge ${seq}. Run \`baton check ${card.key ?? card.id}\` and acknowledge the sequence it reports.`,
        { card: view, seq: card.seq },
      );
    }
    if (seq <= card.ackedSeq) return { next: card, noop: true, respond: (v) => ({ card: v }) };
    return {
      next: { ...card, ackedSeq: seq, updatedAt: now },
      checkSeq: false,
      touch: false,
      condition: {
        expr: '#last = :me AND #seq >= :n AND #acked < :n',
        names: { '#last': 'lastAgentId', '#seq': 'seq', '#acked': 'ackedSeq' },
        values: { ':me': agentId, ':n': seq },
      },
      respond: (v) => ({ card: v }),
    };
  });
}

function unacked(card: CardItem, now: number, to: string): ApiError {
  return new ApiError(
    409,
    'unacked_comments',
    `Card ${card.key ?? card.id} has human activity up to sequence ${card.lastHumanSeq} that you have not acknowledged (you are at ${card.ackedSeq}), so it cannot go to ${to}. ` +
      `Run \`baton check ${card.key ?? card.id}\`, read and answer it, run \`baton ack ${card.key ?? card.id}\`, then try again.`,
    { card: toCardView(card, now, false), seq: card.lastHumanSeq },
  );
}

const ACKED_AND_HOLDER = (me: string): Condition => ({
  expr: '#claim.#holder = :me AND #acked >= #human',
  names: { '#claim': 'claim', '#holder': 'holder', '#acked': 'ackedSeq', '#human': 'lastHumanSeq' },
  values: { ':me': me },
});

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
    const view = toCardView(card, now, false);
    const claim = card.claim;
    if (!claim || claim.holder !== me) throw notHolder(view, 'release it');
    const toReview = to === 'in_review' || to === 'done';
    if (toReview && card.ackedSeq < card.lastHumanSeq) throw unacked(card, now, to);
    const specs: { type: 'commented' | 'released'; payload: Record<string, unknown> }[] = [];
    if (comment?.trim()) specs.push({ type: 'commented', payload: { text: comment.trim() } });
    specs.push({ type: 'released', payload: { reason, ...(to ? { to } : {}) } });
    const { events, seq, lastHumanSeq } = appendEvents(card, { kind: 'agent', id: agentId }, now, specs);
    const target = to ? await resolveTarget(deps, card, to, body.pos) : undefined;
    return {
      next: {
        ...card,
        claim: undefined,
        lastClaim: endedClaim(claim, now, 'released', reason),
        ...(target ? { column: target.to, pos: target.pos } : {}),
        seq,
        lastHumanSeq,
        updatedAt: now,
      },
      events,
      condition: toReview ? ACKED_AND_HOLDER(me) : { ...HOLDER_IS_ME, values: { ':me': me } },
      respond: (updated) => ({ card: updated }),
    };
  });
}

export function moveCard(deps: Deps, ctx: RequestCtx, id: string, input: unknown): Promise<Reply> {
  const body = asObject(input);
  const to = columnOf(body.to, 'to');
  const agent = ctx.actor.kind === 'agent' ? agentWorktree(ctx, body) : undefined;
  return cardOp(deps, ctx, id, async (card, now) => {
    const target = await resolveTarget(deps, card, to, body.pos);
    const from = card.column;
    const specs: { type: 'moved' | 'released'; payload: Record<string, unknown> }[] = [
      { type: 'moved', payload: { from, to } },
    ];
    let claim = card.claim;
    let ended: CardFields['lastClaim'] = card.lastClaim;
    let condition: Condition | undefined;
    let reopened = card.reopened;

    if (!agent) {
      // A human move. Backward means the work is not done; Done releases whatever claim is there.
      if (isBackward(from, to)) reopened = true;
      if (to === 'done') {
        reopened = false;
        if (claim) {
          specs.push({ type: 'released', payload: { reason: 'human_done' } });
          ended = endedClaim(claim, now, 'human_done', 'human_done');
          claim = undefined;
        }
      }
    } else {
      const view = toCardView(card, now, false);
      const toReview = to === 'in_review' || to === 'done';
      if (toReview) {
        if (!card.claim || card.claim.holder !== agent.me) throw notHolder(view, `move it to ${to}`);
        if (card.ackedSeq < card.lastHumanSeq) throw unacked(card, now, to);
        condition = ACKED_AND_HOLDER(agent.me);
        if (to === 'done') {
          specs.push({ type: 'released', payload: { reason: 'done' } });
          ended = endedClaim(card.claim, now, 'released', 'done');
          claim = undefined;
        }
      } else if (card.claim && card.claim.leaseUntil >= now && card.claim.holder !== agent.me) {
        throw claimHeld(toCardView(card, now, true), claimView(card.claim, now));
      } else {
        condition = { ...ACTIVE_OR_MINE, values: { ':now': now, ':me': agent.me } };
      }
    }
    const { events, seq, lastHumanSeq } = appendEvents(card, ctx.actor, now, specs);
    return {
      next: {
        ...card,
        column: target.to,
        pos: target.pos,
        reopened,
        claim,
        lastClaim: ended,
        seq,
        lastHumanSeq,
        updatedAt: now,
      },
      events,
      condition,
      respond: (view) => ({ card: view }),
    };
  });
}

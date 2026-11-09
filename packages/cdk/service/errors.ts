import type { ApiErrorBody, CardView, ClaimView, ErrorCode } from './api-types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(status: number, code: ErrorCode, message: string, extra: Omit<ApiErrorBody, 'code' | 'message'> = {}) {
    super(message);
    this.status = status;
    this.body = { code, message, ...extra };
  }
}

export const badRequest = (message: string) => new ApiError(400, 'invalid_request', message);
export const notFound = (message: string) => new ApiError(404, 'not_found', message);
export const unauthorized = (message: string) => new ApiError(401, 'unauthorized', message);
export const forbidden = (message: string) => new ApiError(403, 'forbidden', message);

export const claimHeld = (card: CardView, claim: ClaimView) =>
  new ApiError(
    409,
    'claim_held',
    `Card ${card.key ?? card.id} is held by ${claim.agentId} in ${claim.worktree} on branch ${claim.branch}, last heard ${new Date(claim.heartbeatAt).toISOString()}. ` +
      'Pick another card with `baton list`, or wait until the lease ends and the card shows as stale, then take it.',
    { card, claim },
  );

export const notHolder = (card: CardView, what: string) =>
  new ApiError(
    409,
    'not_holder',
    `You do not hold card ${card.key ?? card.id}, so you cannot ${what}. ` +
      (card.claim
        ? `It is held by ${card.claim.agentId} in ${card.claim.worktree}. Stop work on it, or take it again if its lease has expired.`
        : 'It has no active claim. Take it first with `baton take`.'),
    card.claim ? { card, claim: card.claim } : { card },
  );

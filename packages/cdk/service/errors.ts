import type { ApiErrorBody, CardView, ClaimView, ErrorCode } from './api-types.ts';

/** Every error code answers with one status, so a throw site names the code and nothing else. */
const ERROR_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  missing_worktree: 400,
  unauthorized: 401,
  token_revoked: 401,
  token_expired: 401,
  forbidden: 403,
  not_found: 404,
  claim_held: 409,
  not_holder: 409,
  seq_ahead: 409,
  unacked_comments: 409,
  repo_mismatch: 409,
  repo_unregistered: 409,
  repo_taken: 409,
  name_taken: 409,
  project_has_claims: 409,
  conflict: 409,
  idempotent_replay: 422,
  payload_too_large: 413,
  internal: 500,
};

/** Every code the API can answer with. */
export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;

  constructor(code: ErrorCode, message: string, extra: Omit<ApiErrorBody, 'code' | 'message'> = {}) {
    super(message);
    this.status = ERROR_STATUS[code];
    this.body = { code, message, ...extra };
  }
}

export const badRequest = (message: string) => new ApiError('invalid_request', message);
export const notFound = (message: string) => new ApiError('not_found', message);
export const unauthorized = (message: string) => new ApiError('unauthorized', message);
export const forbidden = (message: string) => new ApiError('forbidden', message);

export const claimHeld = (card: CardView, claim: ClaimView) =>
  new ApiError(
    'claim_held',
    `Card ${card.key ?? card.id} is held by ${claim.agentId} in ${claim.worktree} on branch ${claim.branch}, last heard ${new Date(claim.heartbeatAt).toISOString()}. ` +
      'Pick another card with `baton list`, or wait until the lease ends and the card shows as stale, then take it.',
    { card, claim },
  );

export const notHolder = (card: CardView, what: string) =>
  new ApiError(
    'not_holder',
    `You do not hold card ${card.key ?? card.id}, so you cannot ${what}. ` +
      (card.claim
        ? `It is held by ${card.claim.agentId} in ${card.claim.worktree}. Stop work on it, or take it again if its lease has expired.`
        : 'It has no active claim. Take it first with `baton take`.'),
    card.claim ? { card, claim: card.claim } : { card },
  );

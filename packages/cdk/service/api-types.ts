// The wire contract. The web app and the tests import these types; the CLI prints whatever the API returns and keeps no copy.

export const COLUMNS = ['backlog', 'ready', 'in_progress', 'in_review', 'done', 'blocked'] as const;
export type Column = (typeof COLUMNS)[number];

/** Board order. `blocked` sits outside it: it never counts as backward or forward. */
export const COLUMN_RANK: Record<Column, number | null> = {
  backlog: 0,
  ready: 1,
  in_progress: 2,
  in_review: 3,
  done: 4,
  blocked: null,
};

export const RELEASE_REASONS = ['done', 'paused', 'blocked', 'session_ended'] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

export type ErrorCode =
  | 'claim_held'
  | 'not_holder'
  | 'seq_ahead'
  | 'unacked_comments'
  | 'missing_worktree'
  | 'repo_mismatch'
  | 'token_revoked'
  | 'idempotent_replay'
  | 'repo_unregistered'
  | 'repo_taken'
  | 'name_taken'
  | 'project_has_claims'
  | 'invalid_request'
  | 'not_found'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'internal';

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  card?: CardView;
  claim?: ClaimView;
  /** The sequence the refusal is about: the unacknowledged human event, or the card's current sequence. */
  seq?: number;
  /** The project that already holds a repo or a name. */
  project?: { id: string; name: string };
}

export type ActorKind = 'human' | 'agent';
export interface Actor {
  kind: ActorKind;
  id: string;
}

export type CardState = 'claimed' | 'stale' | 'unowned' | 'unclaimed';

export interface ClaimView {
  agentId: string;
  repo: string;
  worktree: string;
  branch: string;
  session: string | null;
  claimedAt: number;
  heartbeatAt: number;
  leaseUntil: number;
  stale: boolean;
}

/** Where the last claim was left, so a later agent resumes in the right worktree and branch. */
export interface LastClaimView {
  agentId: string;
  repo: string;
  worktree: string;
  branch: string;
  session: string | null;
  endedAt: number;
  endedBy: 'released' | 'taken_over' | 'human_done' | 'archived';
  reason: string | null;
}

export interface CardView {
  id: string;
  projectId: string;
  key: string | null;
  title: string;
  /** Left out of listings; present on a single card. */
  body?: string;
  repo: string;
  column: Column;
  pos: string;
  seq: number;
  lastHumanSeq: number;
  lastAgentId: string | null;
  ackedSeq: number;
  reopened: boolean;
  archived: boolean;
  links: string[];
  claim: ClaimView | null;
  lastClaim: LastClaimView | null;
  state: CardState;
  /** The last agent has not acknowledged the latest human event. */
  unread: boolean;
  createdAt: number;
  updatedAt: number;
}

export type EventType = 'created' | 'edited' | 'moved' | 'commented' | 'claimed' | 'taken_over' | 'released';

export interface EventView {
  seq: number;
  at: number;
  actor: Actor;
  type: EventType;
  payload: Record<string, unknown>;
}

export interface ProjectCounts {
  total: number;
  claimed: number;
  stale: number;
  unowned: number;
  reopened: number;
  unread: number;
  inReview: number;
}

export interface ProjectView {
  id: string;
  name: string;
  repos: string[];
  archived: boolean;
  lastEventAt: number;
  createdAt: number;
  counts?: ProjectCounts;
}

export interface AgentTokenView {
  tokenId: string;
  label: string;
  createdAt: number;
}

export interface AgentView {
  id: string;
  name: string;
  createdAt: number;
  tokens: AgentTokenView[];
}

export interface Warning {
  code: 'branch_reused';
  message: string;
  card: { id: string; title: string; key: string | null };
}

export interface ClaimResponse {
  card: CardView;
  warnings: Warning[];
  /** Human events after the card's acknowledged sequence, so the agent reads them as it takes the card. */
  pending: EventView[];
  /** True when this agent already held the card: nothing was written but the lease. */
  alreadyHeld: boolean;
  leaseSeconds: number;
  heartbeatSeconds: number;
}

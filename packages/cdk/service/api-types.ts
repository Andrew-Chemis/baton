// The wire contract. The web app and the tests import these types; the CLI prints whatever the API returns and keeps no copy.

export const COLUMNS = ['backlog', 'ready', 'in_progress', 'in_review', 'done', 'blocked'] as const;
export type Column = (typeof COLUMNS)[number];

/** The board's flow, left to right. `blocked` sits outside it: it never counts as backward or forward. */
const FLOW: readonly Column[] = COLUMNS.filter((column) => column !== 'blocked');

/** Review and Done are where an agent says the work is finished. */
export const isReview = (column: Column | undefined): column is 'in_review' | 'done' =>
  column === 'in_review' || column === 'done';

/** `to` is further along the flow than `from`. */
export const isForward = (from: Column, to: Column): boolean => {
  const a = FLOW.indexOf(from);
  const b = FLOW.indexOf(to);
  return a >= 0 && b > a;
};

/** `to` is earlier in the flow than `from`: for a human move, the work is not done (Requirement 4.1). */
export const isBackward = (from: Column, to: Column): boolean => isForward(to, from);

export const RELEASE_REASONS = ['done', 'paused', 'blocked', 'session_ended'] as const;

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

/** How a claim ended. */
export type ClaimEnd = 'released' | 'taken_over' | 'human_done' | 'archived';

/** Where the last claim was left, so a later agent resumes in the right worktree and branch. */
export interface LastClaimView {
  agentId: string;
  repo: string;
  worktree: string;
  branch: string;
  session: string | null;
  endedAt: number;
  endedBy: ClaimEnd;
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

/** The card fields an edit event records, only those that changed. */
export type CardEdit = { title?: string; body?: string; links?: string[] };

/** What each kind of event carries, as the board writes it. */
export type EventPayloads = {
  created: { title: string; column: Column; key?: string };
  edited: { archived: true } | CardEdit;
  moved: { from: Column; to: Column };
  commented: { text: string };
  claimed: { worktree: string; branch: string; session: string | null };
  taken_over: {
    previous: { agentId: string; worktree: string; branch: string; heartbeatAt: number };
    worktree: string;
    branch: string;
    session: string | null;
  };
  released: { reason: string; to?: Column };
};

export type EventType = keyof EventPayloads;

/** An event's type with the payload that type carries. */
export type EventBody = { [T in EventType]: { type: T; payload: EventPayloads[T] } }[EventType];

export type EventView = { seq: number; at: number; actor: Actor } & EventBody;

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

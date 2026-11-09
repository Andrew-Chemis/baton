// What is stored. The wire shapes live in api-types.ts; card-model.ts turns one into the other.
import type { Actor, Column, EventType, LastClaimView } from './api-types.ts';

export interface ClaimItem {
  agentId: string;
  /** `<agentId>#<worktree>`: what the claim conditions compare. One shared token serves many sessions, so the agent id alone cannot. */
  holder: string;
  repo: string;
  worktree: string;
  branch: string;
  session: string | null;
  claimedAt: number;
  heartbeatAt: number;
  leaseUntil: number;
}

/** Stored as it is sent. */
export type LastClaimItem = LastClaimView;

export interface CardItem {
  PK: string;
  SK: 'META';
  GSI1PK: string;
  GSI1SK: string;
  GSI2PK: string;
  GSI2SK: string;
  GSI3PK?: string | undefined;
  GSI3SK?: string | undefined;
  type: 'card';
  id: string;
  projectId: string;
  key?: string | undefined;
  title: string;
  body: string;
  repo: string;
  column: Column;
  pos: string;
  seq: number;
  lastHumanSeq: number;
  lastAgentId?: string | undefined;
  ackedSeq: number;
  reopened: boolean;
  archived: boolean;
  links: string[];
  claim?: ClaimItem | undefined;
  lastClaim?: LastClaimItem | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface EventItem {
  PK: string;
  SK: string;
  type: 'event';
  cardId: string;
  seq: number;
  at: number;
  actor: Actor;
  eventType: EventType;
  payload: Record<string, unknown>;
}

export interface ProjectItem {
  PK: string;
  SK: 'META';
  GSI1PK: string;
  GSI1SK: string;
  type: 'project';
  id: string;
  name: string;
  nameKey: string;
  repos: string[];
  archived: boolean;
  rev: number;
  lastEventAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentItem {
  PK: string;
  SK: 'META';
  GSI1PK: string;
  GSI1SK: string;
  type: 'agent';
  id: string;
  name: string;
  createdAt: number;
}

export interface AgentTokenItem {
  PK: string;
  SK: string;
  type: 'agent-token';
  tokenId: string;
  sha256: string;
  label: string;
  createdAt: number;
}

export interface TokenItem {
  PK: string;
  SK: 'META';
  type: 'token';
  agentId: string;
  tokenId: string;
  createdAt: number;
  revokedAt?: number | undefined;
  ttl?: number | undefined;
}

export interface IdempotencyItem {
  PK: string;
  SK: 'META';
  type: 'idempotency';
  fingerprint: string;
  status: number;
  body: string;
  expiresAt: number;
  ttl: number;
}

import type { Column } from './api-types.ts';

export const projectKey = (id: string) => ({ PK: `PROJECT#${id}`, SK: 'META' });
export const projectNameKey = (nameKey: string) => ({ PK: `PNAME#${nameKey}`, SK: 'META' });
export const repoKey = (repo: string) => ({ PK: `REPO#${repo}`, SK: 'META' });
export const cardKey = (id: string) => ({ PK: `CARD#${id}`, SK: 'META' });
const eventSort = (seq: number) => `EVT#${String(seq).padStart(8, '0')}`;
export const eventKey = (cardId: string, seq: number) => ({ PK: cardKey(cardId).PK, SK: eventSort(seq) });
/** Sort-key bounds of the events after `since`: a BETWEEN, because the card's own META item sorts after every EVT# key. */
export const eventRange = (since: number) => ({ lo: eventSort(since + 1), hi: 'EVT#99999999' });
export const cardKeyItem = (key: string) => ({ PK: `KEY#${key}`, SK: 'META' });
export const agentKey = (id: string) => ({ PK: `AGENT#${id}`, SK: 'META' });
export const AGENT_TOKEN_PREFIX = 'TOK#';
export const agentTokenKey = (agentId: string, tokenId: string) => ({
  PK: agentKey(agentId).PK,
  SK: `${AGENT_TOKEN_PREFIX}${tokenId}`,
});
export const tokenKey = (sha256: string) => ({ PK: `TOKEN#${sha256}`, SK: 'META' });
export const idempotencyKey = (actor: string, key: string) => ({ PK: `IDEM#${actor}#${key}`, SK: 'META' });

export const boardPartition = (projectId: string) => `BOARD#${projectId}`;
export const columnPrefix = (column: Column) => `COL#${column}#`;
export const boardSort = (column: Column, pos: string, id: string) => `COL#${column}#${pos}#${id}`;
export const PROJECTS_PARTITION = 'PROJECTS';
export const ARCHIVED_PROJECTS_PARTITION = 'PROJECTS#ARCHIVED';
export const AGENTS_PARTITION = 'AGENTS';
export const repoPartition = (repo: string) => `REPO#${repo}`;
export const attentionPartition = (agentId: string) => `ATTN#${agentId}`;

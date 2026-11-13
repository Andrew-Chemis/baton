// Agent identities and their bearer tokens (Requirement 7.1). A token is shown once and stored only as its SHA-256.
import { hash } from 'node:crypto';
import { GSI1 } from '../src/schema.ts';
import type { AgentTokenView, AgentView } from './api-types.ts';
import { execute, type Reply, type RequestCtx } from './engine.ts';
import { ApiError, badRequest, notFound } from './errors.ts';
import { newId, newToken, slugify } from './ids.ts';
import type { AgentItem, AgentTokenItem, TokenItem } from './items.ts';
import { AGENT_TOKEN_PREFIX, AGENTS_PARTITION, agentKey, agentTokenKey, tokenKey } from './keys.ts';
import {
  conditionCheck,
  deleteItem,
  EXISTS,
  getItem,
  putItem,
  putNew,
  queryAll,
  updateItem,
  type Deps,
  type TransactItem,
} from './store.ts';
import { asObject, normalizeName, text } from './validate.ts';

const MAX_TOKENS_PER_AGENT = 20;
const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = (value: string) => hash('sha256', value);

const tokenView = (t: AgentTokenItem): AgentTokenView => ({
  tokenId: t.tokenId,
  label: t.label,
  createdAt: t.createdAt,
});

async function tokensOf(deps: Deps, agentId: string): Promise<AgentTokenItem[]> {
  return queryAll<AgentTokenItem>(deps, {
    KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :prefix)',
    ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
    ExpressionAttributeValues: { ':pk': agentKey(agentId).PK, ':prefix': AGENT_TOKEN_PREFIX },
  });
}

export async function listAgents(deps: Deps): Promise<{ agents: AgentView[] }> {
  const agents = await queryAll<AgentItem>(deps, {
    IndexName: GSI1.name,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': GSI1.pk },
    ExpressionAttributeValues: { ':pk': AGENTS_PARTITION },
  });
  return {
    agents: await Promise.all(
      agents.map(async (a) => ({
        id: a.id,
        name: a.name,
        createdAt: a.createdAt,
        tokens: (await tokensOf(deps, a.id)).map(tokenView),
      })),
    ),
  };
}

export function createAgent(deps: Deps, ctx: RequestCtx, input: unknown): Promise<Reply> {
  const { name } = normalizeName(asObject(input).name);
  const id = slugify(name);
  return execute(deps, ctx, async (now) => {
    const item: AgentItem = {
      ...agentKey(id),
      SK: 'META',
      type: 'agent',
      id,
      name,
      GSI1PK: AGENTS_PARTITION,
      GSI1SK: id,
      createdAt: now,
    };
    return {
      items: [putNew(item)],
      reply: { status: 201, body: { agent: { id, name, createdAt: now, tokens: [] } satisfies AgentView } },
      classify: (c) =>
        c.failed(0)
          ? new ApiError(
              'name_taken',
              `An agent identity "${id}" already exists. Pick another name, or add a token to that agent.`,
            )
          : undefined,
    };
  });
}

export function deleteAgent(deps: Deps, ctx: RequestCtx, id: string): Promise<Reply> {
  return execute(deps, ctx, async (now) => {
    const agent = await getItem<AgentItem>(deps, agentKey(id));
    if (!agent) throw notFound(`No agent "${id}".`);
    const tokens = await tokensOf(deps, id);
    const items: TransactItem[] = [deleteItem(agentKey(id), EXISTS)];
    for (const t of tokens) {
      items.push(deleteItem(agentTokenKey(id, t.tokenId)));
      items.push(tombstone(t.sha256, now));
    }
    return { items, reply: { status: 200, body: { deleted: id, revokedTokens: tokens.length } }, retryOn: [0] };
  });
}

/** Revoked tokens stay as a short-lived tombstone so the API can answer `token_revoked` rather than a bare refusal. */
const tombstone = (sha: string, now: number): TransactItem =>
  updateItem(tokenKey(sha), {
    expr: 'SET #r = :now, #ttl = :ttl',
    names: { '#r': 'revokedAt', '#ttl': 'ttl' },
    values: { ':now': now, ':ttl': Math.ceil((now + TOMBSTONE_MS) / 1000) },
  });

export function createToken(deps: Deps, ctx: RequestCtx, agentId: string, input: unknown): Promise<Reply> {
  const label = (text(asObject(input).label, 'label', { max: 80, optional: true }) ?? 'token').trim() || 'token';
  return execute(deps, ctx, async (now) => {
    const agent = await getItem<AgentItem>(deps, agentKey(agentId));
    if (!agent) throw notFound(`No agent "${agentId}". Create it first.`);
    if ((await tokensOf(deps, agentId)).length >= MAX_TOKENS_PER_AGENT) {
      throw badRequest(
        `Agent "${agentId}" already has ${MAX_TOKENS_PER_AGENT} tokens. Revoke one you no longer use first.`,
      );
    }
    const token = newToken();
    const sha = sha256(token);
    const tokenId = newId(now);
    const tokenItem: TokenItem = { ...tokenKey(sha), SK: 'META', type: 'token', agentId, tokenId, createdAt: now };
    const listing: AgentTokenItem = {
      ...agentTokenKey(agentId, tokenId),
      type: 'agent-token',
      tokenId,
      sha256: sha,
      label,
      createdAt: now,
    };
    return {
      items: [putNew(tokenItem), putItem(listing), conditionCheck(agentKey(agentId))],
      reply: {
        status: 201,
        body: {
          token,
          tokenId,
          label,
          agentId,
          note: 'This is the only time the token is shown. Store it as BATON_TOKEN or in the SSM parameter the CLI reads.',
        },
        // A replay must not hand the secret out of the idempotency record, so the record holds everything but the token.
        stored: {
          token: null,
          tokenId,
          label,
          agentId,
          note: 'This request was already completed and the token was shown once. Revoke it and issue a new one if it was lost.',
        },
      },
      retryOn: [2],
    };
  });
}

export function revokeToken(deps: Deps, ctx: RequestCtx, agentId: string, tokenId: string): Promise<Reply> {
  return execute(deps, ctx, async (now) => {
    const listing = await getItem<AgentTokenItem>(deps, agentTokenKey(agentId, tokenId));
    if (!listing) throw notFound(`Agent "${agentId}" has no token "${tokenId}" (it may already be revoked).`);
    return {
      items: [deleteItem(agentTokenKey(agentId, tokenId), EXISTS), tombstone(listing.sha256, now)],
      reply: { status: 200, body: { revoked: tokenId } },
    };
  });
}

type TokenVerdict = { verdict: 'ok'; agentId: string } | { verdict: 'revoked' | 'unknown' };

export async function verifyToken(deps: Deps, bearer: string): Promise<TokenVerdict> {
  if (!bearer.startsWith('baton_') || bearer.length > 200) return { verdict: 'unknown' };
  const item = await getItem<TokenItem>(deps, tokenKey(sha256(bearer)));
  if (!item) return { verdict: 'unknown' };
  if (item.revokedAt !== undefined) return { verdict: 'revoked' };
  return { verdict: 'ok', agentId: item.agentId };
}

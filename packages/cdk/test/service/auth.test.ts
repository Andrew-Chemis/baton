// Requirements 6.5 and 7.1, 7.3, 7.4: who may call what, and what a refusal tells the caller.
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { beforeAll, describe, expect, test } from 'vitest';
import { authorize, handleHttp } from '../../service/router.ts';
import { newAgent } from '../support/agents.ts';
import { claimBody, eventsOf, newCard, seeded, type Seeded } from '../support/board.ts';
import { httpEvent } from '../support/http-event.ts';

let s: Seeded;
beforeAll(async () => {
  s = await seeded();
});

const call = (path: string, authorizer: object | undefined, method = 'GET', body?: unknown) =>
  handleHttp(
    s.board.deps,
    httpEvent(method, path, { body: body === undefined ? undefined : JSON.stringify(body), authorizer }),
  );

describe('R6.5 and R7.1 routes reject calls that are not authenticated', () => {
  test('a human route without a JWT context is refused', async () => {
    const out = await call('/api/human/projects', undefined);
    expect(out.statusCode).toBe(401);
    expect(JSON.parse(out.body).code).toBe('unauthorized');
    expect((await call('/api/human/projects', { jwt: { claims: {} } })).statusCode).toBe(401);
  });

  test('an agent route without a token verdict is refused, and so is an unknown token', async () => {
    expect((await call('/api/agent/projects', undefined)).statusCode).toBe(401);
    const unknown = await authorize(s.board.deps, {
      type: 'REQUEST',
      routeArn: 'x',
      headers: { authorization: 'Bearer baton_nope' },
    });
    expect(unknown.context).toEqual({ verdict: 'unknown' });
    const out = await call('/api/agent/projects', unknown.context);
    expect(out.statusCode).toBe(401);
    expect(JSON.parse(out.body).message).toContain('BATON_TOKEN');
  });

  test('a human credential does not open an agent route, nor an agent credential a human route', async () => {
    const human = { jwt: { claims: { sub: 'u1', email: 'o@example.test' } } };
    const agent = { lambda: { verdict: 'ok', agentId: 'a1' } };
    expect((await call('/api/agent/projects', human)).statusCode).toBe(401);
    expect((await call('/api/human/projects', agent)).statusCode).toBe(401);
  });

  test('a route for the other kind of caller is refused with a pointer to the right prefix', async () => {
    const human = { jwt: { claims: { sub: 'u1', email: 'o@example.test' } } };
    const agent = { lambda: { verdict: 'ok', agentId: 'a1' } };
    const claim = await call('/api/human/cards/x/claim', human, 'POST', {});
    expect(claim.statusCode).toBe(403);
    expect(JSON.parse(claim.body).message).toContain('/api/agent/');
    const tokens = await call('/api/agent/agents', agent);
    expect(tokens.statusCode).toBe(403);
    expect(JSON.parse(tokens.body).message).toContain('/api/human/');
    expect((await call('/api/agent/cards/x/archive', agent, 'POST', {})).statusCode).toBe(403);
  });

  test('a path outside both prefixes is not found, and a route that does not exist is a 404 with the route named', async () => {
    const human = { jwt: { claims: { sub: 'u1' } } };
    expect((await call('/api/other', human)).statusCode).toBe(404);
    const out = await call('/api/human/nothing', human);
    expect(out.statusCode).toBe(404);
    expect(JSON.parse(out.body).message).toContain('/api/human/nothing');
  });

  test('a stray % in an address is a 400 that says so, not a 500', async () => {
    const human = { jwt: { claims: { sub: 'u1' } } };
    const out = await call('/api/human/cards/%zz', human);
    expect(out.statusCode).toBe(400);
    expect(JSON.parse(out.body)).toMatchObject({ code: 'invalid_request' });
    expect(JSON.parse(out.body).message).toContain('%zz');
    // A well-formed escape still decodes.
    expect((await call('/api/human/cards/%7Enone', human)).statusCode).toBe(404);
  });
});

describe('R7.1 tokens: issued and revoked from the board, stored only as a hash', () => {
  test('a human issues a token that works as a bearer token; revoking it stops it, with token_revoked', async () => {
    const { id: agentId, token, tokenId } = await newAgent(s.human, 'Remote Claude', { label: 'laptop' });
    expect(token.startsWith('baton_')).toBe(true);

    const withToken = s.board.withToken(token);
    const card = await newCard(s.human);
    const claim = await withToken.post(`/cards/${card.id}/claim`, claimBody());
    expect(claim.status).toBe(200);
    expect(claim.body.card.claim.agentId).toBe(agentId);
    expect((await eventsOf(withToken, card.id)).at(-1)?.actor).toEqual({ kind: 'agent', id: agentId });

    const listed = await s.human.get('/agents');
    expect(listed.body.agents.find((a: any) => a.id === agentId).tokens).toEqual([
      { tokenId, label: 'laptop', createdAt: expect.any(Number) },
    ]);

    const revoked = await s.human.del(`/agents/${agentId}/tokens/${tokenId}`);
    expect(revoked.status).toBe(200);
    const after = await withToken.get(`/cards/${card.id}`);
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('token_revoked');
    expect(after.body.message).toContain('Agents page');
    expect((await s.human.get('/agents')).body.agents.find((a: any) => a.id === agentId).tokens).toEqual([]);
  });

  test('only the hash is stored: the token appears nowhere in the table', async () => {
    const { id, token } = await newAgent(s.human, 'Hash check', { key: 'issue-1' });
    await s.human.post(`/agents/${id}/tokens`, {}, 'issue-1');
    let dump = '';
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await s.board.deps.db.send(
        new ScanCommand({ TableName: s.board.table, ...(startKey ? { ExclusiveStartKey: startKey } : {}) }),
      );
      dump += JSON.stringify(page.Items);
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token.slice(6));
    expect(dump).toContain('TOKEN#');
  });

  test('deleting an agent revokes every token it holds', async () => {
    const { id, token: t1 } = await newAgent(s.human, 'Short lived');
    const t2 = (await s.human.post(`/agents/${id}/tokens`, {})).body.token as string;
    const out = await s.human.del(`/agents/${id}`);
    expect(out.body).toEqual({ deleted: id, revokedTokens: 2 });
    for (const t of [t1, t2]) expect((await s.board.withToken(t).get('/projects')).body.code).toBe('token_revoked');
  });

  test('a second agent with the same name is refused', async () => {
    await s.human.post('/agents', { name: 'Twin' });
    expect((await s.human.post('/agents', { name: 'twin' })).body.code).toBe('name_taken');
  });
});

describe('R7.3 events tell human and agent actors apart', () => {
  test('every event carries the kind of its actor, and humans are named by their email', async () => {
    const card = await newCard(s.human, { column: 'in_progress' });
    const agent = s.board.as({ agent: 'a1' });
    await agent.post(`/cards/${card.id}/claim`, claimBody());
    await agent.post(`/cards/${card.id}/comments`, { text: 'from the agent' });
    await s.human.post(`/cards/${card.id}/comments`, { text: 'from the human' });
    const log = await eventsOf(agent, card.id);
    expect(log.map((e: any) => `${e.actor.kind}:${e.actor.id}:${e.type}`)).toEqual([
      'human:owner@example.test:created',
      'agent:a1:claimed',
      'agent:a1:commented',
      'human:owner@example.test:commented',
    ]);
  });
});

describe('R7.4 refusals carry a code, the conflicting claim or sequence, and the next step', () => {
  test('each refusal names what to do next', async () => {
    const card = await newCard(s.human, { column: 'in_progress' });
    const a = s.board.as({ agent: 'a1' });
    const b = s.board.as({ agent: 'b2' });
    await a.post(`/cards/${card.id}/claim`, claimBody());
    const held = (await b.post(`/cards/${card.id}/claim`, claimBody({ worktree: '/w2' }))).body;
    expect(held).toMatchObject({ code: 'claim_held', claim: { agentId: 'a1' }, card: { id: card.id } });
    expect(held.message).toMatch(/baton list|wait/i);
    const notHolder = (await b.post(`/cards/${card.id}/heartbeat`, { worktree: '/w2' })).body;
    expect(notHolder).toMatchObject({ code: 'not_holder', claim: { agentId: 'a1' } });
    expect(notHolder.message).toMatch(/stop work|take it/i);
    const none = (await a.post(`/cards/${card.id}/claim`, { repo: 'acme/widgets' })).body;
    expect(none.code).toBe('missing_worktree');
    expect(none.message).toContain('git rev-parse');
  });

  test('malformed input is a 400 that says what was wrong', async () => {
    const bad = await s.human.post('/cards', { repo: 'nonsense', title: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_request');
    const noJson = await handleHttp(
      s.board.deps,
      httpEvent('POST', '/api/human/cards', { body: '{oops', authorizer: { jwt: { claims: { sub: 'u' } } } }),
    );
    expect(JSON.parse(noJson.body).message).toContain('valid JSON');
    expect((await s.human.get('/cards')).body.message).toContain('attention=me');
    expect((await s.human.get('/cards/doesnotexist')).status).toBe(404);
  });
});

// The board's own limits on who may do what and how much they may send: the admin group, token expiry and the body cap.
import { beforeAll, describe, expect, test } from 'vitest';
import { MAX_BODY_BYTES } from '../../src/schema.ts';
import { groupsOf, handleHttp } from '../../service/router.ts';
import { httpEvent } from '../support/http-event.ts';
import { seeded, type Seeded } from '../support/board.ts';

let s: Seeded;
beforeAll(async () => {
  s = await seeded();
});

const DAY = 24 * 60 * 60 * 1000;

describe('agent and token management is for the admin group', () => {
  test('a person outside the group is refused with a message that names the group; the board itself still works', async () => {
    const member = s.board.as({ human: 'member@example.test', admin: false });
    for (const [method, path] of [
      ['GET', '/agents'],
      ['POST', '/agents'],
      ['POST', '/agents/x/tokens'],
      ['DELETE', '/agents/x'],
      ['DELETE', '/agents/x/tokens/t'],
    ] as const) {
      const out =
        method === 'GET'
          ? await member.get(path)
          : method === 'POST'
            ? await member.post(path, { name: 'x' })
            : await member.del(path);
      expect(out.status, `${method} ${path}`).toBe(403);
      expect(out.body.message).toContain('"admins" group');
    }
    expect((await member.get('/projects')).status).toBe(200);
    expect((await s.human.get('/agents')).status).toBe(200);
  });

  test('groups arrive as the gateway flattens them, or as an array', () => {
    const event = (groups: unknown) =>
      httpEvent('GET', '/api/human/agents', {
        authorizer: { jwt: { claims: { sub: 'u', 'cognito:groups': groups } } },
      });
    expect(groupsOf(event('[admins readers]'))).toEqual(['admins', 'readers']);
    expect(groupsOf(event(['admins']))).toEqual(['admins']);
    expect(groupsOf(event(undefined))).toEqual([]);
    expect(groupsOf(event('[]'))).toEqual([]);
  });
});

describe('tokens expire', () => {
  test('a token lasts 90 days by default, a shorter span can be chosen, and an expired token says so', async () => {
    const agent = (await s.human.post('/agents', { name: 'Expiring' })).body.agent.id as string;
    const issued = await s.human.post(`/agents/${agent}/tokens`, { label: 'ci', expiresInDays: 7 });
    expect(issued.status).toBe(201);
    expect(issued.body.expiresAt).toBe(s.board.clock.now() + 7 * DAY);
    const plain = await s.human.post(`/agents/${agent}/tokens`, { label: 'laptop' });
    expect(plain.body.expiresAt).toBe(s.board.clock.now() + 90 * DAY);

    const caller = s.board.withToken(issued.body.token as string);
    expect((await caller.get('/projects')).status).toBe(200);
    s.board.clock.advance(7 * DAY);
    const expired = await caller.get('/projects');
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('token_expired');
    expect(expired.body.message).toContain('issue a new one');
    expect((await s.board.withToken(plain.body.token as string).get('/projects')).status).toBe(200);
  });

  test('an expiry outside 1 to 365 days is refused', async () => {
    const agent = (await s.human.post('/agents', { name: 'Bounds' })).body.agent.id as string;
    for (const expiresInDays of [0, 366, 1.5, '30']) {
      const out = await s.human.post(`/agents/${agent}/tokens`, { expiresInDays });
      expect(out.status, String(expiresInDays)).toBe(400);
    }
  });
});

describe('request size', () => {
  test('a body over the cap is a 413 before it is parsed; every answer says nosniff', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(MAX_BODY_BYTES) });
    const out = await handleHttp(
      s.board.deps,
      httpEvent('POST', '/api/human/projects', { body: big, authorizer: { jwt: { claims: { sub: 'u' } } } }),
    );
    expect(out.statusCode).toBe(413);
    expect(JSON.parse(out.body).code).toBe('payload_too_large');
    expect(out.headers['x-content-type-options']).toBe('nosniff');
  });
});

// The request log: one line per request, with the route's template, the outcome and the caller, and nothing a caller sent.
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { handleHttp } from '../../service/router.ts';
import { createTelemetry, metricsOf } from '../../service/telemetry.ts';
import { httpEvent } from '../support/http-event.ts';
import { MINUTE, REPO, claimBody, newCard, seeded, type Seeded } from '../support/board.ts';

let s: Seeded;
let lines: Record<string, any>[];
beforeAll(async () => {
  s = await seeded();
  lines = [];
  s.board.deps.telemetry = createTelemetry({ metrics: true, sink: (line) => lines.push(JSON.parse(line)) });
});

const last = () => lines.at(-1) as Record<string, any>;

describe('request lines', () => {
  test('a claim logs its route template, status, agent and the metric it counts', async () => {
    const card = await newCard(s.human);
    await s.board.as({ agent: 'a1' }).post(`/cards/${card.id}/claim`, claimBody());
    expect(last()).toMatchObject({
      level: 'INFO',
      msg: 'request',
      method: 'POST',
      route: 'POST /cards/:id/claim',
      status: 200,
      actor: { kind: 'agent', id: 'a1' },
      ClaimGranted: 1,
    });
    expect(last()['_aws'].CloudWatchMetrics[0]).toEqual({
      Namespace: 'Baton',
      Dimensions: [[]],
      Metrics: [{ Name: 'ClaimGranted', Unit: 'Count' }],
    });
    expect(JSON.stringify(last())).not.toContain(card.id);

    await s.board.as({ agent: 'a2' }).post(`/cards/${card.id}/claim`, claimBody({ worktree: '/w2' }));
    expect(last()).toMatchObject({ level: 'WARN', status: 409, code: 'claim_held', ClaimRefused: 1 });

    s.board.clock.advance(11 * MINUTE);
    await s.board.as({ agent: 'a2' }).post(`/cards/${card.id}/claim`, claimBody({ worktree: '/w2' }));
    expect(last()).toMatchObject({ status: 200, ClaimGranted: 1, ClaimTakenOver: 1 });
  });

  test('a person is logged by subject, never by email, and a comment body never appears', async () => {
    const card = await newCard(s.human);
    await s.human.post(`/cards/${card.id}/comments`, { text: 'secret plan for the launch' });
    expect(last().actor).toEqual({ kind: 'human', id: 'sub-owner@example.test' });
    expect(JSON.stringify(lines)).not.toContain('secret plan');
    expect(JSON.stringify(lines)).not.toContain('"owner@example.test"');
  });

  test('the request id is logged and returned, and an unknown path logs without a route', async () => {
    const event = httpEvent('GET', '/api/nowhere');
    event.requestContext.requestId = 'req-123';
    const out = await handleHttp(s.board.deps, event);
    expect(out.statusCode).toBe(404);
    expect(out.headers['x-request-id']).toBe('req-123');
    expect(last()).toMatchObject({ requestId: 'req-123', status: 404, code: 'not_found' });
    expect(last().route).toBeUndefined();
  });

  test('an unexpected failure is a 500 that quotes the request id, logged as an error with a ServerError metric', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { ...s.board.deps, db: { send: () => Promise.reject(new Error('boom')) } as never };
    const event = httpEvent('GET', `/api/human/cards?repo=${REPO}`, {
      authorizer: { jwt: { claims: { sub: 'sub-x' } } },
    });
    event.requestContext.requestId = 'req-500';
    const out = await handleHttp(broken, event);
    expect(out.statusCode).toBe(500);
    expect(JSON.parse(out.body).message).toContain('quote request req-500');
    expect(last()).toMatchObject({ level: 'ERROR', status: 500, ServerError: 1, route: 'GET /cards' });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe('metrics off', () => {
  test('the line is written without an embedded metric block', () => {
    const out: string[] = [];
    createTelemetry({ sink: (l) => out.push(l) }).request({
      requestId: 'r',
      method: 'GET',
      route: 'GET /cards',
      status: 500,
      code: 'internal',
      durationMs: 3,
      actor: undefined,
      metrics: metricsOf('GET /cards', 500, 'internal', {}),
    });
    const line = JSON.parse(out[0] as string);
    expect(line['_aws']).toBeUndefined();
    expect(line.ServerError).toBeUndefined();
    expect(line.level).toBe('ERROR');
  });
});

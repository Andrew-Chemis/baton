// docs/openapi.yaml is the published contract. This file keeps it honest: the document lists exactly the router's routes
// under exactly the prefixes that serve them, names exactly the error codes the service can answer with, and every response a
// full agent-and-person session produces validates against the schema the document gives for that operation and status.
import { Ajv2020 } from 'ajv/dist/2020.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { ERROR_CODES } from '../../service/errors.ts';
import { ROUTE_TABLE } from '../../service/router.ts';
import { MINUTE, REPO, claimBody, seeded, type Caller, type Result, type Seeded } from '../support/board.ts';

const doc: any = parse(readFileSync(join(import.meta.dirname, '../../../../docs/openapi.yaml'), 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
ajv.addSchema(doc, 'openapi');

const METHODS = ['get', 'post', 'patch', 'delete'] as const;
const escape = (s: string) => s.replaceAll('~', '~0').replaceAll('/', '~1');
const resolve = (ref: string) =>
  ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((node: any, part) => node[part.replaceAll('~1', '/').replaceAll('~0', '~')], doc);

/** Each documented operation, by `METHOD prefix/path`. */
function documented(): Set<string> {
  const out = new Set<string>();
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      for (const server of op.servers ?? item.servers ?? doc.servers)
        out.add(`${method.toUpperCase()} ${server.url}${path}`);
    }
  }
  return out;
}

const PREFIXES = {
  both: ['/api/human', '/api/agent'],
  human: ['/api/human'],
  admin: ['/api/human'],
  agent: ['/api/agent'],
};

describe('the document and the router agree', () => {
  test('every route is documented under exactly the prefixes that serve it, and nothing else is', () => {
    const served = new Set(ROUTE_TABLE.flatMap((r) => PREFIXES[r.who].map((p) => `${r.method} ${p}${r.path}`)));
    expect([...documented()].toSorted()).toEqual([...served].toSorted());
  });

  test('the error codes are the service’s, no more and no fewer', () => {
    const byText = (a: string, b: string) => a.localeCompare(b);
    expect([...(doc.components.schemas.ErrorCode.enum as string[])].toSorted(byText)).toEqual(
      [...ERROR_CODES].toSorted(byText),
    );
  });
});

/** The documented path template a concrete path falls under, if any. */
function templateOf(prefixed: string): string | undefined {
  const relative = prefixed.replace(/^\/api\/(human|agent)/, '').split('?')[0] as string;
  return Object.keys(doc.paths).find((template) =>
    new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(relative),
  );
}

/** Validates a body against what the document says `METHOD path` answers with `status`. */
function check(method: string, prefixed: string, status: number, body: unknown): string[] {
  const relative = prefixed.replace(/^\/api\/(human|agent)/, '').split('?')[0] as string;
  const entry = templateOf(prefixed);
  if (!entry) return [`no documented path for ${relative}`];
  const op = doc.paths[entry][method.toLowerCase()];
  if (!op) return [`${method} ${entry} is not documented`];
  const key = op.responses[String(status)] ? String(status) : 'default';
  let response = op.responses[key];
  let pointer = `#/paths/${escape(entry)}/${method.toLowerCase()}/responses/${key}`;
  if (!response) return [`${method} ${entry} documents no ${status}`];
  if (response.$ref) {
    pointer = response.$ref;
    response = resolve(response.$ref);
  }
  if (status < 400 && key === 'default') return [`${method} ${entry} answered ${status}, which it does not document`];
  const validate = ajv.getSchema(`openapi${pointer}/content/application~1json/schema`);
  if (!validate) return [`no schema at ${pointer}`];
  return validate(body)
    ? []
    : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message} ${JSON.stringify(e.params)}`);
}

let s: Seeded;
const seen = new Set<string>();
const problems: string[] = [];

/** A caller whose every answer is checked against the document. */
function checked(caller: Caller, prefix: string): Caller {
  const wrap =
    (method: string, fn: (path: string, ...rest: any[]) => Promise<Result>) =>
    async (path: string, ...rest: any[]) => {
      const out = await fn(path, ...rest);
      const issues = check(method, `${prefix}${path}`, out.status, out.body);
      problems.push(...issues.map((i) => `${method} ${path} → ${out.status}: ${i}`));
      seen.add(`${method} ${prefix}${templateOf(`${prefix}${path}`) ?? path}`);
      return out;
    };
  return {
    get: wrap('GET', caller.get),
    post: wrap('POST', caller.post),
    patch: wrap('PATCH', caller.patch),
    del: wrap('DELETE', caller.del),
  };
}

beforeAll(async () => {
  s = await seeded();
});

afterAll(() => {
  expect(problems).toEqual([]);
});

describe('real answers match the document', () => {
  test('a full session: register, cards, claims, comments, events, refusals, agents and tokens', async () => {
    const human = checked(s.human, '/api/human');
    const agent = checked(s.board.as({ agent: 'a1' }), '/api/agent');
    const other = checked(s.board.as({ agent: 'a2' }), '/api/agent');

    await human.get('/config');
    await agent.get('/config');
    await human.get('/projects');
    await agent.get(`/projects?repo=${REPO}`);
    await human.post('/projects', { name: 'Widgets', repos: [REPO] });
    await human.post('/projects', { name: 'Second', repos: ['acme/second'] });
    await human.patch('/projects/second', { addRepos: ['acme/third'] });
    await agent.post('/projects', { name: 'Third', repos: ['acme/fourth'] });
    await agent.patch('/projects/third', { name: 'Third project' });
    await agent.post('/projects/third/archive');

    const card = (await agent.post('/cards', { repo: REPO, title: 'Retry refunds', key: 'retry-refunds' })).body.card;
    await agent.post('/cards', { repo: REPO, title: 'Retry refunds', key: 'retry-refunds' });
    await human.post('/cards', { repo: 'acme/nowhere', title: 'x' });
    await human.get(`/cards?project=${s.projectId}`);
    await agent.get(`/cards?repo=${REPO}&column=backlog`);
    await agent.get(`/cards?key=${REPO}/retry-refunds`);
    await human.get(`/cards/${card.id}`);
    await human.patch(`/cards/${card.id}`, { body: 'Five tries, then give up.' });
    await agent.get(`/cards/${card.id}`);
    await agent.patch(`/cards/${card.id}`, { links: ['https://example.test/spec'] });
    await agent.post(`/cards/${card.id}/comments`, { text: 'Starting with the gateway stub.' });
    await human.get(`/cards/${card.id}/events?since=1`);

    await agent.post(`/cards/${card.id}/claim`, claimBody());
    await other.post(`/cards/${card.id}/claim`, claimBody({ worktree: '/elsewhere' }));
    await agent.post(`/cards/${card.id}/heartbeat`, { worktree: '/work/widgets' });
    await other.post(`/cards/${card.id}/heartbeat`, { worktree: '/elsewhere' });
    await human.post(`/cards/${card.id}/comments`, { text: 'Cover the iOS app too.' });
    await agent.get('/cards?attention=me');
    await agent.post(`/cards/${card.id}/move`, { to: 'in_review', worktree: '/work/widgets' });
    const events = (await agent.get(`/cards/${card.id}/events?since=0`)).body;
    await agent.post(`/cards/${card.id}/ack`, { seq: events.seq, worktree: '/work/widgets' });
    await agent.post(`/cards/${card.id}/release`, { worktree: '/work/widgets', reason: 'done', to: 'in_review' });
    await human.post(`/cards/${card.id}/move`, { to: 'in_progress' });

    const stale = (await human.post('/cards', { repo: REPO, title: 'Left behind' })).body.card;
    await other.post(`/cards/${stale.id}/claim`, claimBody({ worktree: '/elsewhere' }));
    s.board.clock.advance(11 * MINUTE);
    await agent.post(`/cards/${stale.id}/claim`, claimBody());
    await human.post(`/cards/${stale.id}/archive`);
    await human.get(`/cards?project=${s.projectId}&archived=1`);
    await human.post(`/cards/${stale.id}/claim`, claimBody());
    await human.post('/projects/second/archive');

    const made = (await human.post('/agents', { name: 'Laptop' })).body.agent;
    const token = (await human.post(`/agents/${made.id}/tokens`, { label: 'ci', expiresInDays: 30 })).body;
    await human.get('/agents');
    await human.post(`/agents/${made.id}/tokens`, { expiresInDays: 400 });
    await human.del(`/agents/${made.id}/tokens/${token.tokenId}`);
    await human.del(`/agents/${made.id}`);
    await human.get('/cards/nope00000000x');
    await human.post('/projects', '{not json');
  });

  test('the session reached every documented operation', () => {
    const missing = [...documented()].filter((op) => !seen.has(op));
    expect(missing).toEqual([]);
  });
});

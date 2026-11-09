// The board on your machine: the Lambda's router over DynamoDB Local, with the built web app, and no sign-in (there is no
// Cognito here; every request is made by owner@example.test). For trying the web app and for the browser check.
//   node scripts/dev-server.ts [--port 5173] [--seed] [--web packages/cdk/assets/web] [--ddb http://127.0.0.1:8000]
// Build the web app first: pnpm --filter @andrewchemis/baton-cdk run build:assets
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createDocClient, type Deps } from '../packages/cdk/service/store.ts';
import { createTable } from '../packages/cdk/test/support/table.ts';
import { startLocalServer } from '../packages/cdk/test/support/local-server.ts';
import { startDynamoDbLocal } from './dynamodb-local.ts';

const MINUTE = 60_000;

/** A clock that can be set back while seeding, so claims made then are already past their lease when the page loads. */
export function makeShiftClock() {
  let shift = 0;
  return { now: () => Date.now() + shift, shiftBy: (ms: number) => void (shift = ms) };
}

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

/** Projects and cards in every state the board can show: claimed, stale, unowned, reopened, unread, and combinations. */
export async function seedDemo(
  human: Call,
  agent: (token: string) => Call,
  shiftBy: (ms: number) => void,
): Promise<void> {
  const must = async <T extends { status: number; body: any }>(result: Promise<T>): Promise<T['body']> => {
    const r = await result;
    if (r.status >= 300) throw new Error(`seed step failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const token = async (name: string) => {
    const made = await must(human('POST', '/agents', { name }));
    return (await must(human('POST', `/agents/${made.agent.id}/tokens`, { label: 'demo' }))).token as string;
  };
  const nova = agent(await token('nova'));
  const orion = agent(await token('orion'));

  await must(
    human('POST', '/projects', { name: 'Payments platform', repos: ['acme/payments-api', 'acme/payments-web'] }),
  );
  await must(human('POST', '/projects', { name: 'Docs site', repos: ['acme/docs'] }));
  await must(human('POST', '/projects', { name: 'Mobile app', repos: ['acme/mobile'] }));
  await must(human('POST', '/projects', { name: 'Internal tools', repos: ['acme/tools'] }));

  const card = async (repo: string, title: string, key: string, column: string, body = '') =>
    (await must(human('POST', '/cards', { repo, title, key, column, body }))).card as { id: string };
  const claim = (call: Call, repo: string, id: string, branch: string, worktree: string) =>
    must(call('POST', `/cards/${id}/claim`, { repo, worktree, branch, session: 'demo-session' }));

  // Stale: claimed forty minutes ago and never heard from since.
  shiftBy(-40 * MINUTE);
  const refund = await card(
    'acme/payments-api',
    'Retry failed refunds with backoff',
    'refund-retry',
    'ready',
    'Refunds that time out should retry up to five times.',
  );
  await claim(orion, 'acme/payments-api', refund.id, 'fix/refund-retry', '/home/dev/payments-api-refund');
  const webhook = await card('acme/payments-api', 'Verify webhook signatures', 'webhook-sigs', 'ready');
  await claim(nova, 'acme/payments-api', webhook.id, 'feat/webhook-sigs', '/home/dev/payments-api-webhooks');
  shiftBy(0);

  // Claimed and fresh.
  const idem = await card('acme/payments-api', 'Idempotency keys on charge creation', 'idempotent-charges', 'ready');
  await claim(nova, 'acme/payments-api', idem.id, 'feat/idempotent-charges', '/home/dev/payments-api');
  const checkout = await card('acme/payments-web', 'Checkout form validation', 'checkout-validation', 'ready');
  await claim(orion, 'acme/payments-web', checkout.id, 'feat/checkout-validation', '/home/dev/payments-web');

  // Unowned: in progress with nobody on it.
  const receipts = await card('acme/payments-web', 'Receipt email template', 'receipt-email', 'backlog');
  await must(human('POST', `/cards/${receipts.id}/move`, { to: 'in_progress' }));

  // Reopened: finished, then moved back by a person.
  const fx = await card('acme/payments-api', 'Currency rounding in invoices', 'invoice-rounding', 'ready');
  await claim(nova, 'acme/payments-api', fx.id, 'fix/invoice-rounding', '/home/dev/payments-api-rounding');
  await must(
    nova('POST', `/cards/${fx.id}/release`, {
      worktree: '/home/dev/payments-api-rounding',
      reason: 'done',
      to: 'in_review',
    }),
  );
  await must(human('POST', `/cards/${fx.id}/move`, { to: 'ready' }));

  // Unread: passed to review, then a person commented.
  const sca = await card('acme/payments-web', 'Strong customer authentication flow', 'sca-flow', 'ready');
  await claim(orion, 'acme/payments-web', sca.id, 'feat/sca', '/home/dev/payments-web-sca');
  await must(
    orion('POST', `/cards/${sca.id}/release`, {
      worktree: '/home/dev/payments-web-sca',
      reason: 'done',
      to: 'in_review',
    }),
  );
  await must(
    human('POST', `/cards/${sca.id}/comments`, {
      text: 'The challenge screen does not match the design. Please check the spacing and the cancel button.',
    }),
  );

  // Claimed and unread at once; reopened and unread at once.
  const ledger = await card('acme/payments-api', 'Ledger export to CSV', 'ledger-csv', 'ready');
  await claim(nova, 'acme/payments-api', ledger.id, 'feat/ledger-csv', '/home/dev/payments-api-ledger');
  await must(human('POST', `/cards/${ledger.id}/comments`, { text: 'Include the settlement date column.' }));
  const audit = await card('acme/payments-api', 'Audit log retention', 'audit-retention', 'ready');
  await claim(orion, 'acme/payments-api', audit.id, 'feat/audit-retention', '/home/dev/payments-api-audit');
  await must(
    orion('POST', `/cards/${audit.id}/release`, {
      worktree: '/home/dev/payments-api-audit',
      reason: 'done',
      to: 'in_review',
    }),
  );
  await must(human('POST', `/cards/${audit.id}/move`, { to: 'backlog' }));
  await must(
    human('POST', `/cards/${audit.id}/comments`, { text: 'Retention must be configurable per account, not global.' }),
  );

  // Plain cards in every column.
  await card('acme/payments-api', 'Document the error codes', 'error-codes', 'backlog');
  await card('acme/payments-web', 'Dark mode for the dashboard', 'dark-mode', 'backlog');
  await card('acme/payments-api', 'Rate limit the public API', 'rate-limit', 'ready');
  await card(
    'acme/payments-web',
    'Remove the legacy checkout',
    'legacy-checkout',
    'blocked',
    'Waiting on the migration of the last merchants.',
  );
  const done = await card('acme/payments-api', 'Upgrade to Node 22', 'node-22', 'in_review');
  await must(human('POST', `/cards/${done.id}/move`, { to: 'done' }));

  // The other projects: one with a stale claim, one calm, one empty.
  shiftBy(-30 * MINUTE);
  const nav = await card('acme/mobile', 'Tab bar redesign', 'tab-bar', 'ready');
  await claim(nova, 'acme/mobile', nav.id, 'feat/tab-bar', '/home/dev/mobile');
  shiftBy(0);
  const push = await card('acme/mobile', 'Push notification opt-in', 'push-opt-in', 'ready');
  await claim(orion, 'acme/mobile', push.id, 'feat/push', '/home/dev/mobile-push');
  await card('acme/docs', 'Getting started guide', 'getting-started', 'backlog');
  const search = await card('acme/docs', 'Search across versions', 'search', 'ready');
  await claim(nova, 'acme/docs', search.id, 'feat/search', '/home/dev/docs');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const port = Number(opt('port') ?? 5173);
  const web = resolve(opt('web') ?? 'packages/cdk/assets/web');
  const credentials = { accessKeyId: 'local', secretAccessKey: 'local' };
  const region = 'us-west-2';
  const external = opt('ddb');
  const running = external ? undefined : await startDynamoDbLocal();
  const endpoint = external ?? running?.endpoint;
  if (!endpoint) throw new Error('No DynamoDB endpoint: pass --ddb, or install Java 17 or later for DynamoDB Local.');
  const table = `baton-dev-${randomBytes(4).toString('hex')}`;
  await createTable({ endpoint, region, credentials }, table);
  const clock = makeShiftClock();
  const deps: Deps = {
    db: createDocClient({ endpoint, region, credentials }),
    config: { table, leaseMs: 10 * MINUTE, heartbeatSeconds: 60 },
    now: clock.now,
  };
  const server = await startLocalServer({ deps, port, webRoot: web });
  const send =
    (headers: Record<string, string>, prefix: string): Call =>
    async (method, path, body) => {
      const response = await fetch(`${server.url}/api/${prefix}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
  if (args.includes('--seed')) {
    await seedDemo(send({}, 'human'), (token) => send({ authorization: `Bearer ${token}` }, 'agent'), clock.shiftBy);
  }
  console.log(`READY ${server.url}`);
  const stop = async () => {
    await server.close();
    running?.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

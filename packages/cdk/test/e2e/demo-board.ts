// A seeded board behind the local server, for the browser tests and the README screenshots: the same router, DynamoDB Local
// and built web app `pnpm dev --seed` serves.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { makeShiftClock, seedDemo } from '../../../../scripts/dev-server.ts';
import { configFor } from '../../service/config.ts';
import { createDocClient } from '../../service/store.ts';
import { startLocalServer, type LocalServer } from '../support/local-server.ts';
import { createTable } from '../support/table.ts';

export const WEB_ROOT = join(import.meta.dirname, '../../assets/web');

export async function demoBoard(endpoint: string): Promise<LocalServer> {
  const credentials = { accessKeyId: 'local', secretAccessKey: 'local' };
  const region = 'us-west-2';
  const table = `baton-e2e-${randomBytes(4).toString('hex')}`;
  await createTable({ endpoint, region, credentials }, table);
  const clock = makeShiftClock();
  const server = await startLocalServer({
    deps: { db: createDocClient({ endpoint, region, credentials }), config: configFor(table), now: clock.now },
    port: 0,
    webRoot: WEB_ROOT,
  });
  const send =
    (headers: Record<string, string>, prefix: string) => async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${server.url}/api/${prefix}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json: any = await response.json();
      return { status: response.status, body: json };
    };
  await seedDemo(send({}, 'human'), (token) => send({ authorization: `Bearer ${token}` }, 'agent'), clock.shiftBy);
  return server;
}
